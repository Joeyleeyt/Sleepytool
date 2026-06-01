import type { Shot, StylePresetId } from '@emberforge/core';
import { getPalette } from '../stylePalette.js';

/**
 * Lower-cost path: atmospheric b-roll via 69labs. Used for "breathing room"
 * shots where literal visual fidelity matters less than mood.
 */
export function buildAtmosphericPrompt(opts: {
  shot: Shot;
  stylePreset: StylePresetId;
}): { prompt: string; negative: string } {
  const palette = getPalette(opts.stylePreset);
  const prompt = [
    opts.shot.visualSummary || 'atmospheric environmental footage',
    'slow drifting camera, no people, abstract textural motion',
    palette.ambient,
    palette.lighting,
    `${palette.grade} color grade`,
    'cinematic, premium documentary feel',
    'clean full-frame edge-to-edge composition, no on-screen text or captions, no watermark or logo, no camera UI or HUD, no REC indicator, no timestamp, no viewfinder or focus reticle, no film border or letterbox bars',
  ].join(', ');
  return { prompt, negative: palette.negative };
}
