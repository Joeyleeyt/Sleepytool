import os from 'node:os';
import path from 'node:path';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { ffmpeg } from './run.js';
import { cinematicGrade, isCinematicGradeEnabled, planEmberOverlay } from './filters.js';

export interface FinalEncodeOpts {
  videoPath: string;
  audioPath: string;
  subtitlesPath?: string;
  outPath: string;
  nvenc?: boolean;
  res: '1920x1080' | '3840x2160';
  fps: 24 | 30 | 60;
  /**
   * When true, the master already has the global grade + ember overlay baked in
   * (the sleep renderer does this in its finishing pass), so this stage must NOT
   * re-apply them — that would double-grade. It stream-copies instead (or, when
   * burning subtitles, re-encodes with subs only). This is what turns the final
   * stage from a full re-encode into a near-instant mux.
   */
  videoFinished?: boolean;
}

export async function finalEncode(opts: FinalEncodeOpts): Promise<void> {
  const [w, h] = opts.res.split('x');
  // If the master is already finished, the grade + overlay are baked in — treat
  // them as off here so we don't apply them twice (and so the fast stream-copy
  // path below is reachable).
  const grade = opts.videoFinished ? false : isCinematicGradeEnabled();
  const overlay = opts.videoFinished ? null : planEmberOverlay(Number(w), Number(h), opts.fps);

  // FAST PATH — nothing to render onto the master: no subtitle burn-in, no grade
  // (CINEMATIC_GRADE=false) AND no ember/light-leak overlay (CINEMATIC_OVERLAY=off).
  //
  // `mixClips`/`buildSleepMaster` already produced `videoPath` as a finished
  // H.264 yuv420p stream at the target resolution. When we touch none of the
  // above, re-encoding it again just to attach the narration track is a wasted
  // full second encode — hours of CPU on a 2-hour 1080p timeline for a
  // pixel-identical result. So stream-COPY the video and only (cheaply)
  // transcode the narration WAV to AAC.
  //
  // The global grade (Issue #3) and the ember/light-leak overlay are
  // intentionally applied HERE, once, to the finished master — the single point
  // every render path flows through — so every scene shares an identical look.
  // Both require a real video encode, so enabling either (grade is on by
  // default) opts out of the stream-copy fast path.
  if (!opts.subtitlesPath && !grade && !overlay) {
    try {
      await ffmpeg([
        '-y',
        '-i', opts.videoPath,
        '-i', opts.audioPath,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '256k',
        // No -shortest: the composited master defines the timeline length, same
        // as the full-re-encode path below (mixed.wav is built to totalDurS, so
        // they already match — this just guards against trimming the video if
        // the narration mix lands a few ms short).
        '-movflags', '+faststart',
        opts.outPath,
      ]);
      return;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        '[finalEncode] stream-copy mux failed, falling back to full re-encode:',
        (err as Error).message?.slice(0, 200),
      );
    }
  }

  // ffmpeg's `subtitles=` filter is notoriously fragile with Windows paths
  // containing parens, spaces, or colons. Copy the .ass into a "safe" temp
  // location with only [a-z0-9_] in the path before invoking ffmpeg.
  let safeSubs: string | null = null;
  if (opts.subtitlesPath) {
    const safeDir = path.join(os.tmpdir(), 'emberforge_subs');
    await mkdir(safeDir, { recursive: true });
    safeSubs = path.join(safeDir, `s_${Date.now()}.ass`);
    await copyFile(opts.subtitlesPath, safeSubs);
  }

  // Build ONE filter_complex applied in layered order:
  //   grade  →  ember/light-leak overlay  →  subtitles
  // The grade goes first (sets the look); the warm overlay is screen-blended on
  // top of the graded image; subtitles are burned LAST so text sits above both
  // the vignette and the embers and stays fully readable. We need
  // filter_complex (not -vf) because the overlay can pull in a second input (the
  // looped ember asset), which a simple -vf graph can't reference.
  //
  // The ember asset, when used, is appended AFTER the audio input, so it is
  // ffmpeg input index 2 (0=video, 1=audio, 2=overlay asset).
  const OVERLAY_ASSET_INDEX = 2;
  const fc: string[] = [];
  let vlab = '0:v';
  if (grade) {
    fc.push(`[${vlab}]${cinematicGrade()}[fc_grade]`);
    vlab = 'fc_grade';
  }
  if (overlay) {
    fc.push(overlay.build(vlab, 'fc_overlay', OVERLAY_ASSET_INDEX));
    vlab = 'fc_overlay';
  }
  if (safeSubs) {
    fc.push(`[${vlab}]subtitles=${escapeForFilter(safeSubs)}[fc_subs]`);
    vlab = 'fc_subs';
  }
  if (fc.length === 0) {
    fc.push(`[${vlab}]scale=${w}:${h}[fc_scale]`);
    vlab = 'fc_scale';
  }
  const filterComplex = fc.join(';');

  // eslint-disable-next-line no-console
  console.log(
    `[finalEncode] re-encode master: grade=${grade} overlay=${overlay?.kind ?? 'off'} subs=${!!safeSubs}`,
  );

  // H.264 (AVC) high-profile, level 4.2 — universally playable in browsers
  // (<video> tag works in Chrome / Firefox / Safari / Edge without plugins).
  // yuv420p 8-bit is mandatory for browser playback; 10-bit / HEVC is not.
  //
  // Speed/quality env knobs:
  //   FFMPEG_X264_PRESET = ultrafast|superfast|veryfast|faster|fast|medium|slow
  //     - default 'medium' (good quality/speed balance)
  //     - drop to 'veryfast' for ~2× faster review renders
  //   FFMPEG_X264_CRF    = 0..51 (lower = better quality)
  //     - default 20 (visually lossless-ish)
  //     - 23 is the libx264 default; 26-28 fine for review renders
  const x264Preset = process.env.FFMPEG_X264_PRESET ?? 'medium';
  const x264Crf = process.env.FFMPEG_X264_CRF ?? '20';
  const nvencPreset = process.env.FFMPEG_NVENC_PRESET ?? 'p6';
  const nvencCq = process.env.FFMPEG_NVENC_CQ ?? '21';
  const args = [
    '-y',
    '-i', opts.videoPath,
    '-i', opts.audioPath,
    ...(overlay?.inputArgs ?? []), // looped ember asset → input index 2 (if any)
    '-filter_complex', filterComplex,
    '-map', `[${vlab}]`,
    '-map', '1:a:0',
    '-r', String(opts.fps),
    '-c:v', opts.nvenc ? 'h264_nvenc' : 'libx264',
    ...(opts.nvenc
      ? ['-preset', nvencPreset, '-rc', 'vbr', '-cq', nvencCq, '-b:v', '12M', '-maxrate', '18M', '-bufsize', '24M']
      : ['-preset', x264Preset, '-crf', x264Crf]),
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-level:v', '4.2',
    '-c:a', 'aac', '-b:a', '256k',
    '-movflags', '+faststart',
    opts.outPath,
  ];

  try {
    try {
      await ffmpeg(args);
    } catch (err) {
      // NVENC fails on machines without a recent NVIDIA GPU + drivers — the
      // error usually mentions "No NVENC capable devices found",
      // "h264_nvenc", or "Cannot load nvcuda". Retry with libx264 transparently
      // so a render never aborts because of a missing GPU.
      const msg = (err as Error).message ?? String(err);
      const isNvenc =
        opts.nvenc &&
        /nvenc|nvcuda|cuda|gpu/i.test(msg) &&
        !/permission|disk full/i.test(msg);
      if (!isNvenc) throw err;
      // eslint-disable-next-line no-console
      console.warn('[finalEncode] NVENC failed, retrying with libx264. Reason:', msg.slice(0, 200));
      const fallback = args.map((a) => (a === 'h264_nvenc' ? 'libx264' : a));
      // Replace NVENC-specific flags with x264 equivalents.
      const cleaned = stripNvencFlagsKeepX264(fallback, x264Preset, x264Crf);
      await ffmpeg(cleaned);
    }
  } finally {
    if (safeSubs) await rm(safeSubs, { force: true }).catch(() => {});
  }
}

function stripNvencFlagsKeepX264(args: string[], preset: string, crf: string): string[] {
  // Drop NVENC-only flags (-rc / -cq / -maxrate / -bufsize / -b:v) and add
  // libx264's -preset / -crf in their place. The first appearance of the
  // codec arg (h264_nvenc → libx264) was already rewritten by the caller.
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-rc' || a === '-cq' || a === '-maxrate' || a === '-bufsize' || a === '-b:v') {
      i++; // skip the value
      continue;
    }
    if (a === '-preset') {
      out.push('-preset', preset);
      i++;
      continue;
    }
    out.push(a);
  }
  if (!out.includes('-crf')) {
    const insertAt = out.indexOf('-preset') + 2;
    out.splice(insertAt > 1 ? insertAt : out.length - 1, 0, '-crf', crf);
  }
  return out;
}

function escapeForFilter(p: string): string {
  // forward slashes, escape colon, escape backslash, escape single quote.
  // Paths from os.tmpdir() avoid parens + spaces so the rest is fine.
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}
