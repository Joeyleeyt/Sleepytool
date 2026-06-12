import { z } from 'zod';
import { eventsRepo, projectsRepo, scenesRepo, transcriptsRepo } from '@emberforge/db';
import { structured } from '@emberforge/ai-clients';
import { SEGMENT_SYSTEM } from '@emberforge/prompt-engine';
import { SceneAnalysisSchema } from '@emberforge/core/schemas';
import { packByScene } from '@emberforge/timeline-engine';

// Scene-length knobs (seconds). Scenes are cut DETERMINISTICALLY in JS by
// packByScene, NOT by the LLM — so this stage is length-agnostic and a 2-hour
// (or longer) transcript segments without overflowing any model output cap.
// TARGET is the ideal scene length, MAX the ceiling, MIN the floor below which a
// trailing remainder folds into the previous scene.
const SCENE_TARGET_S = Number(process.env.SCENE_TARGET_S ?? 240);
const SCENE_MAX_S = Number(process.env.SCENE_MAX_S ?? 300);
const SCENE_MIN_S = Number(process.env.SCENE_MIN_S ?? 120);

// The LLM only ANNOTATES a pre-cut scene; it never sees or echoes the whole
// transcript, so its output is tiny and constant regardless of total length.
const SceneAnnotationSchema = z.object({
  title: z.string(),
  analysis: SceneAnalysisSchema,
});
type SceneAnnotation = z.infer<typeof SceneAnnotationSchema>;

// Deterministic annotation used when the LLM call for a scene fails — derived
// from the global analysis so the scene still carries a sensible, in-world tone.
function fallbackAnnotation(ordinal: number, globalTopic: string, toneSummary: string): SceneAnnotation {
  const atmosphere = (toneSummary || globalTopic || 'dark, calm, low-stimulation').trim();
  return {
    title: `Scene ${ordinal + 1}`,
    analysis: {
      topic: globalTopic || 'calm ambient scene',
      emotion: 'contemplative',
      pacing: 'slow',
      tension: 0.2,
      atmosphere,
      visualOpportunities: [],
      concepts: { scientific: [], abstract: [] },
    },
  };
}

export async function segmentStage(projectId: string) {
  const started = Date.now();
  // eslint-disable-next-line no-console
  console.log(`[segment] start projectId=${projectId}`);
  await eventsRepo.emit(projectId, 'segment', 'started');

  const transcript = await transcriptsRepo.findByProject(projectId);
  if (!transcript || !transcript.analysisJson) throw new Error('analysis required before segmentation');

  // Always slice the raw transcript so the spoken TTS audio matches the
  // operator's original wording. The `narrate` stage still writes
  // `transcripts.narrationText` for /script preview, but segmentation
  // deliberately ignores it — downstream classify/prompt/TTS speak rawText.
  const sourceText = transcript.rawText;

  const existing = await scenesRepo.findByProject(projectId);
  if (existing.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`[segment] cached scenes=${existing.length} — skipping`);
    await eventsRepo.emit(projectId, 'segment', 'cached', { scenes: existing.length });
    await projectsRepo.setStatus(projectId, 'segmented');
    return { cached: true, scenes: existing.length };
  }

  // 1) DETERMINISTIC scene boundaries — pure JS, no LLM, no length limit.
  const chunks = packByScene(sourceText, {
    minS: SCENE_MIN_S,
    maxS: SCENE_MAX_S,
    targetS: SCENE_TARGET_S,
  });
  if (chunks.length === 0) throw new Error('segment produced no scenes (empty transcript?)');

  // Global analysis (from the analyze stage) gives the per-scene annotator the
  // film's overall world + tone, and seeds the deterministic fallback.
  const analysis = (transcript.analysisJson ?? {}) as { globalTopic?: string; toneSummary?: string };
  const globalTopic = (analysis.globalTopic ?? '').trim();
  const toneSummary = (analysis.toneSummary ?? '').trim();

  // eslint-disable-next-line no-console
  console.log(
    `[segment] source=${sourceText.length}ch scenes=${chunks.length} ` +
      `(target=${SCENE_TARGET_S}s) — per-scene annotate`,
  );

  // 2) Annotate each (small) scene in parallel — wall-clock = slowest call, and
  //    no single call can overflow because it only sees one scene's chunk.
  const annotations = await Promise.all(
    chunks.map(async (chunk, ordinal): Promise<SceneAnnotation> => {
      try {
        return await structured({
          model: 'haiku',
          system: SEGMENT_SYSTEM,
          user: JSON.stringify({
            global: { globalTopic, toneSummary },
            scene: { ordinal, narrationChunk: chunk.text },
          }),
          schema: SceneAnnotationSchema,
          maxTokens: 2_000,
          cacheSystem: true,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[segment] scene ${ordinal} annotate failed: ${(err as Error).message} — using fallback`,
        );
        return fallbackAnnotation(ordinal, globalTopic, toneSummary);
      }
    }),
  );

  // 3) Persist: scene TEXT comes from the JS slice (verbatim), the rest from the
  //    annotation. estimatedDurationS / word indices are computed, not guessed.
  await scenesRepo.bulkInsert(
    chunks.map((chunk, ordinal) => {
      const a = annotations[ordinal]!;
      return {
        projectId,
        ordinal,
        title: a.title,
        narrationChunk: chunk.text,
        emotion: a.analysis.emotion,
        pacing: a.analysis.pacing,
        atmosphere: a.analysis.atmosphere,
        topic: a.analysis.topic,
        analysis: a.analysis,
        startWordIdx: chunk.startWordIdx,
        endWordIdx: chunk.endWordIdx,
        estimatedDurS: String(chunk.durationS),
      };
    }),
  );

  await projectsRepo.setStatus(projectId, 'segmented');
  await eventsRepo.emit(projectId, 'segment', 'succeeded', { scenes: chunks.length });
  // eslint-disable-next-line no-console
  console.log(`[segment] done projectId=${projectId} scenes=${chunks.length} ${Date.now() - started}ms`);
  return { scenes: chunks.length };
}
