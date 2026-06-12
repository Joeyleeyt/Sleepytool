import type { Shot, StylePresetId } from '@emberforge/core';
import { getPalette } from '../stylePalette.js';
import { FULL_FRAME_GUARD } from '../frameGuard.js';
import { LENS_DESCRIPTION } from '../lensVocab.js';
import { STILL_MOTION, MOTION_NEGATIVE } from '../motionMode.js';
import { recallMemory } from '../visualMemory.js';

export async function buildImagePrompt(opts: {
  shot: Shot;
  projectId: string;
  stylePreset: StylePresetId;
  anchor?: string;
  extraNegative?: string | null;
}): Promise<{ prompt: string; negative: string }> {
  const palette = getPalette(opts.stylePreset);
  const memory = await recallMemory(opts.projectId, opts.shot);

  // Lead with the shot's own transcript-derived subject so it carries the most
  // weight, then the stillness directive.
  const parts = [
    opts.shot.visualSummary,
    STILL_MOTION,
    memory && `featuring ${memory}`,
    opts.anchor,
    LENS_DESCRIPTION[opts.shot.lens],
    palette.lighting,
    palette.ambient,
    `${palette.grade} color grade`,
    'still frame, photoreal, hyperdetailed, cinematic composition',
    FULL_FRAME_GUARD,
  ].filter((x): x is string => Boolean(x));

  return {
    prompt: parts.join(', '),
    negative: [palette.negative, opts.extraNegative, MOTION_NEGATIVE].filter(Boolean).join(', '),
  };
}
