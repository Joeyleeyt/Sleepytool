import type { Shot, StylePresetId } from '@emberforge/core';
import { getPalette } from '../stylePalette.js';
import { FULL_FRAME_GUARD } from '../frameGuard.js';
import { CAMERA_DESCRIPTION, LENS_DESCRIPTION } from '../lensVocab.js';
import { motionLead, motionDirective, MOTION_NEGATIVE } from '../motionMode.js';
import { recallMemory } from '../visualMemory.js';

export async function buildVeo3Prompt(opts: {
  shot: Shot;
  projectId: string;
  stylePreset: StylePresetId;
  anchor?: string;
  extraNegative?: string | null;
}): Promise<{ prompt: string; negative: string }> {
  const palette = getPalette(opts.stylePreset);
  const memory = await recallMemory(opts.projectId, opts.shot);

  // Lead with the shot's own transcript-derived subject so it carries the most
  // weight, then the stillness lead. The motion directive repeats mid-prompt.
  const parts: string[] = [
    opts.shot.visualSummary,
    motionLead(),
    memory && `featuring ${memory}`,
    opts.anchor,
    LENS_DESCRIPTION[opts.shot.lens],
    CAMERA_DESCRIPTION[opts.shot.cameraMovement],
    motionDirective(),
    palette.ambient,
    palette.lighting,
    `${palette.grade} color grade`,
    'photoreal, hyperdetailed, shallow depth of field, cinematic composition, 8K source quality',
    FULL_FRAME_GUARD,
  ].filter((x): x is string => Boolean(x));

  return {
    prompt: parts.join(', '),
    negative: [palette.negative, opts.extraNegative, MOTION_NEGATIVE].filter(Boolean).join(', '),
  };
}
