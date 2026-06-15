import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ffmpeg, ffprobeHasAudio } from './run.js';
import { concatDemuxer } from './concat.js';
import { isImageInput } from './shotComposite.js';
import { kenBurnsFilter, type KenBurnsMode } from './kenBurns.js';
import { coverScaleCrop } from './filters.js';

export interface MixSegment {
  /** Source file: a video clip (.mp4/.mov/…) or a still image (.png/.jpg/…). */
  path: string;
  /** Target duration in seconds. Required for images; for videos, trims the
   *  clip to this length (omit to keep the full source duration). */
  durationS?: number;
  /** Ken Burns motion for image segments. Ignored for video segments. */
  kenBurns?: KenBurnsMode;
}

export interface MixClipsOpts {
  segments: MixSegment[];
  outPath: string;
  /** Target resolution — assumed to match the (already 1K/HD) inputs, so no
   *  upscaling-from-low-res handling is done; images/videos are only fit to
   *  this frame. */
  width: number;
  height: number;
  fps: number;
  nvenc?: boolean;
  /** Scratch dir for per-segment intermediates. Defaults to outPath's dir. */
  workDir?: string;
  /** How many segments to prepare in parallel. Defaults to 4. */
  concurrency?: number;
}

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

const AUDIO_SR = 48000;

// `capThreads` is set ONLY for the per-image segment encodes, which run
// MANY-in-parallel (RENDER_MIX_CONCURRENCY processes). libx264 defaults to one
// thread per core, so N parallel encodes ⇒ N×cores threads thrashing the
// scheduler — capping threads-per-encode (default 2) keeps the total near the
// core count. The single-pass concat-filter FALLBACK leaves it unset so that
// one whole-timeline encode can use every core. FFMPEG_INTERMEDIATE_THREADS=0
// disables the cap entirely (x264 auto-picks).
function intermediateEncodeArgs(nvenc: boolean, capThreads = false): string[] {
  // Intermediates are concat'd losslessly, so quality here is the final quality.
  // A single fast pass (no FX); image stills get Ken Burns and video clips get
  // cover-scaled to the frame (Fix #2 — every clip fills 16:9, no bars).
  const x264Preset = process.env.FFMPEG_INTERMEDIATE_PRESET ?? process.env.FFMPEG_X264_PRESET ?? 'veryfast';
  const x264Crf = process.env.FFMPEG_INTERMEDIATE_CRF ?? process.env.FFMPEG_X264_CRF ?? '20';
  const nvencPreset = process.env.FFMPEG_NVENC_PRESET ?? 'p6';
  const nvencCq = process.env.FFMPEG_NVENC_CQ ?? '20';
  const x264Threads = process.env.FFMPEG_INTERMEDIATE_THREADS ?? '1';
  const threadArgs = capThreads && x264Threads !== '0' ? ['-threads', x264Threads] : [];
  return nvenc
    ? ['-c:v', 'h264_nvenc', '-preset', nvencPreset, '-cq', nvencCq]
    : ['-c:v', 'libx264', '-preset', x264Preset, '-crf', x264Crf, ...threadArgs];
}

const NVENC_RE = /nvenc|nvcuda|cuda|gpu/i;
const NON_NVENC_RE = /permission|disk full|no space/i;
function isNvencFailure(nvenc: boolean | undefined, err: unknown): boolean {
  if (!nvenc) return false;
  const msg = (err as Error)?.message ?? String(err);
  return NVENC_RE.test(msg) && !NON_NVENC_RE.test(msg);
}

/**
 * Encode one still image into an HD video segment with Ken Burns motion and a
 * silent stereo audio track (so every concat segment has matching streams).
 */
