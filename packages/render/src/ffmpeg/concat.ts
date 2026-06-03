import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ffmpeg } from './run.js';

/**
 * Lossless concat via the demuxer. Requires all inputs to share codec params.
 * For mixed transitions (xfade) use buildXfadeChain instead.
 */
export async function concatDemuxer(inputs: string[], outPath: string): Promise<void> {
  const listPath = path.join(path.dirname(outPath), `concat_${Date.now()}.txt`);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(listPath, inputs.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  await ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath]);
}

/**
 * Build a chained xfade graph for transitioned shots. Each entry is a clip path
 * with its duration and the xfade type to apply WHEN COMING IN (first clip's
 * transitionIn is ignored).
 */
export interface XfadeStep {
  path: string;
  durationS: number;
  xfade: string; // 'fade'|'fadeblack'|'wipeleft'|...
  overlapS: number;
}

export async function buildXfadeChain(steps: XfadeStep[], outPath: string, opts: { nvenc?: boolean }): Promise<void> {
  if (steps.length === 0) throw new Error('no steps');
  if (steps.length === 1) {
    await ffmpeg(['-y', '-i', steps[0]!.path, '-c', 'copy', outPath]);
    return;
  }

  // If every transition is a hard cut, demuxer concat is much faster and
  // doesn't require re-encoding. xfade requires a real fade transition
  // (xfade=none / duration=0 is invalid ffmpeg syntax).
  const allCuts = steps.slice(1).every((s) => s.xfade === 'none' || s.overlapS === 0);
  if (allCuts) {
    await concatDemuxer(steps.map((s) => s.path), outPath);
    return;
  }

  const inputs: string[] = ['-y'];
  steps.forEach((s) => inputs.push('-i', s.path));

  const vFilters: string[] = [];
  const aFilters: string[] = [];
  let prevV = '0:v';
  let prevA = '0:a';
  let acc = steps[0]!.durationS;

  for (let i = 1; i < steps.length; i++) {
    const s = steps[i]!;
    const prev = steps[i - 1]!;
    // For 'cut' / no-overlap steps mixed into a chain, butt-join with a tiny
    // 0.04s fade so xfade can still process the chain.
    const xfadeName = s.xfade === 'none' ? 'fade' : s.xfade;
    // Clamp overlap so it never exceeds 40% of the shorter neighboring clip.
    // Without this, a 0.75s 'ember_sweep' overlap between two 1.5s shots
    // would request a longer fade than the source clip itself, and ffmpeg
    // throws "offset must be > 0" or "duration is too large".
    const maxOverlap = Math.max(0.04, Math.min(prev.durationS, s.durationS) * 0.4);
    const overlap = Math.min(Math.max(0.04, s.overlapS), maxOverlap);
    const offset = Math.max(0, acc - overlap);
    const outV = `v${i}`;
    const outA = `a${i}`;
    vFilters.push(`[${prevV}][${i}:v]xfade=transition=${xfadeName}:duration=${overlap}:offset=${offset}[${outV}]`);
    aFilters.push(`[${prevA}][${i}:a]acrossfade=d=${overlap}[${outA}]`);
    prevV = outV;
    prevA = outA;
    acc = offset + s.durationS;
  }

  // Diagnostic: emit the full filter graph so failures show what was sent to
  // FFmpeg. Long chains (30+ shots) are noisy but invaluable when triaging
  // "xfade exploded somewhere" errors.
  const filterGraph = [...vFilters, ...aFilters].join(';');
  // eslint-disable-next-line no-console
  console.log(`[xfadeChain] steps=${steps.length} filter_complex length=${filterGraph.length}`);

  // This master is an INTERMEDIATE — the final encode re-encodes it again — so
  // use the fast intermediate knobs rather than the high-quality final preset.
  const x264Preset = process.env.FFMPEG_INTERMEDIATE_PRESET ?? process.env.FFMPEG_X264_PRESET ?? 'veryfast';
  const x264Crf = process.env.FFMPEG_INTERMEDIATE_CRF ?? process.env.FFMPEG_X264_CRF ?? '22';
  const nvencPreset = process.env.FFMPEG_NVENC_PRESET ?? 'p6';
  const nvencCq = process.env.FFMPEG_NVENC_CQ ?? '22';
  const args = [
    ...inputs,
    '-filter_complex', filterGraph,
    '-map', `[${prevV}]`, '-map', `[${prevA}]`,
    '-c:v', opts.nvenc ? 'h264_nvenc' : 'libx264',
    ...(opts.nvenc ? ['-preset', nvencPreset, '-cq', nvencCq] : ['-preset', x264Preset, '-crf', x264Crf]),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    outPath,
  ];

  try {
    await ffmpeg(args);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    const isNvenc =
      opts.nvenc &&
      /nvenc|nvcuda|cuda|gpu/i.test(msg) &&
      !/permission|disk full/i.test(msg);
    if (!isNvenc) throw err;
    // eslint-disable-next-line no-console
    console.warn('[xfadeChain] NVENC failed, retrying with libx264. Reason:', msg.slice(0, 200));
    const fallback = [
      ...inputs,
      '-filter_complex', [...vFilters, ...aFilters].join(';'),
      '-map', `[${prevV}]`, '-map', `[${prevA}]`,
      '-c:v', 'libx264',
      '-preset', x264Preset, '-crf', x264Crf,
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      outPath,
    ];
    await ffmpeg(fallback);
  }
}
