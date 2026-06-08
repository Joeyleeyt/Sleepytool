import type { Shot, StylePresetId } from '@emberforge/core';
import { getPalette } from '../stylePalette.js';
import { FULL_FRAME_GUARD } from '../frameGuard.js';
import { LENS_DESCRIPTION } from '../lensVocab.js';
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

  const parts = [
    opts.shot.visualSummary,
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
    negative: [palette.negative, opts.extraNegative].filter(Boolean).join(', '),
  };
}
