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

export const CAMERA_DESCRIPTION: Record<CameraMove, string> = {
  static: 'locked-off static camera',
  dolly_in: 'slow cinematic dolly-in toward subject',
  dolly_out: 'slow cinematic dolly-out revealing scale',
  crane_down: 'crane camera descending gracefully',
  crane_up: 'crane camera ascending to reveal',
  orbit_left: 'orbital camera arcing left around the subject',
  orbit_right: 'orbital camera arcing right around the subject',
  whip_pan: 'rapid whip pan transitioning across the scene',
  handheld_drift: 'subtle handheld drift, organic micro-motion',
  aerial_descend: 'aerial descent, drone-style top-down approach',
  macro_push: 'macro slow push, extreme close detail',
  ken_burns_in: 'slow ken burns push-in across still composition',
  ken_burns_out: 'slow ken burns pull-out from still composition',
};
