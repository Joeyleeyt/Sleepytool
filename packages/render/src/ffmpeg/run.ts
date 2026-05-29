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
