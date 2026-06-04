import type { StylePresetId } from '@emberforge/core';

const NEGATIVE_COMMON =
  'text, captions, subtitles, watermark, logo, brand name, on-screen UI, camera HUD, REC indicator, timestamp, date stamp, viewfinder overlay, focus reticle, film border, letterbox bars, frame markings, sprocket holes, cartoon, anime, low quality, blurry, oversaturated, deformed, plastic, AI artifacts, extra fingers';

export interface StylePalette {
  grade: string;
  lighting: string;
  /**
   * In-scene atmosphere baked into the AI-generation prompt. This must NOT
   * include effects the render pipeline overlays at composite time — embers,
   * drifting smoke and film grain are applied as FFmpeg overlays in
   * compositeShot (driven by each shot's fxRecommendation / embersDefault).
   * Putting those words here too made the AI bake fire/smoke into the clip
   * AND get the overlay on top, producing the doubled "fiery" look. Keep this
   * to atmosphere the renderer can't synthesize (fog, dust, nebulae, light leaks).
   */
  ambient: string;
  negative: string;
  embersDefault: 'subtle' | 'medium' | 'heavy';
}

export const PALETTES: Record<StylePresetId, StylePalette> = {
  cinematic_dark_ember: {
    grade: 'teal-and-orange cinematic documentary grade, deep shadows, crushed blacks, golden highlights',
    lighting: 'volumetric god rays, soft rim light, low-key dramatic',
    ambient: 'volumetric fog, dust motes',
    negative: NEGATIVE_COMMON,
    embersDefault: 'medium',
  },
  cosmic_minimal: {
    grade: 'deep indigo and violet, ultra-clean, soft bloom',
    lighting: 'soft diffuse light, single key, deep void background',
    ambient: 'particulate dust, slow nebulae, subtle starfields',
    negative: NEGATIVE_COMMON,
    embersDefault: 'subtle',
  },
  noir_documentary: {
    grade: 'desaturated, high contrast, monochromatic with warm amber accents',
    lighting: 'hard side light, deep shadows, venetian blinds, smoky haze',
    ambient: 'dust, slow haze',
    negative: NEGATIVE_COMMON,
    embersDefault: 'subtle',
  },
  warm_archival: {
    grade: 'warm sepia, faded color, slight color cast, soft contrast',
    lighting: 'soft window light, golden hour, gentle bounce',
    ambient: 'light leaks',
    negative: NEGATIVE_COMMON,
    embersDefault: 'subtle',
  },
};

export function getPalette(preset: StylePresetId): StylePalette {
  return PALETTES[preset];
}
