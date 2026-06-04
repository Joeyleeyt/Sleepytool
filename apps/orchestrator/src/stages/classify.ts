import { z } from 'zod';
import { eventsRepo, projectsRepo, scenesRepo, shotsRepo } from '@emberforge/db';
import { structured } from '@emberforge/ai-clients';
import { CLASSIFY_SYSTEM } from '@emberforge/prompt-engine';
import { FxSpecSchema } from '@emberforge/core/schemas';
import { CAMERA_MOVES, LENS_PROFILES, TRANSITIONS, VISUAL_TYPES } from '@emberforge/core';
import { applyVisualQuota, packBySentence, quotaCounts, TARGET_IMAGE_RATIO } from '@emberforge/timeline-engine';

// Visuals-only contract: shot boundaries are now decided deterministically by
// sentence (see packBySentence), so the LLM no longer splits the narration —
// it only assigns the cinematic treatment for each pre-cut chunk, in order.
const ShotVisualSchema = z.object({
  visualType: z.enum(VISUAL_TYPES),
  visualSummary: z.string(),
  cameraMovement: z.enum(CAMERA_MOVES),
  lens: z.enum(LENS_PROFILES),
  fxRecommendation: FxSpecSchema,
  transitionIn: z.enum(TRANSITIONS),
  transitionOut: z.enum(TRANSITIONS),
  soundtrackMood: z.string(),
});
const ShotVisualListSchema = z.object({ shots: z.array(ShotVisualSchema) });
type ShotVisual = z.infer<typeof ShotVisualSchema>;

// Minimum narration seconds a shot can stand on alone. A sentence shorter than
// this is merged with the following sentence(s). Mirrors the deterministic
// stage's SHOT_MIN_S so both pacing paths agree on what "too short" means.
const SHOT_MIN_S = Number(process.env.SHOT_MIN_S ?? 3);

// Only these visual types have wired-up workers in safe-mode. Any other type
// the LLM emits is downgraded to atmospheric_broll so the pipeline never hangs.
const SUPPORTED_VISUAL_TYPES = new Set(['cinematic_video', 'image_with_motion', 'atmospheric_broll']);

// Deterministic treatment used only when the LLM returns fewer visuals than
// there are chunks (or fails entirely). Rotates the camera so consecutive
// fallback shots still feel different.
const FALLBACK_CAMERAS = ['ken_burns_in', 'dolly_in', 'orbit_left', 'ken_burns_out'] as const;
function fallbackVisual(i: number, narration: string): ShotVisual {
  return {
    visualType: 'atmospheric_broll',
    visualSummary: summarize(narration),
    cameraMovement: FALLBACK_CAMERAS[i % FALLBACK_CAMERAS.length]!,
    lens: '50mm_natural',
    fxRecommendation: { embers: 'subtle', smoke: 'off', filmGrain: 0.08, glow: 'low', vignette: 0.4 },
    transitionIn: 'cut',
    transitionOut: 'cut',
    soundtrackMood: 'ambient_drone',
  };
}

function summarize(narration: string, max = 140): string {
  const clean = narration.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1).replace(/[,;:.]?\s+\S*$/, '') + '…';
}

