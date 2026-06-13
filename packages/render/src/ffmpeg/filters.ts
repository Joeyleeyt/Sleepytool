/**
 * Shared "fill the frame" geometry and the global cinematic grade + overlay.
 *
 * These concerns are deliberately centralised so every image and every video
 * clip is treated identically — full-screen coverage with no bars, one
 * consistent documentary look, and one consistent ember/light-leak layer across
 * the whole timeline.
 */

import { FX, fxExists, fxPath } from '../fxLibrary.js';

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Cover-scale + center-crop a source to EXACTLY w×h (the 16:9 frame) with no
 * black bars or letterboxing.
 *
 * `force_original_aspect_ratio=increase` scales up until BOTH dimensions cover
 * the frame, then `crop` trims the overflow — identical "fill" behaviour to a
 * CSS `object-fit: cover`, which is what premium YouTube documentaries use.
 * Works for any source aspect (portrait or landscape) and keeps the visual
 * centre in frame. Pass `fps` to also normalise the frame rate.
 */
export function coverScaleCrop(w: number, h: number, fps?: number): string {
  const f = fps ? `,fps=${fps}` : '';
  return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}${f},setsar=1`;
}

/** Global grade on unless CINEMATIC_GRADE=false (restores the instant
 *  stream-copy mux for fast review renders). */
export function isCinematicGradeEnabled(): boolean {
  return (process.env.CINEMATIC_GRADE ?? 'true') !== 'false';
}

/**
 * The global "premium YouTube documentary / fiery cinematic" grade.
 *
 *   • warm highlights + a subtle orange/red glow  (colorbalance, warm in highs)
 *   • filmic contrast                             (gentle eq + S-curve)
 *   • a soft light-leak feel + slight vignette    (warm push + gentle vignette)
 *
 * Applied ONCE to the finished master (see finalEncode) so EVERY scene shares
 * an identical look — never per-scene, which would drift. Deliberately subtle:
 * scale the whole effect with CINEMATIC_GRADE_STRENGTH (0..1, default 1). It is
 * applied BEFORE subtitle burn-in, so on-screen text is never tinted, darkened
 * by the vignette, or otherwise made harder to read.
 *
 * Returns a comma-joined filterchain fragment (no input/output pad labels), so
 * it composes both in `-vf` and inside a larger `-filter_complex` chain.
 */
export function cinematicGrade(): string {
  const s = clamp(Number(process.env.CINEMATIC_GRADE_STRENGTH ?? '1'), 0, 1);
  if (s <= 0) return 'format=yuv420p';

  const f = (n: number) => n.toFixed(3);
  return [
    'format=yuv420p',
    // Filmic base: a touch more contrast + saturation, a hair darker, lifted
    // gamma so shadows don't crush — all scaled by strength.
    `eq=contrast=${f(1 + 0.06 * s)}:saturation=${f(1 + 0.06 * s)}:` +
      `brightness=${f(-0.01 * s)}:gamma=${f(1 - 0.02 * s)}`,
    // Warm grade: push red up / blue down, strongest in the highlights → the
    // "warm highlights + orange glow" without flames on screen.
    `colorbalance=rs=${f(0.015 * s)}:bs=${f(-0.02 * s)}:` +
      `rm=${f(0.02 * s)}:bm=${f(-0.02 * s)}:rh=${f(0.05 * s)}:bh=${f(-0.05 * s)}`,
    // Gentle S-curve — slight toe + shoulder for that filmic roll-off.
    `curves=master='0/0 0.25/${f(0.25 - 0.03 * s)} 0.75/${f(0.75 + 0.04 * s)} 1/1'`,
    // Soft, atmospheric vignette (subtle — keeps edges/subtitle area readable).
    'vignette=angle=PI/7',
  ].join(',');
}

// --- Ember / light-leak overlay layer ---------------------------------------

export type OverlayMode = 'off' | 'auto' | 'embers' | 'lightleak' | 'particles';

/** Resolve CINEMATIC_OVERLAY. 'embers' (default) = screen-blend the real ember
 *  plate bundled in the FX library (falls back to synthetic particles if the
 *  plate is missing). 'particles' = asset-free synthetic fire embers rising from
 *  the bottom. 'lightleak' = asset-free drifting warm wash. 'auto' = use a real
 *  ember asset if one is present, else fall back to synthetic particles.
 *
 *  ON by default: a sparks/embers plate ships in packages/render/assets, so the
 *  global overlay renders out of the box on every machine. Set
 *  CINEMATIC_OVERLAY=off to disable it (e.g. for the instant stream-copy mux on
 *  fast review renders), or to any other mode above to switch implementation. */
function overlayMode(): OverlayMode {
  const v = (process.env.CINEMATIC_OVERLAY ?? 'embers').toLowerCase();
  if (v === 'off' || v === 'false' || v === '0' || v === 'none') return 'off';
  if (v === 'embers' || v === 'lightleak' || v === 'auto' || v === 'particles') return v;
  return 'embers';
}

function roundEven(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/** Parse a warm 0xRRGGBB / #RRGGBB / RRGGBB colour into colorchannelmixer
 *  ratios (each 0..1). A gray dot (R=G=B=v) fed through these becomes the colour
 *  scaled by v. Falls back to amber on a bad value. */
function colorMixRatios(spec: string): { r: number; g: number; b: number } {
  const hex = spec.trim().replace(/^0x/i, '').replace(/^#/, '');
  const v = /^[0-9a-f]{6}$/i.test(hex) ? parseInt(hex, 16) : 0xff7a1e;
  return { r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255 };
}

export interface EmberOverlayPlan {
  /** Extra ffmpeg input args to append AFTER the audio input. Empty for the
   *  asset-free synthetic light-leak. */
  inputArgs: string[];
  /** Build the overlay filterchain. `inLabel` is the current video pad, the
   *  result is `[outLabel]`. `assetInputIndex` is the ffmpeg input index the
   *  looped ember asset occupies (ignored by the synthetic light-leak). */
  build: (inLabel: string, outLabel: string, assetInputIndex: number) => string;
  /** Which path was chosen — for logging/diagnostics. */
  kind: 'embers' | 'lightleak' | 'particles';
}

/**
 * Plan a global, subtle warm overlay, screen-blended over the finished master
 * (see finalEncode). Implementations:
 *
 *  • PARTICLES (default) — asset-free synthetic FIRE EMBERS that rise from the
 *    bottom of the frame. A sparse, deterministic spark field is scrolled UPWARD
 *    (positive `scroll=v` = up; the field loops so the rise is seamless), blurred
 *    into glowing dots and tinted warm.
 *  • EMBERS — loops a real alpha ember plate from the FX library
 *    (FX.embers[CINEMATIC_OVERLAY_LEVEL], default 'subtle'). Chosen when
 *    CINEMATIC_OVERLAY=embers, or 'auto' and the asset exists on disk.
 *  • LIGHT-LEAK — an asset-free, slowly-drifting warm gradient wash.
 *
 * All use `blend=screen:shortest=1`: `screen` adds warm light (never darkens),
 * and `shortest=1` is REQUIRED because every overlay source is infinite (looped
 * asset / endless gradient / looped spark field) — without it the encode never
 * terminates. Returns null when disabled (CINEMATIC_OVERLAY=off).
 *
 * The blend is done in RGB (`format=gbrp` on BOTH inputs, then back to yuv420p).
 * This is NOT optional: `blend` operates per-plane, so a screen blend in yuv420p
 * runs the screen formula on the U/V chroma planes too. The overlay is black
 * (chroma = neutral 128) across ~all of the frame, and screen(chroma, 128) ≠
 * chroma — it pushes BOTH U and V up, tinting the entire frame magenta/pink.
 * In RGB the overlay's black is (0,0,0) and screen(base, 0) = base, so unlit
 * areas are untouched and only the embers add warm light.
 */
export function planEmberOverlay(width: number, height: number, fps: number): EmberOverlayPlan | null {
  const mode = overlayMode();
  if (mode === 'off') return null;

  const level = (process.env.CINEMATIC_OVERLAY_LEVEL ?? 'subtle') as keyof typeof FX.embers;
  const assetRel = FX.embers[level] ?? FX.embers.subtle;
  const assetThere = fxExists(assetRel);
  const useAsset = mode === 'embers' || (mode === 'auto' && assetThere);

  if (useAsset && assetThere) {
    const alpha = clamp(Number(process.env.CINEMATIC_OVERLAY_ALPHA ?? '0.15'), 0, 1);
    return {
      kind: 'embers',
      inputArgs: ['-stream_loop', '-1', '-i', fxPath(assetRel)],
      build: (inLabel, outLabel, idx) =>
        `[${idx}:v]${coverScaleCrop(width, height, fps)},format=gbrp[ovsrc];` +
        `[${inLabel}]format=gbrp[ovbase];` +
        `[ovbase][ovsrc]blend=all_mode=screen:all_opacity=${alpha}:shortest=1,format=yuv420p[${outLabel}]`,
    };
  }

  if (mode !== 'lightleak') {
    // Synthetic rising fire embers (default) — no asset required.
    //
    // Pipeline (all at QUARTER res, then upscaled — the upscale softens the dots
    // into glowing embers and keeps it cheap even on a 2-hour CPU encode):
    //   1. a 1-frame black canvas → geq stamps a SPARSE, DETERMINISTIC spark
    //      field (a sine-hash of x/y; ~CINEMATIC_EMBER_AMOUNT of pixels lit),
    //   2. loop that single frame forever (so geq runs ONCE),
    //   3. scroll it UPWARD (positive v) — verified upward; the field wraps so
    //      the rise is seamless and endless,
    //   4. a 2nd geq applies a vertical falloff (p(X,Y)*(floor + (1-floor)*Y/H))
    //      so embers are brightest at the bottom "source" and fade as they rise,
    //   5. blur into soft glowing dots, tint warm, upscale.
    //   CINEMATIC_OVERLAY_ALPHA   screen opacity (default 0.6 — embers are sparse)
    //   CINEMATIC_OVERLAY_COLOR   warm 0xRRGGBB tint (default amber)
    //   CINEMATIC_EMBER_SPEED     rise speed (fraction/frame; bigger = faster)
    //   CINEMATIC_EMBER_AMOUNT    fraction of pixels lit (bigger = more embers)
    //   CINEMATIC_EMBER_BLUR      glow radius (gblur sigma; smaller = smaller, tighter particles)
    // Sleep defaults (client 6/11: "particles should be smaller and slower"):
    // a slow rise (0.005) and a tight glow (sigma 0.8) so embers read as fine,
    // drifting sparks rather than large fast blobs.
    const alpha = clamp(Number(process.env.CINEMATIC_OVERLAY_ALPHA ?? '0.6'), 0, 1);
    const speed = clamp(Number(process.env.CINEMATIC_EMBER_SPEED ?? '0.005'), 0.0005, 0.2);
    const amount = clamp(Number(process.env.CINEMATIC_EMBER_AMOUNT ?? '0.006'), 0.0005, 0.05);
    const blur = clamp(Number(process.env.CINEMATIC_EMBER_BLUR ?? '0.8'), 0.2, 4);
    const thr = (1 - amount).toFixed(4);
    const { r, g, b } = colorMixRatios(process.env.CINEMATIC_OVERLAY_COLOR ?? '0xFF7A1E');
    const gw = roundEven(width / 4);
    const gh = roundEven(height / 4);
    const sparkField =
      `color=c=black:s=${gw}x${gh}:d=1:r=${fps},format=gray,` +
      `geq=lum='if(gt(mod(abs(sin(X*12.9898+Y*78.233))*43758.545,1),${thr}),255,0)',` +
      `loop=loop=-1:size=1,scroll=v=${speed},gblur=sigma=${blur.toFixed(2)},` +
      `geq=lum='p(X,Y)*(0.16+0.84*(Y/H))',format=rgb24,` +
      `colorchannelmixer=rr=${r.toFixed(3)}:gg=${g.toFixed(3)}:bb=${b.toFixed(3)},` +
      `scale=${width}:${height},format=gbrp`;
    return {
      kind: 'particles',
      inputArgs: [],
      build: (inLabel, outLabel) =>
        `${sparkField}[ovsrc];` +
        `[${inLabel}]format=gbrp[ovbase];` +
        `[ovbase][ovsrc]blend=all_mode=screen:all_opacity=${alpha}:shortest=1,format=yuv420p[${outLabel}]`,
    };
  }

  // Synthetic warm light-leak — no asset required, so the effect ALWAYS shows.
  //
  // Generated at QUARTER resolution then upscaled: the scale interpolation is
  // what turns the hard gradient into soft, organic warm blooms, and the tiny
  // canvas keeps this near-free even on a 2-hour CPU encode. `speed` slowly
  // drifts the gradient so the leak sweeps across over time; `screen` only ever
  // ADDS warm light (never darkens). Opacity stays low so it reads as a film
  // light-leak / atmosphere, not flames over the screen.
  //   CINEMATIC_OVERLAY_TYPE   linear (diagonal sweep, default) | radial (bloom)
  //   CINEMATIC_OVERLAY_COLOR  warm 0xRRGGBB
  //   CINEMATIC_OVERLAY_SPEED  drift speed (smaller = slower)
  //   CINEMATIC_OVERLAY_ALPHA  screen opacity 0..1
  const alpha = clamp(Number(process.env.CINEMATIC_OVERLAY_ALPHA ?? '0.1'), 0, 1);
  const color = process.env.CINEMATIC_OVERLAY_COLOR ?? '0xFF7A1E';
  const speed = process.env.CINEMATIC_OVERLAY_SPEED ?? '0.004';
  const type = (process.env.CINEMATIC_OVERLAY_TYPE ?? 'linear').toLowerCase();
  const gw = roundEven(width / 4);
  const gh = roundEven(height / 4);
  const grad =
    type === 'radial'
      ? `gradients=s=${gw}x${gh}:c0=${color}:c1=0x000000:type=radial:speed=${speed}:r=${fps}`
      : `gradients=s=${gw}x${gh}:c0=0x000000:c1=${color}:c2=0x000000:nb_colors=3:` +
        `x0=0:y0=0:x1=${gw}:y1=${gh}:speed=${speed}:r=${fps}`;
  return {
    kind: 'lightleak',
    inputArgs: [],
    build: (inLabel, outLabel) =>
      `${grad},scale=${width}:${height},format=gbrp[ovsrc];` +
      `[${inLabel}]format=gbrp[ovbase];` +
      `[ovbase][ovsrc]blend=all_mode=screen:all_opacity=${alpha}:shortest=1,format=yuv420p[${outLabel}]`,
  };
}
