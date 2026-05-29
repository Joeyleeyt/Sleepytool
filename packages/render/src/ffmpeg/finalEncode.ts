import os from 'node:os';
import path from 'node:path';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { ffmpeg } from './run.js';

export interface FinalEncodeOpts {
  videoPath: string;
  audioPath: string;
  subtitlesPath?: string;
  outPath: string;
  nvenc?: boolean;
  res: '1920x1080' | '3840x2160';
  fps: 24 | 30 | 60;
}

export async function finalEncode(opts: FinalEncodeOpts): Promise<void> {
  const [w, h] = opts.res.split('x');

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

  const vf = safeSubs ? `subtitles=${escapeForFilter(safeSubs)}` : `scale=${w}:${h}`;

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
    '-vf', vf,
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
    '-map', '0:v:0', '-map', '1:a:0',
    opts.outPath,
  ];

  try {
    await ffmpeg(args);
  } finally {
    if (safeSubs) await rm(safeSubs, { force: true }).catch(() => {});
  }
}

function escapeForFilter(p: string): string {
  // forward slashes, escape colon, escape backslash, escape single quote.
  // Paths from os.tmpdir() avoid parens + spaces so the rest is fine.
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}
