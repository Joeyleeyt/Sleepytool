import { eventsRepo, projectsRepo, scenesRepo, transcriptsRepo } from '@emberforge/db';
import { structured } from '@emberforge/ai-clients';
import { SEGMENT_SYSTEM } from '@emberforge/prompt-engine';
import { SceneListSchema } from '@emberforge/core/schemas';

export async function segmentStage(projectId: string) {
  const started = Date.now();
  // eslint-disable-next-line no-console
  console.log(`[segment] start projectId=${projectId}`);
  await eventsRepo.emit(projectId, 'segment', 'started');

  const transcript = await transcriptsRepo.findByProject(projectId);
  if (!transcript || !transcript.analysisJson) throw new Error('analysis required before segmentation');

  // Always slice the raw transcript so the spoken TTS audio matches the
  // operator's original wording verbatim. The `narrate` stage still runs and
  // writes `transcripts.narrationText` for /script preview purposes, but
  // segmentation deliberately ignores it — downstream classify/prompt/TTS
  // should never speak the rewritten text.
  const sourceText = transcript.rawText;
  // eslint-disable-next-line no-console
  console.log(`[segment] source=rawText len=${sourceText.length}ch analysisJson=present`);

  const existing = await scenesRepo.findByProject(projectId);
  if (existing.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`[segment] cached scenes=${existing.length} — skipping LLM call`);
    await eventsRepo.emit(projectId, 'segment', 'cached', { scenes: existing.length });
    await projectsRepo.setStatus(projectId, 'segmented');
    return { cached: true, scenes: existing.length };
  }

  const result = await structured({
    model: 'opus',
    system: SEGMENT_SYSTEM,
    user: JSON.stringify({
      analysis: transcript.analysisJson,
      transcript: sourceText,
    }),
    schema: SceneListSchema,
    // 12k fits gpt-4o's 16,384 output cap with headroom; covers ~25 SceneDraft
    // entries (Claude can go higher, but the OpenAI client clamps to 16,384
    // anyway — see openai.ts. Picking 12k here means both providers behave the
    // same and a finish_reason='length' is a real schema problem, not a cap.)
    maxTokens: 12_000,
    cacheSystem: true,
  });
  // eslint-disable-next-line no-console
  console.log(`[segment] LLM ok scenes=${result.scenes.length}`);

  await scenesRepo.bulkInsert(
    result.scenes.map((s) => ({
      projectId,
      ordinal: s.ordinal,
      title: s.title,
      narrationChunk: s.narrationChunk,
      emotion: s.analysis.emotion,
      pacing: s.analysis.pacing,
      atmosphere: s.analysis.atmosphere,
      topic: s.analysis.topic,
      analysis: s.analysis,
      startWordIdx: s.startWordIdx,
      endWordIdx: s.endWordIdx,
      estimatedDurS: String(s.estimatedDurationS),
    })),
  );

  await projectsRepo.setStatus(projectId, 'segmented');
  await eventsRepo.emit(projectId, 'segment', 'succeeded', { scenes: result.scenes.length });
  // eslint-disable-next-line no-console
  console.log(`[segment] done projectId=${projectId} scenes=${result.scenes.length} ${Date.now() - started}ms`);
  return { scenes: result.scenes.length };
}
