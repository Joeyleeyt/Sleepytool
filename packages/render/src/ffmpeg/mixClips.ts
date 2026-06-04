import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ffmpeg, ffprobeHasAudio } from './run.js';
import { concatDemuxer } from './concat.js';
import { isImageInput, type KenBurnsMode } from './shotComposite.js';

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

function evenFloor(n: number): number {
  return Math.floor(n / 2) * 2;
}

/**
 * zoompan z/x/y expressions for a Ken Burns move over `totalFrames`.
 *
 * The zoom is driven LINEARLY from the output-frame counter `on`, not the
 * recursive `zoom+step` accumulator. The recursive form re-reads the previous
 * frame's already integer-quantized zoom, so its per-frame step is never
 * exactly uniform (a subtle source of unevenness); an `on`-based ramp advances
 * by an identical delta every frame.
 *
 * Centered moves keep x/y at the crop center. zoompan still floors x/y to whole
 * INPUT pixels, so smoothness depends on the oversampled canvas built in
 * `imageVideoFilter` — there a 1px input step is sub-pixel in the final frame.
 */
function kenBurnsExpr(mode: KenBurnsMode, totalFrames: number): { zoom: string; x: string; y: string } {
  const zMax = 1.15;
  const frames = Math.max(1, totalFrames);
  // Linear 0 → (zMax-1) ramp over the clip. `on` is the output frame index.
  const up = `(${(zMax - 1).toFixed(6)}*on/${frames})`;
  const cx = '(iw-iw/zoom)/2';
  const cy = '(ih-ih/zoom)/2';
  switch (mode) {
    case 'out':
      return { zoom: `(${zMax}-${up})`, x: cx, y: cy };
    case 'left':
      // Pan only within the zoomed headroom (max offset = iw-iw/zoom). The old
      // `iw*(...)` ran the crop far past the right edge, where zoompan clamps it
      // and the pan visibly "sticks".
      return { zoom: `(1+${up})`, x: `(iw-iw/zoom)*(1-on/${frames})`, y: cy };
    case 'right':
      return { zoom: `(1+${up})`, x: `(iw-iw/zoom)*(on/${frames})`, y: cy };
    case 'none':
      // Truly static — a frozen still (used for freeze-frame holds).
      return { zoom: '1', x: cx, y: cy };
    case 'in':
    default:
      return { zoom: `(1+${up})`, x: cx, y: cy };
  }
}

/**
 * Build the still-image-as-video filter. Inputs are already 1K/HD, so there is
 * no upscaling-from-low-res logic; we only add a small oversample so zoompan's
 * integer-pixel crop stays smooth, then scale back to the target frame.
 * Output video label is [v].
 */
function imageVideoFilter(mode: KenBurnsMode, w: number, h: number, durationS: number, fps: number): string {
  const totalFrames = Math.max(1, Math.round(durationS * fps));
  // zoompan rounds its x/y crop offsets to whole INPUT pixels every frame. When
  // the input canvas is only ~target-size, that 1px rounding is ~1px of visible
  // jitter as the zoom ramps ⇒ the image "shakes" while zooming. Fix: feed
  // zoompan a heavily oversampled canvas so 1px of input rounding is sub-pixel in
  // the final frame, but keep zoompan's OUTPUT (s=) at the TARGET resolution —
  // zoompan's cost is driven by its output size, so a large input oversample
  // stays cheap and we drop the extra downscale pass entirely. Must stay above
  // the 1.15x max zoom; 3x renders smooth. Override with KENBURNS_OVERSAMPLE.
  const oversample = Math.max(2, Number(process.env.KENBURNS_OVERSAMPLE ?? '3'));
  const rw = evenFloor(w * oversample);
  const rh = evenFloor(h * oversample);
  const { zoom, x, y } = kenBurnsExpr(mode, totalFrames);
  return (
    `[0:v]scale=${rw}:${rh}:force_original_aspect_ratio=increase,crop=${rw}:${rh},` +
    `zoompan=z='${zoom}':x='${x}':y='${y}':d=${totalFrames}:s=${w}x${h}:fps=${fps},` +
    `setsar=1,format=yuv420p[v]`
  );
}

