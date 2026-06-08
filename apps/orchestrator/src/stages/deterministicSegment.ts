/**
 * Labs-only / no-LLM mode. Replaces the Claude-driven analyze + segment +
 * classify stages with deterministic rule-based logic, tuned for SLEEP docs:
 *   - one scene per ~120s window of narration
 *   - ~10s "visual blocks" (multiple sentences share one held visual)
 *   - CALM rotating camera moves only (slow drift / push / orbit; no handheld)
 *   - simple visualSummary derived from the narration itself
 *
 * Visual type assignment runs through applyVisualQuota — the positional
 * sequencer (clip/clip/still for the first 20 min, clip/still/still after). The
 * sleep renderer freeze-pads any video clip shorter than its ~10s slot, so the
 * clip/still mix stays in A/V sync.
 */
import { eventsRepo, projectsRepo, scenesRepo, shotsRepo, transcriptsRepo } from '@emberforge/db';
import { applyVisualQuota, packByVisualBlock, quotaCounts, TARGET_IMAGE_RATIO } from '@emberforge/timeline-engine';
import type { CameraMove, LensProfile, TransitionType, VisualType } from '@emberforge/core';

const DEFAULT_VISUAL_TYPE: VisualType =
  (process.env.DEFAULT_VISUAL_TYPE as VisualType | undefined) ?? 'image_with_motion';
const SCENE_TARGET_S = Number(process.env.SCENE_TARGET_S ?? 120);
// Sleep pacing: ~10s visual blocks. Stills hold any duration safely; if you
// route video shots here, keep MAX at/under the video model's clip length.
const SHOT_MIN_S = Number(process.env.SHOT_MIN_S ?? 8);
const SHOT_MAX_S = Number(process.env.SHOT_MAX_S ?? 12);
const SHOT_TARGET_S = Number(process.env.SHOT_TARGET_S ?? 10);

// Calm-only moves. Slow drift (ken_burns), gentle push/pull (dolly), slow orbit,
// and held static. NO handheld_drift / crane / whip / aerial / macro.
const CAMERA_ROTATION: CameraMove[] = [
  'ken_burns_in',
  'static',
  'dolly_in',
  'ken_burns_out',
  'orbit_left',
  'dolly_out',
  'orbit_right',
];

const LENS_ROTATION: LensProfile[] = [
  '50mm_natural',
  '85mm_portrait',
  '35mm_anamorphic',
  '135mm_tele',
];

// Soothing dissolves only — never a hard cut.
const TRANSITIONS: TransitionType[] = ['crossfade', 'dip_to_black', 'crossfade'];

const MOOD_ROTATION = [
  'ambient_drone',
  'deep_low_hum',
  'soft_pad_swell',
  'near_silence',
];

function pickRotating<T>(arr: T[], i: number): T {
  return arr[i % arr.length]!;
}

function summarize(narration: string, max = 140): string {
  const clean = narration.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1).replace(/[,;:.]?\s+\S*$/, '') + '…';
}

