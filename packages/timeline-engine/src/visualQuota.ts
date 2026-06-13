/**
 * Positional shot sequencer: decide image vs. video-clip per shot from its
 * position on the timeline, not from a flat global ratio.
 *
 * `image_with_motion` shots route to `69labs.image` (single still + Ken Burns).
 * `cinematic_video` and `atmospheric_broll` shots route to a video model
 * (Veo 3 or `69labs.video`).
 *
 * Three regimes, split by elapsed narration time:
 *
 *   • First 20 min  — pattern `clip → clip → image` (period 3, image every 3rd
 *     shot). Motion-forward; an image never lands next to another image.
 *
 *   • 20–30 min     — pattern `clip → image → image` (period 3, two images then
 *     a clip). Images are more frequent to cut motion fatigue on long runs;
 *     the clip acts as a "motion anchor" and there are never more than two
 *     consecutive images.
 *
 *   • After 30 min  — images only. Every shot routes to image_with_motion (no
 *     video clips), so long-form tails are cheap, still and restful.
 *
 * Section membership is by a shot's START time (cumulative duration of the
 * shots before it). The 3-shot cycle restarts the moment we cross a boundary,
 * so the first shot of each section is always a clip (until images-only) and
 * the patterns stay clean across the seams. Shots MUST be passed in timeline
 * order.
 */
import type { VisualType } from '@emberforge/core';

// Boundary between the early (C C I) and late (C I I) sequencing regimes, in
// elapsed seconds. Default 20 min; override via env for shorter/longer content.
const SECTION_BOUNDARY_S = Number(process.env.SHOT_SECTION_BOUNDARY_S ?? 20 * 60);

// After this elapsed time, every shot is an image (no video clips). Default 30
// min; override via env. Should be >= SECTION_BOUNDARY_S to keep the regimes in
// order (early → late → images-only).
const IMAGES_ONLY_AFTER_S = Number(process.env.SHOT_IMAGES_ONLY_AFTER_S ?? 30 * 60);

const IMAGE_TYPE: VisualType = 'image_with_motion';
const FALLBACK_VIDEO_TYPE: VisualType = 'atmospheric_broll';

const DEFAULT_IMAGE_RATIO = 0.2;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_IMAGE_RATIO;
  return Math.max(0, Math.min(1, n));
}

// Retained for telemetry/back-compat only. The positional sequencer no longer
// targets a single ratio (the early section is ~1/3 images, the late section
// ~2/3), but the segment/classify stages still emit this as `imageRatioTarget`.
export const TARGET_IMAGE_RATIO = clamp01(Number(process.env.IMAGE_RATIO ?? DEFAULT_IMAGE_RATIO));

function durationOf(shot: { durationS: string | number }): number {
  const n = typeof shot.durationS === 'number' ? shot.durationS : Number(shot.durationS);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function assignType<T extends { visualType: VisualType; showsPeople?: boolean }>(shot: T, isImage: boolean): T {
  if (isImage) {
    // image_with_motion renders people fine — safe for any subject.
    return shot.visualType === IMAGE_TYPE ? shot : { ...shot, visualType: IMAGE_TYPE };
  }
  // Clip slot. A shot that shows people must NOT become atmospheric_broll: that
  // builder injects "no people" and would strip the subject out. Route it to the
  // people-safe cinematic_video path instead (history/biography backbone).
  if (shot.showsPeople) {
    return shot.visualType === 'cinematic_video' ? shot : { ...shot, visualType: 'cinematic_video' };
  }
  // People-free clip slot: preserve an explicit hero-video pick, otherwise
  // normalize to cheap atmospheric b-roll.
  if (shot.visualType === 'cinematic_video' || shot.visualType === 'atmospheric_broll') {
    return shot;
  }
  return { ...shot, visualType: FALLBACK_VIDEO_TYPE };
}

/**
 * Assign each shot's visual type by its timeline position. Input MUST be in
 * timeline order; output preserves that order 1:1.
 */
export function applyVisualQuota<T extends { visualType: VisualType; durationS: string | number; showsPeople?: boolean }>(
  shots: T[],
): T[] {
  if (shots.length === 0) return shots;

  let elapsedS = 0;
  let section = 0; // 0 = early (C C I), 1 = late (C I I), 2 = images-only
  let phase = 0; // position within the current section's 3-shot cycle

  return shots.map((shot) => {
    // Promote the section on the first shot whose start time crosses a boundary,
    // restarting the cycle so that shot is a clip (motion anchor) in the early/
    // late regimes. Check images-only first so a single shot can't skip it when
    // both boundaries fall within one slot. Late takes effect at/after 20 min;
    // images-only at/after 30 min.
    if (section < 2 && elapsedS >= IMAGES_ONLY_AFTER_S) {
      section = 2;
      phase = 0;
    } else if (section < 1 && elapsedS >= SECTION_BOUNDARY_S) {
      section = 1;
      phase = 0;
    }

    // Early: image only on phase 2 (C C I). Late: images on phases 1 and 2
    // (C I I) — at most two in a row, always broken by the phase-0 clip.
    // Images-only: every shot is an image.
    const isImage = section === 2 ? true : section === 1 ? phase === 1 || phase === 2 : phase === 2;

    phase = (phase + 1) % 3;
    elapsedS += durationOf(shot);

    return assignType(shot, isImage);
  });
}

export function quotaCounts<T extends { visualType: VisualType }>(
  shots: T[],
): { image: number; video: number; total: number } {
  let image = 0;
  let video = 0;
  for (const s of shots) {
    if (s.visualType === IMAGE_TYPE) image++;
    else video++;
  }
  return { image, video, total: shots.length };
}