async function prepImageSegment(seg: MixSegment, opts: MixClipsOpts, outPath: string): Promise<void> {
  const durationS = seg.durationS;
  if (!durationS || durationS <= 0) throw new Error(`image segment needs a durationS: ${seg.path}`);

  const build = (nvenc: boolean): string[] => [
    '-y',
    '-loop', '1', '-framerate', String(opts.fps), '-t', String(durationS), '-i', seg.path,
    '-f', 'lavfi', '-t', String(durationS), '-i', `anullsrc=channel_layout=stereo:sample_rate=${AUDIO_SR}`,
    '-filter_complex', kenBurnsFilter({
      mode: seg.kenBurns ?? 'in',
      width: opts.width,
      height: opts.height,
      durationS,
      fps: opts.fps,
      outputLabel: 'v',
      suffix: ',format=yuv420p',
    }),
    '-map', '[v]', '-map', '1:a',
    '-r', String(opts.fps),
    '-t', String(durationS),
    ...intermediateEncodeArgs(nvenc, true), // capThreads: many-in-parallel
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', String(AUDIO_SR),
    '-movflags', '+faststart',
    outPath,
  ];

  try {
    await ffmpeg(build(!!opts.nvenc));
  } catch (err) {
    if (!isNvencFailure(opts.nvenc, err)) throw err;
    await ffmpeg(build(false));
  }
}

/**
 * Normalize a video segment to the exact target frame. The clip is COVER-scaled
 * + cropped to w×h (no black bars / letterboxing — see Fix #2) and re-encoded to
 * the uniform intermediate codec/pixfmt/fps so the lossless demuxer concat
 * always succeeds. (The old fast path stream-copied the source untouched, which
 * left non-target-aspect 69labs clips with bars and broke the demuxer concat.)
 * A silent track is synthesised when the clip has no audio so the stream layout
 * matches the image segments.
 */
