import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ffmpeg, ffprobeDuration, extractLastFrame } from './run.js';
import { buildXfadeChain, concatDemuxer, type XfadeStep } from './concat.js';
import { isImageInput } from './shotComposite.js';
import { kenBurnsFilter } from './kenBurns.js';
import { coverScaleCrop } from './filters.js';

/**
 * One clip in the sleep timeline. Lengths are pre-computed by the caller so that
 * the crossfade overlaps cancel and the master comes out exactly as long as the
 * narration (see render-worker `renderSleepMaster`). This module only realises
 * each clip to its exact length and dissolves the lot together.
 */
export interface SleepClip {
  /** Local source file — an AI video clip or a still image. */
  sourcePath: string;
  /**
   * Exact length of this clip on the timeline, INCLUDING the trailing crossfade
   * overlap with the next clip. The renderer guarantees the produced segment is
   * this long: a short video is extended by holding a frozen, slowly-drifting
   * last frame (never cut early); a long video is trimmed to fit.
   */
  targetDurationS: number;
  /** Crossfade overlap (seconds) of the dissolve INTO this clip. 0 for the
   *  first clip — nothing precedes it. */
  crossfadeInS: number;
  /** ffmpeg xfade transition name. The sleep renderer forces 'fade' (a cross
   *  dissolve); kept here so future per-scene transition types can be wired in
   *  without touching this module. */
  transition?: string;
  /** Sequential index — only used to vary the (imperceptible) pan direction so
   *  long runs of stills don't all drift the same way. */
  index: number;
}

export interface BuildSleepMasterOpts {
  clips: SleepClip[];
  outPath: string;
  width: number;
  height: number;
  fps: number;
  nvenc?: boolean;
  /** Ken Burns zoom ceiling for stills and frozen tails. 1.02 = a 2% push over
   *  the whole clip — keep it tiny; the goal is barely-perceptible drift. */
  maxZoom?: number;
  /** Scratch dir for per-clip intermediates. Defaults to outPath's dir. */
  workDir?: string;
  /** How many clips to realise in parallel. Defaults to 4. */
  concurrency?: number;
}

const DEFAULT_MAX_ZOOM = 1.02;
// Below this, a video is treated as "fully covers its slot" and just trimmed —
// avoids producing a sub-frame freeze tail for rounding noise.
const FREEZE_EPSILON_S = 0.08;

/** Run `fn` over `items` with a bounded pool; results keep input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i]!, i);
    }
  };
  const pool = Math.min(Math.max(1, limit), items.length || 1);
  await Promise.all(Array.from({ length: pool }, () => worker()));
  return results;
}

function intermediateEncodeArgs(nvenc: boolean): string[] {
  const x264Preset = process.env.FFMPEG_INTERMEDIATE_PRESET ?? process.env.FFMPEG_X264_PRESET ?? 'veryfast';
  const x264Crf = process.env.FFMPEG_INTERMEDIATE_CRF ?? process.env.FFMPEG_X264_CRF ?? '20';
  const nvencPreset = process.env.FFMPEG_NVENC_PRESET ?? 'p6';
  const nvencCq = process.env.FFMPEG_NVENC_CQ ?? '20';
  return nvenc
    ? ['-c:v', 'h264_nvenc', '-preset', nvencPreset, '-cq', nvencCq]
    : ['-c:v', 'libx264', '-preset', x264Preset, '-crf', x264Crf];
}

const NVENC_RE = /nvenc|nvcuda|cuda|gpu/i;
const NON_NVENC_RE = /permission|disk full|no space/i;
async function runWithNvencFallback(build: (nvenc: boolean) => string[], nvenc: boolean): Promise<void> {
  try {
    await ffmpeg(build(nvenc));
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (!(nvenc && NVENC_RE.test(msg) && !NON_NVENC_RE.test(msg))) throw err;
    // eslint-disable-next-line no-console
    console.warn('[sleepRender] NVENC failed, retrying with libx264. Reason:', msg.slice(0, 200));
    await ffmpeg(build(false));
  }
}

/** Render a still image into a `durationS`-long, silent, target-res clip with a
 *  barely-perceptible Ken Burns move. Used for image assets and frozen tails.
 *
 *  The motion uses the shared, jitter-free `kenBurnsFilter` (see kenBurns.ts):
 *  an eased zoom up to `maxZoom` (≈1.02 — sub-perceptual) plus a slow pan whose
 *  direction alternates by index so long runs of stills don't all drift the
 *  same way. The heavy input oversample keeps zoompan's per-frame pixel floor
 *  sub-pixel, so there is no shimmer even on the slowest sleep-story pushes. */
async function prepStillSegment(
  srcImage: string,
  durationS: number,
  index: number,
  opts: BuildSleepMasterOpts,
  outPath: string,
): Promise<void> {
  const maxZoom = opts.maxZoom ?? DEFAULT_MAX_ZOOM;
  const build = (nvenc: boolean): string[] => [
    '-y',
    '-loop', '1', '-framerate', String(opts.fps), '-t', String(durationS), '-i', srcImage,
    '-filter_complex', kenBurnsFilter({
      mode: index % 2 === 0 ? 'right' : 'left',
      width: opts.width,
      height: opts.height,
      durationS,
      fps: opts.fps,
      maxZoom,
      outputLabel: 'v',
      suffix: ',format=yuv420p',
    }),
    '-map', '[v]',
    '-r', String(opts.fps),
    '-t', String(durationS),
    ...intermediateEncodeArgs(nvenc),
    '-pix_fmt', 'yuv420p',
    '-an',
    '-movflags', '+faststart',
    outPath,
  ];
  await runWithNvencFallback(build, !!opts.nvenc);
}

