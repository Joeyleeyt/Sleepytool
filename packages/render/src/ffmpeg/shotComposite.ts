import path from 'node:path';
import { ffmpeg } from './run.js';
import { embersAlpha, fxExists, fxPath, FX, smokeAlpha, type EmberLevel, type SmokeLevel } from '../fxLibrary.js';

export type KenBurnsMode = 'none' | 'in' | 'out' | 'left' | 'right';

export interface ShotCompositeOpts {
  videoPath: string;
  narrationPath: string;
  outPath: string;
  durationS: number;
  width: number;
  height: number;
  fps: number;
  embers: EmberLevel;
  smoke: SmokeLevel;
  grain: number; // 0..1
  vignette: number; // 0..1
  /** Apply zoompan to still images. Default: 'in' for PNG/JPG, 'none' for video. */
  kenBurns?: KenBurnsMode;
  nvenc?: boolean;
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
function isImageInput(p: string): boolean {
  return IMAGE_EXTS.has(path.extname(p).toLowerCase());
}

/**
 * Build a Ken Burns zoompan filter. Output is "still image as video", so we
 * also handle scale + duration here. The base node label is [base].
 */
function imageBaseFilter(mode: KenBurnsMode, width: number, height: number, durationS: number, fps: number): string {
  const totalFrames = Math.max(1, Math.round(durationS * fps));
  // Render at 2x resolution first so zoompan has headroom, then crop.
  const renderW = width * 2;
  const renderH = height * 2;
  const zMax = 1.15;
  const zStep = ((zMax - 1) / totalFrames).toFixed(6);

  let zoom: string;
  let x: string;
  let y: string;
  switch (mode) {
    case 'out':
      zoom = `if(eq(on,0),${zMax},max(zoom-${zStep},1))`;
      x = '(iw-iw/zoom)/2';
      y = '(ih-ih/zoom)/2';
      break;
    case 'left':
      zoom = `min(zoom+${zStep},${zMax})`;
      x = `iw*(1 - on/${totalFrames})`;
      y = '(ih-ih/zoom)/2';
      break;
    case 'right':
      zoom = `min(zoom+${zStep},${zMax})`;
      x = `iw*(on/${totalFrames})`;
      y = '(ih-ih/zoom)/2';
      break;
    case 'in':
    case 'none':
    default:
      zoom = `min(zoom+${zStep},${zMax})`;
      x = '(iw-iw/zoom)/2';
      y = '(ih-ih/zoom)/2';
      break;
  }

  // scale → zoompan → crop to target → fps → sar
  return (
    `[0:v]scale=${renderW}:${renderH}:force_original_aspect_ratio=increase,` +
    `crop=${renderW}:${renderH},` +
    `zoompan=z='${zoom}':x='${x}':y='${y}':d=${totalFrames}:s=${renderW}x${renderH}:fps=${fps},` +
    `scale=${width}:${height},setsar=1[base]`
  );
}

function videoBaseFilter(width: number, height: number, fps: number): string {
  return (
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
    `crop=${width}:${height},fps=${fps},setsar=1[base]`
  );
}

/**
 * Per-shot composite: base video (or still image with Ken Burns), ember
 * overlay, optional smoke, film grain, vignette, color grade, normalized
 * narration. Output is a self-contained shot MP4 that can be concat'd into
 * the final master.
 */
export async function compositeShot(opts: ShotCompositeOpts): Promise<void> {
  const inputs: string[] = ['-y'];
  const filters: string[] = [];

  const isImage = isImageInput(opts.videoPath);

  // Image inputs need -loop 1 + -framerate so ffmpeg synthesizes a video stream
  if (isImage) {
    inputs.push('-loop', '1', '-framerate', String(opts.fps), '-t', String(opts.durationS), '-i', opts.videoPath);
  } else {
    inputs.push('-i', opts.videoPath);
  }
  inputs.push('-i', opts.narrationPath);

  // Safe-mode: silently skip any overlay whose source file is missing on disk
  // so a fresh checkout without a seeded FX library still renders.
  let inputIdx = 2;

  const embersRel = opts.embers !== 'off' ? FX.embers[opts.embers as 'subtle' | 'medium' | 'heavy'] : null;
  const embersActive = embersRel != null && fxExists(embersRel);
  const embersIdx = embersActive ? inputIdx++ : null;
  if (embersActive && embersRel) inputs.push('-stream_loop', '-1', '-i', fxPath(embersRel));

  const smokeRel = opts.smoke !== 'off' ? FX.smoke[opts.smoke as 'low' | 'high'] : null;
  const smokeActive = smokeRel != null && fxExists(smokeRel);
  const smokeIdx = smokeActive ? inputIdx++ : null;
  if (smokeActive && smokeRel) inputs.push('-stream_loop', '-1', '-i', fxPath(smokeRel));

  const grainActive = opts.grain > 0 && fxExists(FX.grain.standard);
  const grainIdx = grainActive ? inputIdx++ : null;
  if (grainActive) inputs.push('-stream_loop', '-1', '-i', fxPath(FX.grain.standard));

  // base
  filters.push(
    isImage
      ? imageBaseFilter(opts.kenBurns ?? 'in', opts.width, opts.height, opts.durationS, opts.fps)
      : videoBaseFilter(opts.width, opts.height, opts.fps),
  );

  let chain = 'base';

  if (embersIdx !== null) {
    filters.push(
      `[${embersIdx}:v]scale=${opts.width}:${opts.height},colorchannelmixer=aa=${embersAlpha(opts.embers)}[embers]`,
    );
    filters.push(`[${chain}][embers]blend=all_mode=screen[withEmbers]`);
    chain = 'withEmbers';
  }

  if (smokeIdx !== null) {
    filters.push(
      `[${smokeIdx}:v]scale=${opts.width}:${opts.height},colorchannelmixer=aa=${smokeAlpha(opts.smoke)}[smoke]`,
    );
    filters.push(`[${chain}][smoke]blend=all_mode=screen[withSmoke]`);
    chain = 'withSmoke';
  }

  if (grainIdx !== null) {
    filters.push(
      `[${grainIdx}:v]scale=${opts.width}:${opts.height},colorchannelmixer=aa=${opts.grain.toFixed(3)}[grain]`,
    );
    filters.push(`[${chain}][grain]blend=all_mode=overlay[withGrain]`);
    chain = 'withGrain';
  }

  // color grade + vignette
  const vignette = opts.vignette > 0 ? `,vignette=PI/${(6 - opts.vignette * 3).toFixed(2)}` : '';
  filters.push(`[${chain}]eq=contrast=1.12:saturation=0.93:brightness=-0.02${vignette}[final]`);

  // narration normalization
  filters.push(`[1:a]aresample=48000,loudnorm=I=-18:TP=-2:LRA=11[narration]`);

  // Per-shot composite runs N times per project — preset choice dominates
  // wall clock. Use the same env knobs as finalEncode.ts. Veryfast cuts
  // per-shot time ~2× with marginal quality loss for intermediate clips.
  const x264Preset = process.env.FFMPEG_X264_PRESET ?? 'medium';
  const x264Crf = process.env.FFMPEG_X264_CRF ?? '20';
  const nvencPreset = process.env.FFMPEG_NVENC_PRESET ?? 'p6';
  const nvencCq = process.env.FFMPEG_NVENC_CQ ?? '20';
  const args = [
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[final]',
    '-map', '[narration]',
    '-t', String(opts.durationS),
    '-c:v', opts.nvenc ? 'h264_nvenc' : 'libx264',
    ...(opts.nvenc ? ['-preset', nvencPreset, '-cq', nvencCq] : ['-preset', x264Preset, '-crf', x264Crf]),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    opts.outPath,
  ];

  try {
    await ffmpeg(args);
  } catch (err) {
    // Same fallback as finalEncode.ts — if NVENC isn't usable on this host,
    // retry with libx264 so a render doesn't die on a per-shot composite.
    const msg = (err as Error).message ?? String(err);
    const isNvenc =
      opts.nvenc &&
      /nvenc|nvcuda|cuda|gpu/i.test(msg) &&
      !/permission|disk full/i.test(msg);
    if (!isNvenc) throw err;
    // eslint-disable-next-line no-console
    console.warn('[compositeShot] NVENC failed, retrying with libx264. Reason:', msg.slice(0, 200));
    const fallback = [
      ...inputs,
      '-filter_complex', filters.join(';'),
      '-map', '[final]',
      '-map', '[narration]',
      '-t', String(opts.durationS),
      '-c:v', 'libx264',
      '-preset', x264Preset, '-crf', x264Crf,
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      opts.outPath,
    ];
    await ffmpeg(fallback);
  }
}
