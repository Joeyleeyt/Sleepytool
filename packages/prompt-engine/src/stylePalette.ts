import type { StylePresetId } from '@emberforge/core';

export interface StylePalette {
  grade: string;
  lighting: string;
  ambient: string;
  negative: string;
  embersDefault: 'subtle' | 'medium' | 'heavy';
}

export const PALETTES: Record<StylePresetId, StylePalette> = {
  cinematic_dark_ember: {
    grade: 'teal-and-orange Netflix documentary, deep shadows, crushed blacks, golden highlights',
    lighting: 'volumetric god rays, soft rim light, low-key dramatic',
    ambient: 'floating embers, drifting smoke, volumetric fog, dust motes',
    negative:
      'cartoon, anime, low quality, watermark, text, blurry, oversaturated, deformed, plastic, AI artifacts, extra fingers',
    embersDefault: 'medium',
  },
  cosmic_minimal: {
    grade: 'deep indigo and violet, ultra-clean, soft bloom',
    lighting: 'soft diffuse light, single key, deep void background',
    ambient: 'particulate dust, slow nebulae, subtle starfields',
    negative: 'cluttered, harsh shadows, low quality, watermark, text, AI artifacts',
    embersDefault: 'subtle',
  },
  noir_documentary: {
    grade: 'desaturated, high contrast, monochromatic with warm amber accents',
    lighting: 'hard side light, deep shadows, venetian blinds, smoky haze',
    ambient: 'cigarette smoke drift, dust, slow fog',
    negative: 'colorful, bright, low quality, watermark, text',
    embersDefault: 'subtle',
  },
  warm_archival: {
    grade: 'warm sepia, faded film, slight color cast, soft contrast',
    lighting: 'soft window light, golden hour, gentle bounce',
    ambient: 'film grain, gate weave, light leaks',
    negative: 'crisp digital, neon, harsh, watermark, text',
    embersDefault: 'subtle',
  },
};

export function getPalette(preset: StylePresetId): StylePalette {
  return PALETTES[preset];
}