async function prepVideoSegment(seg: MixSegment, opts: MixClipsOpts, outPath: string): Promise<void> {
  const hasAudio = await ffprobeHasAudio(seg.path);
  const trim = seg.durationS && seg.durationS > 0 ? ['-t', String(seg.durationS)] : [];
  const vf = `${coverScaleCrop(opts.width, opts.height, opts.fps)},format=yuv420p`;

  const build = (nvenc: boolean): string[] => [
    '-y',
    '-i', seg.path,
    ...(hasAudio ? [] : ['-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=${AUDIO_SR}`]),
    ...trim,
    '-map', '0:v:0', '-map', hasAudio ? '0:a:0' : '1:a:0',
    '-vf', vf,
    '-r', String(opts.fps),
    ...intermediateEncodeArgs(nvenc, true), // capThreads: many-in-parallel
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', String(AUDIO_SR),
    ...(hasAudio ? [] : ['-shortest']),
    '-movflags', '+faststart',
    outPath,
  ];

  try {
    await ffmpeg(build(!!opts.nvenc));
  } catch (err) {
    if (!isNvencFailure(opts.nvenc, err)) throw err;
    await ffmpeg(build(false));
  }
}

/**
 * Single-pass fallback: re-encode every segment through one concat filter graph.
 * Used only when the lossless demuxer concat rejects the prepared segments
 * (e.g. source videos with a codec/pixfmt that doesn't match the image encodes).
 */
async function mixViaConcatFilter(opts: MixClipsOpts): Promise<void> {
  const { width: w, height: h, fps } = opts;
  const inputs: string[] = ['-y'];
  const vparts: string[] = [];
  const aparts: string[] = [];
  const labels: string[] = [];

  let idx = 0;
  for (const seg of opts.segments) {
    const dur = seg.durationS;
    if (isImageInput(seg.path)) {
      if (!dur || dur <= 0) throw new Error(`image segment needs a durationS: ${seg.path}`);
      inputs.push('-loop', '1', '-framerate', String(fps), '-t', String(dur), '-i', seg.path);
      // Same shared anti-shake Ken Burns as the fast path.
      vparts.push(
        kenBurnsFilter({
          mode: seg.kenBurns ?? 'in',
          width: w,
          height: h,
          durationS: dur,
          fps,
          inputLabel: `${idx}:v`,
          outputLabel: `v${idx}`,
          suffix: ',format=yuv420p,setpts=PTS-STARTPTS',
        }),
      );
      aparts.push(
        `anullsrc=channel_layout=stereo:sample_rate=${AUDIO_SR},atrim=0:${dur},asetpts=PTS-STARTPTS[a${idx}]`,
      );
    } else {
      inputs.push('-i', seg.path);
      const trimV = dur && dur > 0 ? `,trim=0:${dur}` : '';
      vparts.push(
        `[${idx}:v]${coverScaleCrop(w, h, fps)},format=yuv420p${trimV},setpts=PTS-STARTPTS[v${idx}]`,
      );
      const trimA = dur && dur > 0 ? `,atrim=0:${dur}` : '';
      // eslint-disable-next-line no-await-in-loop
      const hasAudio = await ffprobeHasAudio(seg.path);
      aparts.push(
        hasAudio
          ? `[${idx}:a]aresample=${AUDIO_SR}${trimA},asetpts=PTS-STARTPTS[a${idx}]`
          : `anullsrc=channel_layout=stereo:sample_rate=${AUDIO_SR}${dur ? `,atrim=0:${dur}` : ''},asetpts=PTS-STARTPTS[a${idx}]`,
      );
    }
    labels.push(`[v${idx}][a${idx}]`);
    idx++;
  }

  const n = opts.segments.length;
  const filter = [...vparts, ...aparts, `${labels.join('')}concat=n=${n}:v=1:a=1[outv][outa]`].join(';');

  const build = (nvenc: boolean): string[] => [
    ...inputs,
    '-filter_complex', filter,
    '-map', '[outv]', '-map', '[outa]',
    '-r', String(fps),
    ...intermediateEncodeArgs(nvenc),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', String(AUDIO_SR),
    '-movflags', '+faststart',
    opts.outPath,
  ];

  try {
    await ffmpeg(build(!!opts.nvenc));
  } catch (err) {
    if (!isNvencFailure(opts.nvenc, err)) throw err;
    await ffmpeg(build(false));
  }
}

/**
 * Mix an ordered list of video clips and still images into a single HD video.
 *
 * Each segment is normalised to the SAME target frame, codec and pixel format:
 * image segments get jitter-free Ken Burns, video segments get cover-scaled +
 * cropped to fill the 16:9 frame (Fix #2 — no black bars / letterboxing). Both
 * carry an audio track (clips keep their own; silent stereo is synthesised for
 * images and audio-less clips). The uniform segments are then joined with the
 * lossless concat demuxer.
 *
 * Fallback: if the prepared segments still can't be demuxer-concatenated, the
 * whole timeline is rebuilt in a single concat-filter re-encode pass.
 */
export async function mixClips(opts: MixClipsOpts): Promise<void> {
  if (opts.segments.length === 0) throw new Error('mixClips: no segments');
  const workDir = opts.workDir ?? path.join(path.dirname(opts.outPath), 'mix_segments');
  await mkdir(workDir, { recursive: true });

  // 1) Prepare each segment to a uniform container (images get Ken Burns,
  //    videos get cover-scaled). Runs in parallel; order preserved for concat.
  const prepared = await mapLimit(opts.segments, opts.concurrency ?? 4, async (seg, i) => {
    const segOut = path.join(workDir, `seg_${i.toString().padStart(4, '0')}.mp4`);
    if (isImageInput(seg.path)) {
      await prepImageSegment(seg, opts, segOut);
    } else {
      await prepVideoSegment(seg, opts, segOut);
    }
    return segOut;
  });

  // 2) Lossless join. Falls back to a single re-encode pass on param mismatch.
  try {
    await concatDemuxer(prepared, opts.outPath);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[mixClips] demuxer concat failed, re-encoding via concat filter:', (err as Error).message?.slice(0, 200));
    await mixViaConcatFilter(opts);
  }
}
