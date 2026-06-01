import type { Shot, StylePresetId } from '@emberforge/core';
import { getPalette } from '../stylePalette.js';
import { CAMERA_DESCRIPTION, LENS_DESCRIPTION } from '../lensVocab.js';
import { recallMemory } from '../visualMemory.js';

export async function buildVeo3Prompt(opts: {
  shot: Shot;
  projectId: string;
  stylePreset: StylePresetId;
}): Promise<{ prompt: string; negative: string }> {
  const palette = getPalette(opts.stylePreset);
  const memory = await recallMemory(opts.projectId, opts.shot);

  const parts: string[] = [
    opts.shot.visualSummary,
    memory && `featuring ${memory}`,
    LENS_DESCRIPTION[opts.shot.lens],
    CAMERA_DESCRIPTION[opts.shot.cameraMovement],
    palette.ambient,
    palette.lighting,
    `${palette.grade} color grade`,
    'photoreal, hyperdetailed, shallow depth of field, cinematic composition, 8K source quality',
    'clean full-frame edge-to-edge composition, no on-screen text or captions, no watermark or logo, no camera UI or HUD, no REC indicator, no timestamp, no viewfinder or focus reticle, no film border or letterbox bars',
  ].filter((x): x is string => Boolean(x));

  return {
    prompt: parts.join(', '),
    negative: palette.negative,
  };
}
