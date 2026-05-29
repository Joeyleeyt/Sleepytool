import { z } from 'zod';
import { eventsRepo, projectsRepo, scenesRepo, shotsRepo } from '@emberforge/db';
import { structured } from '@emberforge/ai-clients';
import { CLASSIFY_SYSTEM } from '@emberforge/prompt-engine';
import { ShotDraftSchema } from '@emberforge/core/schemas';
import { applyVisualQuota, quotaCounts, TARGET_IMAGE_RATIO } from '@emberforge/timeline-engine';

const ShotListSchema = z.object({ shots: z.array(ShotDraftSchema) });

// Only these visual types have wired-up workers in safe-mode. Any other type
// the LLM emits is downgraded to atmospheric_broll so the pipeline never hangs.
const SUPPORTED_VISUAL_TYPES = new Set(['cinematic_video', 'image_with_motion', 'atmospheric_broll']);

export async function classifyStage(projectId: string) {
  await eventsRepo.emit(projectId, 'classify', 'started');
  const scenes = await scenesRepo.findByProject(projectId);
  if (scenes.length === 0) throw new Error('no scenes to classify');

  // Buffer all shots across scenes so the quota is enforced globally
  // (per-scene rebalancing would lose precision on short scenes).
  type Drafted = Parameters<typeof shotsRepo.bulkInsert>[0][number];
  const drafted: Drafted[] = [];

  for (const scene of scenes) {
    const result = await structured({
      model: 'haiku',
      system: CLASSIFY_SYSTEM,
      user: JSON.stringify({
        scene: {
          title: scene.title,
          analysis: scene.analysis,
          narrationChunk: scene.narrationChunk,
        },
      }),
      schema: ShotListSchema,
      maxTokens: 8_000,
      cacheSystem: true,
    });

    for (const s of result.shots) {
      drafted.push({
        sceneId: scene.id,
        projectId,
        ordinal: s.ordinal,
        narrationText: s.narrationText,
        durationS: String(s.durationS),
        visualType: SUPPORTED_VISUAL_TYPES.has(s.visualType) ? s.visualType : 'atmospheric_broll',
        visualSummary: s.visualSummary,
        cameraMovement: s.cameraMovement,
        lens: s.lens,
        fxRecommendation: s.fxRecommendation,
        transitionIn: s.transitionIn,
        transitionOut: s.transitionOut,
        soundtrackMood: s.soundtrackMood,
      });
    }
  }

  const rebalanced = applyVisualQuota(drafted);
  const counts = quotaCounts(rebalanced);

  // Re-group by scene and insert in scene order
  const bySceneId = new Map<string, Drafted[]>();
  for (const row of rebalanced) {
    const arr = bySceneId.get(row.sceneId) ?? [];
    arr.push(row);
    bySceneId.set(row.sceneId, arr);
  }
  for (const scene of scenes) {
    const rows = bySceneId.get(scene.id);
    if (!rows || !rows.length) continue;
    // Reassign ordinals sequentially per scene to satisfy the
    // shots_scene_ordinal_uq unique index even if the LLM emitted
    // duplicate or non-sequential values within a scene.
    rows.forEach((row, i) => { row.ordinal = i; });
    await shotsRepo.bulkInsert(rows);
  }

  await projectsRepo.setStatus(projectId, 'classified');
  await eventsRepo.emit(projectId, 'classify', 'succeeded', {
    shots: counts.total,
    imageShots: counts.image,
    videoShots: counts.video,
    imageRatioTarget: TARGET_IMAGE_RATIO,
    imageRatioActual: counts.total ? counts.image / counts.total : 0,
  });
  return { shots: counts.total, ...counts };
}
