import type { Shot, StylePresetId } from '@emberforge/core';
import { getPalette } from '../stylePalette.js';
import { LENS_DESCRIPTION } from '../lensVocab.js';
import { recallMemory } from '../visualMemory.js';

export async function buildImagePrompt(opts: {
  shot: Shot;
  projectId: string;
  stylePreset: StylePresetId;
}): Promise<{ prompt: string; negative: string }> {
  const palette = getPalette(opts.stylePreset);
  const memory = await recallMemory(opts.projectId, opts.shot);

  const parts = [
    opts.shot.visualSummary,
    memory && `featuring ${memory}`,
    LENS_DESCRIPTION[opts.shot.lens],
    palette.lighting,
    palette.ambient,
    `${palette.grade} color grade`,
    'still frame, photoreal, hyperdetailed, cinematic composition',
    'clean full-frame edge-to-edge composition, no on-screen text or captions, no watermark or logo, no camera UI or HUD, no REC indicator, no timestamp, no viewfinder or focus reticle, no film border or letterbox bars',
  ].filter((x): x is string => Boolean(x));

  return {
    prompt: parts.join(', '),
    negative: palette.negative,
  };
}
