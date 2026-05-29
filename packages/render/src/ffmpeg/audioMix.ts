import { ffmpeg } from './run.js';

export interface MixTrack {
  path: string;
  startS: number;
  durationS: number;
  gainDb: number;
  fadeInS?: number;
  fadeOutS?: number;
}

/**
 * Mix narration tracks and music beds into a single WAV.
 * Music is sidechain-ducked under narration via a separate pass.
 */
export async function mixAudio(opts: {
  narration: MixTrack[];
  music: MixTrack[];
  totalDurS: number;
  outPath: string;
}): Promise<void> {
  const inputs: string[] = ['-y'];
  const filters: string[] = [];

  opts.narration.forEach((t) => inputs.push('-i', t.path));
  opts.music.forEach((t) => inputs.push('-i', t.path));

  // narration tracks: delay + gain
  opts.narration.forEach((t, i) => {
    const ms = Math.round(t.startS * 1000);
    filters.push(
      `[${i}:a]aresample=48000,atrim=0:${t.durationS},asetpts=PTS-STARTPTS,adelay=${ms}|${ms},volume=${t.gainDb}dB[n${i}]`,
    );
  });
  const narrLabels = opts.narration.map((_, i) => `[n${i}]`).join('');
  if (opts.narration.length > 0) {
    filters.push(`${narrLabels}amix=inputs=${opts.narration.length}:normalize=0[nar]`);
  } else {
    filters.push(`anullsrc=channel_layout=stereo:sample_rate=48000:duration=${opts.totalDurS}[nar]`);
  }

  // music beds: delay, trim, gain, fades
  const musicOffset = opts.narration.length;
  opts.music.forEach((t, i) => {
    const ms = Math.round(t.startS * 1000);
    const fIn = t.fadeInS ?? 2;
    const fOut = t.fadeOutS ?? 2;
    filters.push(
      `[${musicOffset + i}:a]aresample=48000,atrim=0:${t.durationS},asetpts=PTS-STARTPTS,` +
        `adelay=${ms}|${ms},volume=${t.gainDb}dB,` +
        `afade=t=in:st=0:d=${fIn},afade=t=out:st=${Math.max(0, t.durationS - fOut)}:d=${fOut}[m${i}]`,
    );
  });
  const musicLabels = opts.music.map((_, i) => `[m${i}]`).join('');
  if (opts.music.length > 0) {
    filters.push(`${musicLabels}amix=inputs=${opts.music.length}:normalize=0[bed_raw]`);
    // sidechain duck music under narration
    filters.push(`[bed_raw][nar]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400[bed]`);
    filters.push(`[nar][bed]amix=inputs=2:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[out]`);
  } else {
    filters.push(`[nar]loudnorm=I=-16:TP=-1.5:LRA=11[out]`);
  }

  await ffmpeg([
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[out]',
    '-t', String(opts.totalDurS),
    '-c:a', 'pcm_s24le',
    '-ar', '48000',
    opts.outPath,
  ]);
}
