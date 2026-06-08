import type { CameraMove, LensProfile } from '@emberforge/core';

export const LENS_DESCRIPTION: Record<LensProfile, string> = {
  '14mm_ultrawide': 'ultrawide perspective, sweeping vista, deep foreground',
  '24mm_wide': 'wide environmental perspective, immersive framing',
  '35mm_anamorphic': 'anamorphic widescreen perspective, oval bokeh, soft horizontal flares',
  '50mm_natural': 'natural perspective, intimate framing',
  '85mm_portrait': 'portrait perspective, creamy bokeh, shallow depth of field',
  '135mm_tele': 'telephoto compression, isolated subject, soft background',
  macro_100mm: 'macro extreme close-up, razor-thin focus plane',
};

/**
 * Camera-move descriptions, all written for SLEEP MODE (see motionMode.ts):
 * every move is micro-paced and the historically "fast" moves (whip_pan,
 * handheld_drift, aerial_descend, macro_push, crane_*) are deliberately
 * neutralized to a calm equivalent. The CLASSIFY stage already restricts shots
 * to the calm set, but a legacy shot row or an LLM slip must never be able to
 * inject energetic motion into a sleep clip — so the vocabulary itself can only
 * ever describe near-still camera work. The motionDirective() appended after
 * this in each builder reinforces the same near-zero motion budget.
 */
export const CAMERA_DESCRIPTION: Record<CameraMove, string> = {
  static: 'locked-off static camera, no movement',
  dolly_in: 'extremely slow micro-dolly-in, barely perceptible push toward subject',
  dolly_out: 'extremely slow micro-dolly-out, barely perceptible pull-back',
  crane_down: 'very slow, gentle downward drift, almost imperceptible',
  crane_up: 'very slow, gentle upward drift, almost imperceptible',
  orbit_left: 'very slow, gentle orbit to the left, barely moving',
  orbit_right: 'very slow, gentle orbit to the right, barely moving',
  whip_pan: 'locked-off static camera, no movement',
  handheld_drift: 'locked-off camera with the faintest organic micro-drift, no shake',
  aerial_descend: 'extremely slow, gentle aerial descent, barely perceptible',
  macro_push: 'extremely slow macro micro-push, barely perceptible',
  ken_burns_in: 'imperceptibly slow ken burns push-in across a still composition',
  ken_burns_out: 'imperceptibly slow ken burns pull-out from a still composition',
};
