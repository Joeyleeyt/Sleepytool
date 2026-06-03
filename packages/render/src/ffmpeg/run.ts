import { execa } from 'execa';

export const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';

export async function ffmpeg(args: string[], opts: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  const res = await execa(FFMPEG, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  return { stdout: res.stdout, stderr: res.stderr };
}

export async function ffprobeDuration(path: string): Promise<number> {
  const res = await execa(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    path,
  ]);
  return Number.parseFloat(res.stdout.trim());
}

/** True if the file has at least one audio stream. Used by the mixer to decide
 *  whether a video clip can be stream-copied as-is or needs a silent track. */
export async function ffprobeHasAudio(path: string): Promise<boolean> {
  try {
    const res = await execa(FFPROBE, [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=index',
      '-of', 'csv=p=0',
      path,
    ]);
    return res.stdout.trim().length > 0;
  } catch {
    return false;
  }
}
