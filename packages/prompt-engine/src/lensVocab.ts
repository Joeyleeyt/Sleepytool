import type { CameraMove, LensProfile } from '@emberforge/core';

export const LENS_DESCRIPTION: Record<LensProfile, string> = {
  '14mm_ultrawide': 'shot on 14mm ultrawide lens, sweeping vista, deep foreground',
  '24mm_wide': 'shot on 24mm wide lens, environmental, immersive',
  '35mm_anamorphic': 'shot on 35mm anamorphic lens, oval bokeh, horizontal lens flares, 2.39:1 cinematic',
  '50mm_natural': 'shot on 50mm lens, natural perspective, intimate',
  '85mm_portrait': 'shot on 85mm portrait lens, creamy bokeh, shallow depth of field',
  '135mm_tele': 'shot on 135mm telephoto, compressed depth, isolated subject',
  macro_100mm: 'shot on 100mm macro lens, extreme detail, razor-thin focus plane',
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
