import type { StylePresetId } from '@emberforge/core';

const NEGATIVE_COMMON =
  'text, captions, subtitles, watermark, logo, brand name, on-screen UI, camera HUD, REC indicator, timestamp, date stamp, viewfinder overlay, focus reticle, film border, letterbox bars, frame markings, sprocket holes, cartoon, anime, low quality, blurry, oversaturated, deformed, plastic, AI artifacts, extra fingers';

export interface StylePalette {
  grade: string;
  lighting: string;
  ambient: string;
  negative: string;
  embersDefault: 'subtle' | 'medium' | 'heavy';
}

export const PALETTES: Record<StylePresetId, StylePalette> = {
  cinematic_dark_ember: {
    grade: 'teal-and-orange cinematic documentary grade, deep shadows, crushed blacks, golden highlights',
    lighting: 'volumetric god rays, soft rim light, low-key dramatic',
    ambient: 'floating embers, drifting smoke, volumetric fog, dust motes',
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
    ambient: 'cigarette smoke drift, dust, slow fog',
    negative: NEGATIVE_COMMON,
    embersDefault: 'subtle',
  },
  warm_archival: {
    grade: 'warm sepia, faded color, slight color cast, soft contrast',
    lighting: 'soft window light, golden hour, gentle bounce',
    ambient: 'fine grain, light leaks',
    negative: NEGATIVE_COMMON,
    embersDefault: 'subtle',
  },
};

export function getPalette(preset: StylePresetId): StylePalette {
  return PALETTES[preset];
}