/** Normalise a source video to target res/fps/yuv420p, silent, trimmed to
 *  `durationS` (the source's own motion is preserved — no Ken Burns). */
async function prepVideoSegment(
  src: string,
  durationS: number,
  opts: BuildSleepMasterOpts,
  outPath: string,
): Promise<void> {
  const vf = `${coverScaleCrop(opts.width, opts.height, opts.fps)},format=yuv420p`;
  const build = (nvenc: boolean): string[] => [
    '-y',
    '-i', src,
    '-vf', vf,
    '-t', String(durationS),
    '-r', String(opts.fps),
    ...intermediateEncodeArgs(nvenc),
    '-pix_fmt', 'yuv420p',
    '-an',
    '-movflags', '+faststart',
    outPath,
  ];
  await runWithNvencFallback(build, !!opts.nvenc);
}

/**
 * Realise one clip to a single file of exactly `targetDurationS`:
 *  - image source        → slow Ken Burns over the full duration
 *  - video ≥ target      → trimmed to target
 *  - video < target      → full video, then a frozen, slowly-drifting last frame
 *                          held until the slot is full (never cut early)
 */
async function prepClip(clip: SleepClip, opts: BuildSleepMasterOpts, workDir: string, i: number): Promise<string> {
  const stem = `clip_${i.toString().padStart(5, '0')}`;
  const out = path.join(workDir, `${stem}.mp4`);
  const target = clip.targetDurationS;

  if (isImageInput(clip.sourcePath)) {
    await prepStillSegment(clip.sourcePath, target, clip.index, opts, out);
    return out;
  }

  const srcDur = await ffprobeDuration(clip.sourcePath).catch(() => 0);

  // Source covers (≈) the whole slot — just trim.
  if (srcDur >= target - FREEZE_EPSILON_S) {
    await prepVideoSegment(clip.sourcePath, target, opts, out);
    return out;
  }

  // Source is shorter than the slot. Extend continuity by holding a frozen,
  // slowly-drifting last frame until narration reaches the next clip.
  const liveLen = Math.max(0, srcDur);
  const padLen = target - liveLen;
  const stillImg = path.join(workDir, `${stem}_frame.png`);
  await extractLastFrame(clip.sourcePath, stillImg);

  // Degenerate case: an unreadable/zero-length video. Fall back to a pure still
  // hold of the extracted frame so the slot is still filled (no early cut).
  if (liveLen < FREEZE_EPSILON_S) {
    await prepStillSegment(stillImg, target, clip.index, opts, out);
    return out;
  }

  const videoPart = path.join(workDir, `${stem}_a.mp4`);
  const stillPart = path.join(workDir, `${stem}_b.mp4`);
  await prepVideoSegment(clip.sourcePath, liveLen, opts, videoPart);
  await prepStillSegment(stillImg, padLen, clip.index, opts, stillPart);
  // Both parts share res/fps/pixfmt/sar, so a lossless demuxer concat joins them.
  await concatDemuxer([videoPart, stillPart], out);
  return out;
}

/**
 * Build a single video-only master in which every clip cross-dissolves into the
 * next — a slow, hypnotic sleep-story sequence with no hard cuts.
 *
 * Clip lengths and overlaps are supplied by the caller (already solved so the
 * dissolves cancel out and the master matches the narration length exactly), so
 * this function's only jobs are: (1) realise each clip to its exact length,
 * extending short clips with frozen Ken Burns tails, and (2) chain them through
 * `buildXfadeChain` as crossfades. Audio is intentionally dropped — narration is
 * a separate master muxed in at final encode.
 */
export async function buildSleepMaster(opts: BuildSleepMasterOpts): Promise<void> {
  if (opts.clips.length === 0) throw new Error('buildSleepMaster: no clips');
  const workDir = opts.workDir ?? path.join(path.dirname(opts.outPath), 'sleep_segments');
  await mkdir(workDir, { recursive: true });

  // 1) Realise each clip to its exact slot length. Parallel; order preserved.
  const prepared = await mapLimit(opts.clips, opts.concurrency ?? 4, (clip, i) =>
    prepClip(clip, opts, workDir, i),
  );

  // 2) Chain the clips as crossfades. The first clip's overlap is ignored by
  //    buildXfadeChain; every other clip dissolves IN over its crossfadeInS.
  const steps: XfadeStep[] = opts.clips.map((c, i) => ({
    path: prepared[i]!,
    durationS: c.targetDurationS,
    xfade: c.transition ?? 'fade',
    overlapS: i === 0 ? 0 : c.crossfadeInS,
  }));

  await buildXfadeChain(steps, opts.outPath, { nvenc: opts.nvenc, audio: false });
}
