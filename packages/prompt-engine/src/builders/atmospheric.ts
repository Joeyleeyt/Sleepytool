import type { Shot, StylePresetId } from '@emberforge/core';
import { getPalette } from '../stylePalette.js';
import { FULL_FRAME_GUARD } from '../frameGuard.js';
import { motionLead, motionDirective, MOTION_NEGATIVE } from '../motionMode.js';
import { recallMemory } from '../visualMemory.js';

/**
 * Lower-cost path: atmospheric b-roll via 69labs. Used for "breathing room"
 * shots where literal visual fidelity matters less than mood.
 *
 * These shots are deliberately people-free, so memory recall is scoped to
 * environment/palette/style kinds — a recurring *character* descriptor would
 * contradict the "no people" instruction. The shared style anchor still keeps
 * the world + mood consistent with every other shot.
 */
export async function buildAtmosphericPrompt(opts: {
  shot: Shot;
  projectId: string;
  stylePreset: StylePresetId;
  anchor?: string;
  extraNegative?: string | null;
}): Promise<{ prompt: string; negative: string }> {
  const palette = getPalette(opts.stylePreset);
  const memory = await recallMemory(opts.projectId, opts.shot, {
    kinds: ['environment', 'palette', 'style_token'],
  });
  // Lead with the shot's own transcript-derived subject so it carries the most
  // weight, then the stillness lead. The motion directive repeats mid-prompt.
  const prompt = [
    opts.shot.visualSummary || 'atmospheric environmental footage',
    motionLead(),
    memory && `set in ${memory}`,
    opts.anchor,
    'no people',
    motionDirective(),
    palette.ambient,
    palette.lighting,
    `${palette.grade} color grade`,
    'cinematic, premium documentary feel',
    FULL_FRAME_GUARD,
  ]
    .filter((x): x is string => Boolean(x))
    .join(', ');
  return {
    prompt,
    negative: [palette.negative, opts.extraNegative, MOTION_NEGATIVE].filter(Boolean).join(', '),
  };
}
