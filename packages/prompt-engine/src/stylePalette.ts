import { DEFAULT_STYLE_PRESET, type StylePresetId } from '@emberforge/core';

const NEGATIVE_COMMON =
  'text, captions, subtitles, watermark, logo, brand name, on-screen UI, camera HUD, REC indicator, timestamp, date stamp, viewfinder overlay, focus reticle, film border, letterbox bars, frame markings, sprocket holes, cartoon, anime, low quality, blurry, oversaturated, deformed, plastic, AI artifacts, extra fingers';

/**
 * Off-world / off-niche negative baseline for sleep documentaries with a fixed
 * visual world. The per-project `forbiddenVisualDomains` from the analyze step
 * only lists intrusions the model happened to foresee — it can never enumerate
 * every off-world object the narration might trigger (the classic failure being
 * a literal prop like "a birth certificate" conjured from the word "birth").
 *
 * This baseline suppresses the whole CLASS of such intrusions: legible text and
 * documents, charts/graphics, UI/screens, and — crucially — the "symbolic prop
 * standing in for an abstract idea" pattern. Every item here is something that
 * is NEVER a legitimate ambient sleep-world (space, ocean, forest, ruins…), so
 * it is safe to add unconditionally without fighting any project's
 * `allowedVisualDomains`. It is appended only when a world contract exists.
 */
export const OFF_WORLD_NEGATIVE =
  'document, paper, certificate, form, page of text, legible writing, handwriting, charts, graphs, diagrams, infographic, numbers, equations, maps, calendar, clock face, computer screen, phone, tablet, app interface, icons, symbolic object, allegorical prop, literal metaphor, modern office, desk, still-life arrangement of objects';

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
  // Sleep-documentary preset: dark, low-saturation, soft contrast, no vivid
  // color, no harsh light. Pairs with the sleepy CLASSIFY prompt (embers off)
  // and the sleep crossfade renderer. The extra negatives actively push the
  // image models away from the bright, punchy look the other presets aim for.
  nocturne_soft: {
    grade: 'desaturated deep indigo and near-black, soft low contrast, muted cool tones, gentle bloom',
    lighting: 'soft diffuse moonlight, low-key, deep gentle shadows, no harsh highlights',
    ambient: 'soft haze, faint drifting particulate, dim distant glow',
    negative: `${NEGATIVE_COMMON}, vivid colors, neon, high saturation, harsh lighting, high contrast, bright daylight, busy composition, fast motion`,
    embersDefault: 'subtle',
  },
};

// Fall back to the product default when a project row carries an
// unknown/legacy/null stylePreset — returning undefined here previously crashed
// the prompt stage with "Cannot read properties of undefined (reading 'ambient')".
export function getPalette(preset: StylePresetId): StylePalette {
  return PALETTES[preset] ?? PALETTES[DEFAULT_STYLE_PRESET];
}