export async function deterministicSegmentStage(projectId: string) {
  await eventsRepo.emit(projectId, 'deterministic_segment', 'started');

  const transcript = await transcriptsRepo.findByProject(projectId);
  if (!transcript) throw new Error('transcript not found');

  const existingScenes = await scenesRepo.findByProject(projectId);
  if (existingScenes.length > 0) {
    await eventsRepo.emit(projectId, 'deterministic_segment', 'cached', { scenes: existingScenes.length });
    await projectsRepo.setStatus(projectId, 'classified');
    return { cached: true, scenes: existingScenes.length };
  }

  // Pack the whole transcript into ~10s visual blocks (multiple sentences per
  // held visual) instead of per-sentence ~5s clips.
  const allShots = packByVisualBlock(transcript.rawText, {
    minS: SHOT_MIN_S,
    maxS: SHOT_MAX_S,
    targetS: SHOT_TARGET_S,
  });
  if (allShots.length === 0) throw new Error('transcript produced zero shots');

  // Group shots into scenes by accumulated duration (~SCENE_TARGET_S each)
  type Bucket = { ordinal: number; shots: typeof allShots; durationS: number };
  const scenes: Bucket[] = [];
  let current: Bucket = { ordinal: 0, shots: [], durationS: 0 };
  for (const shot of allShots) {
    if (current.durationS >= SCENE_TARGET_S && current.shots.length > 0) {
      scenes.push(current);
      current = { ordinal: scenes.length, shots: [], durationS: 0 };
    }
    current.shots.push(shot);
    current.durationS += shot.durationS;
  }
  if (current.shots.length > 0) scenes.push(current);

  // Insert scenes
  const inserted = await scenesRepo.bulkInsert(
    scenes.map((b) => ({
      projectId,
      ordinal: b.ordinal,
      title: `Scene ${b.ordinal + 1}`,
      narrationChunk: b.shots.map((s) => s.text).join(' '),
      emotion: 'contemplative',
      pacing: 'slow',
      atmosphere: 'calm, dark, low-stimulation atmospheric',
      topic: 'narration',
      analysis: {
        topic: 'narration',
        emotion: 'contemplative',
        pacing: 'slow',
        tension: 0.2,
        atmosphere: 'calm, dark, low-stimulation atmospheric',
        visualOpportunities: [],
        concepts: { scientific: [], abstract: [] },
      },
      estimatedDurS: String(b.durationS),
    })),
  );

  // Build a flat shot list across the whole project, then enforce the
  // image/video quota globally before grouping per scene for insert.
  type ShotRow = Parameters<typeof shotsRepo.bulkInsert>[0][number];
  const flat: ShotRow[] = [];
  let globalShotIdx = 0;
  for (let sceneIdx = 0; sceneIdx < scenes.length; sceneIdx++) {
    const sceneRow = inserted[sceneIdx]!;
    const bucketShots = scenes[sceneIdx]!.shots;

    for (let localOrdinal = 0; localOrdinal < bucketShots.length; localOrdinal++) {
      const s = bucketShots[localOrdinal]!;
      const camera = pickRotating(CAMERA_ROTATION, globalShotIdx);
      const lens = pickRotating(LENS_ROTATION, Math.floor(globalShotIdx / 2));
      const transitionIn = pickRotating(TRANSITIONS, globalShotIdx);
      const transitionOut = pickRotating(TRANSITIONS, globalShotIdx + 1);
      const mood = pickRotating(MOOD_ROTATION, Math.floor(globalShotIdx / 6));
      globalShotIdx += 1;

      flat.push({
        sceneId: sceneRow.id,
        projectId,
        ordinal: localOrdinal,
        narrationText: s.text,
        durationS: String(s.durationS),
        visualType: DEFAULT_VISUAL_TYPE,
        visualSummary: summarize(s.text),
        cameraMovement: camera,
        lens,
        fxRecommendation: {
          embers: 'off',
          smoke: 'off',
          filmGrain: 0.08,
          glow: 'off',
          vignette: 0.4,
        },
        transitionIn,
        transitionOut,
        soundtrackMood: mood,
      });
    }
  }

  const rebalanced = applyVisualQuota(flat);
  const counts = quotaCounts(rebalanced);

  // Group back by scene and insert
  const bySceneId = new Map<string, ShotRow[]>();
  for (const row of rebalanced) {
    const arr = bySceneId.get(row.sceneId) ?? [];
    arr.push(row);
    bySceneId.set(row.sceneId, arr);
  }
  for (const sceneRow of inserted) {
    const rows = bySceneId.get(sceneRow.id);
    if (rows && rows.length) await shotsRepo.bulkInsert(rows);
  }

  await projectsRepo.setStatus(projectId, 'classified');
  await eventsRepo.emit(projectId, 'deterministic_segment', 'succeeded', {
    scenes: scenes.length,
    shots: counts.total,
    imageShots: counts.image,
    videoShots: counts.video,
    imageRatioTarget: TARGET_IMAGE_RATIO,
    imageRatioActual: counts.total ? counts.image / counts.total : 0,
  });
  return { scenes: scenes.length, shots: counts.total, ...counts };
}
