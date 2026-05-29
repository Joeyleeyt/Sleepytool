/**
 * Enforce a fixed image / video clip ratio across a project's shot list.
 *
 * `image_with_motion` shots route to `69labs.image` (single still + Ken Burns).
 * `cinematic_video` and `atmospheric_broll` shots route to a video model
 * (Veo 3 or `69labs.video`).
 *
 * The product target is 20% image / 80% video clip. We pick
 * `round(N * imageRatio)` evenly-distributed slots across the timeline to be
 * image shots — even spacing gives a better pacing rhythm than clumping all
 * the images at the start or end. The remaining slots keep `cinematic_video`
 * when the classifier already assigned it (preserving Claude's hero picks)
 * and otherwise normalize to `atmospheric_broll`.
 */
import type { VisualType } from '@emberforge/core';

const DEFAULT_IMAGE_RATIO = 0.2;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_IMAGE_RATIO;
  return Math.max(0, Math.min(1, n));
}

export const TARGET_IMAGE_RATIO = clamp01(Number(process.env.IMAGE_RATIO ?? DEFAULT_IMAGE_RATIO));

const IMAGE_TYPE: VisualType = 'image_with_motion';
const FALLBACK_VIDEO_TYPE: VisualType = 'atmospheric_broll';

export function applyVisualQuota<T extends { visualType: VisualType }>(
  shots: T[],
  imageRatio: number = TARGET_IMAGE_RATIO,
): T[] {
  if (shots.length === 0) return shots;
  const ratio = clamp01(imageRatio);
  const targetImages = Math.round(shots.length * ratio);
  const imageSlots = new Set(pickEvenIndices(shots.length, targetImages));

  return shots.map((shot, idx) => {
    if (imageSlots.has(idx)) {
      return shot.visualType === IMAGE_TYPE ? shot : { ...shot, visualType: IMAGE_TYPE };
    }
    if (shot.visualType === 'cinematic_video' || shot.visualType === 'atmospheric_broll') {
      return shot;
    }
    return { ...shot, visualType: FALLBACK_VIDEO_TYPE };
  });
}

/** Pick `count` evenly-spaced integer indices in [0, total). */
function pickEvenIndices(total: number, count: number): number[] {
  if (count <= 0) return [];
  if (count >= total) return Array.from({ length: total }, (_, i) => i);
  const step = total / count;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(Math.floor(i * step + step / 2));
  }
  return out;
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