// `capThreads` is set ONLY for the per-image segment encodes, which run
// MANY-in-parallel (RENDER_MIX_CONCURRENCY processes). libx264 defaults to one
// thread per core, so N parallel encodes ⇒ N×cores threads thrashing the
// scheduler — capping threads-per-encode (default 2) keeps the total near the
// core count. The single-pass concat-filter FALLBACK leaves it unset so that
// one whole-timeline encode can use every core. FFMPEG_INTERMEDIATE_THREADS=0
// disables the cap entirely (x264 auto-picks).
function intermediateEncodeArgs(nvenc: boolean, capThreads = false): string[] {
  // Intermediates are concat'd losslessly, so quality here is the final quality.
  // Still a single fast pass — no FX, no re-encode of video segments.
  const x264Preset = process.env.FFMPEG_INTERMEDIATE_PRESET ?? process.env.FFMPEG_X264_PRESET ?? 'veryfast';
  const x264Crf = process.env.FFMPEG_INTERMEDIATE_CRF ?? process.env.FFMPEG_X264_CRF ?? '20';
  const nvencPreset = process.env.FFMPEG_NVENC_PRESET ?? 'p6';
  const nvencCq = process.env.FFMPEG_NVENC_CQ ?? '20';
  const x264Threads = process.env.FFMPEG_INTERMEDIATE_THREADS ?? '2';
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
    '-filter_complex', imageVideoFilter(seg.kenBurns ?? 'in', opts.width, opts.height, durationS, opts.fps),
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
 * Normalize a video segment for lossless concat. The video stream is always
 * stream-copied (inputs are already 1K/HD) — no re-encode. If the clip has no
 * audio, a silent track is added so its stream layout matches image segments.
 */
async function prepVideoSegment(seg: MixSegment, _opts: MixClipsOpts, outPath: string): Promise<void> {
  const hasAudio = await ffprobeHasAudio(seg.path);
  const trim = seg.durationS && seg.durationS > 0 ? ['-t', String(seg.durationS)] : [];

  const args = hasAudio
    ? ['-y', '-i', seg.path, ...trim, '-c', 'copy', '-movflags', '+faststart', outPath]
    : [
        '-y',
        '-i', seg.path,
        '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=${AUDIO_SR}`,
        ...trim,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', String(AUDIO_SR),
        '-shortest', '-movflags', '+faststart',
        outPath,
      ];
  await ffmpeg(args);
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
      const totalFrames = Math.max(1, Math.round(dur * fps));
      // Same anti-shake recipe as imageVideoFilter(): oversample the input canvas
      // so zoompan's integer x/y rounding is sub-pixel, output at target res.
      const oversample = Math.max(2, Number(process.env.KENBURNS_OVERSAMPLE ?? '3'));
      const rw = evenFloor(w * oversample);
      const rh = evenFloor(h * oversample);
      const { zoom, x, y } = kenBurnsExpr(seg.kenBurns ?? 'in', totalFrames);
      vparts.push(
        `[${idx}:v]scale=${rw}:${rh}:force_original_aspect_ratio=increase,crop=${rw}:${rh},` +
          `zoompan=z='${zoom}':x='${x}':y='${y}':d=${totalFrames}:s=${w}x${h}:fps=${fps},` +
          `setsar=1,format=yuv420p,setpts=PTS-STARTPTS[v${idx}]`,
      );
      aparts.push(
        `anullsrc=channel_layout=stereo:sample_rate=${AUDIO_SR},atrim=0:${dur},asetpts=PTS-STARTPTS[a${idx}]`,
      );
    } else {
      inputs.push('-i', seg.path);
      const trimV = dur && dur > 0 ? `,trim=0:${dur}` : '';
      vparts.push(
        `[${idx}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},` +
          `fps=${fps},setsar=1,format=yuv420p${trimV},setpts=PTS-STARTPTS[v${idx}]`,
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
 * Fast path: encode ONLY the image segments (Ken Burns at the target
 * resolution, no upscaling), stream-copy every video segment, then join the
 * lot with the lossless concat demuxer — so existing 1K/HD video is never
 * re-encoded. Video clips keep their own audio (silent tracks are synthesized
 * for images and audio-less clips so the stream layout is uniform).
 *
 * Fallback: if the prepared segments can't be demuxer-concatenated (codec or
 * pixel-format mismatch between source videos and the image encodes), the whole
 * timeline is rebuilt in a single concat-filter re-encode pass.
 */
export async function mixClips(opts: MixClipsOpts): Promise<void> {
  if (opts.segments.length === 0) throw new Error('mixClips: no segments');
  const workDir = opts.workDir ?? path.join(path.dirname(opts.outPath), 'mix_segments');
  await mkdir(workDir, { recursive: true });

  // 1) Prepare each segment to a uniform container (images encoded, videos
  //    copied). Runs in parallel; results keep order for the concat below.
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
