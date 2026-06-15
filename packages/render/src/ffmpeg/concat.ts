import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ffmpeg } from './run.js';
import type { EmberOverlayPlan } from './filters.js';

/**
 * Lossless concat via the demuxer. Requires all inputs to share codec params.
 * For mixed transitions (xfade) use buildXfadeChain instead.
 */
export async function concatDemuxer(inputs: string[], outPath: string): Promise<void> {
  const listPath = path.join(path.dirname(outPath), `concat_${Date.now()}.txt`);
  await mkdir(path.dirname(outPath), { recursive: true });
  // ffmpeg's concat demuxer resolves relative `file` entries against the LIST
  // file's own directory, not the process cwd. Our inputs are cwd-relative
  // (RENDER_WORK_DIR is often relative), so writing them verbatim doubles the
  // path prefix. Resolve to absolute paths so the entries are unambiguous.
  await writeFile(
    listPath,
    inputs.map((p) => `file '${path.resolve(p).replace(/'/g, "'\\''")}'`).join('\n'),
  );
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

/**
 * Optional "finishing" layer baked into the FINAL xfade pass so the master comes
 * out already graded + overlaid. The pass that assembles the deliverable is going
 * to re-encode the whole timeline anyway, so applying the global grade + ember
 * overlay there means finalEncode can stream-COPY instead of running a SECOND
 * full-length re-encode. That removes a whole encode generation — faster AND one
 * less quality loss. Only pass this to the last pass that writes the deliverable
 * master; never to an intermediate batch sub-master (it would double-apply).
 */
export interface XfadeFinish {
  /** Comma-joined cinematic-grade filterchain (no pad labels), or null to skip. */
  grade?: string | null;
  /** Ember/light-leak overlay plan: build() screen-blends, inputArgs add the asset. */
  overlay?: EmberOverlayPlan | null;
  /** Target frame size — used by the overlay to cover-scale its plate. */
  width: number;
  height: number;
}

export async function buildXfadeChain(
  steps: XfadeStep[],
  outPath: string,
  opts: { nvenc?: boolean; audio?: boolean; finish?: XfadeFinish; threads?: number },
): Promise<void> {
  // The sleep renderer drives a VIDEO-ONLY master (narration is a separate audio
  // master muxed in at finalEncode), so audio acrossfade is opt-out. Defaults to
  // true to preserve the original A+V behaviour for any other caller.
  const audio = opts.audio ?? true;
  // A finishing layer must be rendered, so the copy-only fast paths are only
  // valid when there's nothing to bake in.
  const finish = opts.finish;
  const hasFinish = !!finish && (!!finish.grade || !!finish.overlay);
  if (steps.length === 0) throw new Error('no steps');
  if (!hasFinish && steps.length === 1) {
    await ffmpeg(['-y', '-i', steps[0]!.path, '-c', 'copy', ...(audio ? [] : ['-an']), outPath]);
    return;
  }

  // If every transition is a hard cut, demuxer concat is much faster and
  // doesn't require re-encoding. xfade requires a real fade transition
  // (xfade=none / duration=0 is invalid ffmpeg syntax). A finishing layer needs
  // a real encode, so it opts out of the copy path.
  const allCuts = steps.slice(1).every((s) => s.xfade === 'none' || s.overlapS === 0);
  if (!hasFinish && allCuts) {
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
    prevV = outV;
    if (audio) {
      aFilters.push(`[${prevA}][${i}:a]acrossfade=d=${overlap}[${outA}]`);
      prevA = outA;
    }
    acc = offset + s.durationS;
  }

  // Bake the finishing grade + ember overlay into this (already-re-encoding)
  // pass: grade first (sets the look), then the warm overlay screen-blended on
  // top — the same order finalEncode uses, so the result is identical to the old
  // separate final pass but without the extra encode generation. The overlay
  // asset, when present, is the next input AFTER all the clip inputs.
  const finishFilters: string[] = [];
  const extraInputs: string[] = [];
  let finalV = prevV;
  if (hasFinish) {
    if (finish!.grade) {
      finishFilters.push(`[${finalV}]${finish!.grade}[fc_grade]`);
      finalV = 'fc_grade';
    }
    if (finish!.overlay) {
      const assetIdx = steps.length; // overlay plate is the input after all clips
      finishFilters.push(finish!.overlay.build(finalV, 'fc_finish', assetIdx));
      finalV = 'fc_finish';
      extraInputs.push(...finish!.overlay.inputArgs);
    }
  }

  // Diagnostic: emit the full filter graph so failures show what was sent to
  // FFmpeg. Long chains (30+ shots) are noisy but invaluable when triaging
  // "xfade exploded somewhere" errors.
  const videoChain = [...vFilters, ...finishFilters];
  const filterGraph = (audio ? [...videoChain, ...aFilters] : videoChain).join(';');
  // eslint-disable-next-line no-console
  console.log(
    `[xfadeChain] steps=${steps.length} audio=${audio} finish=${hasFinish} filter_complex length=${filterGraph.length}`,
  );

  // An intermediate sub-master gets re-encoded again, so it uses the fast knobs.
  // The FINISHING pass IS the deliverable (finalEncode only stream-copies it), so
  // it uses the FINAL-quality knobs + browser-safe profile/level.
  const x264Preset = hasFinish
    ? (process.env.FFMPEG_X264_PRESET ?? 'medium')
    : (process.env.FFMPEG_INTERMEDIATE_PRESET ?? process.env.FFMPEG_X264_PRESET ?? 'veryfast');
  const x264Crf = hasFinish
    ? (process.env.FFMPEG_X264_CRF ?? '20')
    : (process.env.FFMPEG_INTERMEDIATE_CRF ?? process.env.FFMPEG_X264_CRF ?? '22');
  const nvencPreset = process.env.FFMPEG_NVENC_PRESET ?? 'p6';
  const nvencCq = process.env.FFMPEG_NVENC_CQ ?? (hasFinish ? '21' : '22');
  const profileArgs = hasFinish ? ['-profile:v', 'high', '-level:v', '4.2'] : [];
  const audioArgs = audio ? ['-map', `[${prevA}]`, '-c:a', 'aac', '-b:a', '192k'] : ['-an'];
  // Cap libx264 threads PER process when the caller runs MANY of these at once
  // (batch sub-masters: SLEEP_BATCH_CONCURRENCY in parallel). Without a cap each
  // libx264 grabs one thread per core, so N concurrent encodes spawn N×cores
  // threads and thrash the scheduler — AND starve the Node event loop enough to
  // break the BullMQ lock heartbeat. The xfade FILTER is single-threaded and is
  // the real bottleneck anyway, so a small cap costs almost nothing. NVENC has no
  // such CPU-thread contention, and the single deliverable pass passes no cap so
  // it keeps every core.
  const threadArgs =
    !opts.nvenc && opts.threads && opts.threads > 0 ? ['-threads', String(opts.threads)] : [];
  // The FINISHING pass runs SOLO (no parallel batch lanes competing), and its
  // grade/blend filters are slice-threadable, so it can spread the filtergraph
  // across the otherwise-idle cores. ffmpeg's default isn't always aggressive
  // here, so allow an explicit override via FFMPEG_FILTER_THREADS (opt-in; only
  // applied on the finish pass — never on the parallel batches, which must stay
  // thread-capped). Must precede -filter_complex.
  const filterThreadArgs =
    hasFinish && process.env.FFMPEG_FILTER_THREADS
      ? ['-filter_complex_threads', process.env.FFMPEG_FILTER_THREADS]
      : [];
  const build = (nvenc: boolean): string[] => [
    ...inputs,
    ...extraInputs,
    ...filterThreadArgs,
    '-filter_complex', filterGraph,
    '-map', `[${finalV}]`,
    ...audioArgs,
    '-c:v', nvenc ? 'h264_nvenc' : 'libx264',
    ...(nvenc ? ['-preset', nvencPreset, '-cq', nvencCq] : ['-preset', x264Preset, '-crf', x264Crf]),
    ...(nvenc ? [] : threadArgs),
    ...profileArgs,
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outPath,
  ];

  try {
    await ffmpeg(build(!!opts.nvenc));
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    const isNvenc =
      opts.nvenc &&
      /nvenc|nvcuda|cuda|gpu/i.test(msg) &&
      !/permission|disk full/i.test(msg);
    if (!isNvenc) throw err;
    // eslint-disable-next-line no-console
    console.warn('[xfadeChain] NVENC failed, retrying with libx264. Reason:', msg.slice(0, 200));
    await ffmpeg(build(false));
  }
}