export async function classifyStage(projectId: string) {
  const started = Date.now();
  // eslint-disable-next-line no-console
  console.log(`[classify] start projectId=${projectId}`);
  await eventsRepo.emit(projectId, 'classify', 'started');
  const scenes = await scenesRepo.findByProject(projectId);
  if (scenes.length === 0) throw new Error('no scenes to classify');
  // eslint-disable-next-line no-console
  console.log(`[classify] scenes=${scenes.length} — sentence-split + parallel LLM visuals`);

  // Buffer all shots across scenes so the quota is enforced globally
  // (per-scene rebalancing would lose precision on short scenes).
  type Drafted = Parameters<typeof shotsRepo.bulkInsert>[0][number];

  // Scenes are independent until the global applyVisualQuota step — fan out
  // the per-scene LLM calls so wall-clock = slowest single call, not the sum.
  // The downstream quota + per-scene ordinal renumber preserves ordering.
  const perScene = await Promise.all(
    scenes.map(async (scene) => {
      const sceneStart = Date.now();

      // 1) Deterministic, sentence-based shot boundaries. One sentence per
      //    shot; sentences shorter than SHOT_MIN_S are tapped onto the next
      //    so each shot's narration stays meaningful (and clips stay long
      //    enough). This replaces the old LLM "split by meaning" behavior.
      const chunks = packBySentence(scene.narrationChunk, { minS: SHOT_MIN_S });
      if (chunks.length === 0) return [];

      // 2) LLM assigns the cinematic treatment per pre-cut chunk — same visual
      //    decisions as before, it just no longer controls the text split.
      let visuals: ShotVisual[] = [];
      try {
        const result = await structured({
          model: 'haiku',
          system: CLASSIFY_SYSTEM,
          user: JSON.stringify({
            scene: { title: scene.title, analysis: scene.analysis },
            shots: chunks.map((c, i) => ({ ordinal: i, narrationText: c.text })),
          }),
          schema: ShotVisualListSchema,
          maxTokens: 8_000,
          cacheSystem: true,
        });
        visuals = result.shots;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[classify] scene ${scene.ordinal} visual LLM failed: ${(err as Error).message} — using deterministic fallback`,
        );
      }

      // eslint-disable-next-line no-console
      console.log(
        `[classify] scene ${scene.ordinal} ok chunks=${chunks.length} visuals=${visuals.length} ${Date.now() - sceneStart}ms`,
      );

      return chunks.map<Drafted>((c, i) => {
        const v = visuals[i] ?? fallbackVisual(i, c.text);
        return {
          sceneId: scene.id,
          projectId,
          ordinal: i,
          narrationText: c.text,
          durationS: String(c.durationS),
          visualType: SUPPORTED_VISUAL_TYPES.has(v.visualType) ? v.visualType : 'atmospheric_broll',
          visualSummary: v.visualSummary || summarize(c.text),
          cameraMovement: v.cameraMovement,
          lens: v.lens,
          fxRecommendation: v.fxRecommendation,
          transitionIn: v.transitionIn,
          transitionOut: v.transitionOut,
          soundtrackMood: v.soundtrackMood,
        };
      });
    }),
  );
  const drafted: Drafted[] = perScene.flat();

  const rebalanced = applyVisualQuota(drafted);
  const counts = quotaCounts(rebalanced);

  // Re-group by scene so we can renumber ordinals per scene to satisfy the
  // shots_scene_ordinal_uq unique index, then flatten and issue ONE bulk
  // insert instead of N round-trips.
  const bySceneId = new Map<string, Drafted[]>();
  for (const row of rebalanced) {
    const arr = bySceneId.get(row.sceneId) ?? [];
    arr.push(row);
    bySceneId.set(row.sceneId, arr);
  }
  const allRows: Drafted[] = [];
  for (const scene of scenes) {
    const rows = bySceneId.get(scene.id);
    if (!rows || !rows.length) continue;
    rows.forEach((row, i) => { row.ordinal = i; });
    allRows.push(...rows);
  }
  if (allRows.length > 0) await shotsRepo.bulkInsert(allRows);

  await projectsRepo.setStatus(projectId, 'classified');
  await eventsRepo.emit(projectId, 'classify', 'succeeded', {
    shots: counts.total,
    imageShots: counts.image,
    videoShots: counts.video,
    imageRatioTarget: TARGET_IMAGE_RATIO,
    imageRatioActual: counts.total ? counts.image / counts.total : 0,
  });
  // eslint-disable-next-line no-console
  console.log(
    `[classify] done projectId=${projectId} shots=${counts.total} ` +
      `(img=${counts.image} vid=${counts.video}) ${Date.now() - started}ms`,
  );
  return { shots: counts.total, ...counts };
}
