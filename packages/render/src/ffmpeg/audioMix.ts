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
 *
 * PERFORMANCE — narration assembly has two strategies:
 *
 *  • FAST (default, narration-only + non-overlapping): the narration for a sleep
 *    film is ONE clip per shot, placed at the shot's start time, so the tracks are
 *    sequential and don't overlap. We place them with a `concat` of
 *    gap-silence + track + gap-silence + …, which generates only the GAPS once
 *    (≈ the total duration) and never sums streams. This replaces the old
 *    per-track `adelay` (which materialised leading silence equal to each track's
 *    start time — for ~500 tracks that's the SUM of all start times, hundreds of
 *    hours of silence) feeding a single ~500-input `amix` (O(N) per sample). On a
 *    2-hour timeline that pushed the mix to ~1× realtime (~2 h); concat runs many×
 *    faster.
 *
 *  • LEGACY (`adelay` + `amix`): used when tracks overlap, when music beds are
 *    present (they need a real overlapping mix + sidechain duck), or when
 *    AUDIO_MIX_FAST=false. Correct for any layout, just slow at high track counts.
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

  // --- Narration → [nar] -----------------------------------------------------
  if (opts.narration.length === 0) {
    filters.push(`anullsrc=channel_layout=stereo:sample_rate=48000:duration=${opts.totalDurS}[nar]`);
  } else if (canConcatNarration(opts.narration, opts.music)) {
    filters.push(...buildConcatNarration(opts.narration, opts.totalDurS));
  } else {
    filters.push(...buildAmixNarration(opts.narration));
  }

  // --- Music beds → duck under narration → [out] -----------------------------
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

/** The fast concat path is valid only when there are no music beds (those need a
 *  real overlapping mix + sidechain duck) and the narration tracks don't overlap
 *  (concat is strictly sequential). Disable explicitly with AUDIO_MIX_FAST=false. */
function canConcatNarration(narration: MixTrack[], music: MixTrack[]): boolean {
  if (process.env.AUDIO_MIX_FAST === 'false') return false;
  if (music.length > 0) return false;
  const sorted = [...narration].sort((a, b) => a.startS - b.startS);
  for (let i = 1; i < sorted.length; i++) {
    // A 1 ms tolerance absorbs float/rounding noise at clip boundaries.
    if (sorted[i]!.startS < sorted[i - 1]!.startS + sorted[i - 1]!.durationS - 0.001) {
      return false; // overlap → fall back to amix (correct for any layout)
    }
  }
  return true;
}

/**
 * Sequential narration placement via `concat`: silence-gap → track → silence-gap …
 * Generates only the gaps (total ≈ the film length, ONCE) instead of one giant
 * leading-silence pad per track. `[nar]` is mono 48k to match the deliverable.
 */
function buildConcatNarration(narration: MixTrack[], totalDurS: number): string[] {
  const filters: string[] = [];
  const order = narration
    .map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.startS - b.t.startS);

  // `concat` requires EVERY segment to share the same sample format, channel
  // layout AND sample rate — otherwise it errors. Pin all of them (silence and
  // tracks alike) to the identical fltp/mono/48k so the join is always valid
  // regardless of each narration source's native format.
  const AFMT = 'aformat=sample_fmts=fltp:channel_layouts=mono:sample_rates=48000';

  const segLabels: string[] = [];
  let cursor = 0;
  let silenceN = 0;
  const silence = (durS: number): void => {
    if (durS <= 0.0005) return;
    const lbl = `sil${silenceN++}`;
    filters.push(`anullsrc=channel_layout=mono:sample_rate=48000:duration=${durS.toFixed(3)},${AFMT}[${lbl}]`);
    segLabels.push(`[${lbl}]`);
  };

  for (const { t, i } of order) {
    silence(t.startS - cursor); // gap before this track
    filters.push(
      `[${i}:a]aresample=48000,atrim=0:${t.durationS},asetpts=PTS-STARTPTS,volume=${t.gainDb}dB,${AFMT}[t${i}]`,
    );
    segLabels.push(`[t${i}]`);
    cursor = t.startS + t.durationS;
  }
  silence(totalDurS - cursor); // trailing gap to the full timeline length

  filters.push(`${segLabels.join('')}concat=n=${segLabels.length}:v=0:a=1[nar]`);
  return filters;
}

/** Legacy overlapping mix: per-track delay+gain, summed by a single amix. Correct
 *  for any layout (overlaps, music) but O(inputs) per sample + huge adelay pads. */
function buildAmixNarration(narration: MixTrack[]): string[] {
  const filters: string[] = [];
  narration.forEach((t, i) => {
    const ms = Math.round(t.startS * 1000);
    filters.push(
      `[${i}:a]aresample=48000,atrim=0:${t.durationS},asetpts=PTS-STARTPTS,adelay=${ms}|${ms},volume=${t.gainDb}dB[n${i}]`,
    );
  });
  const narrLabels = narration.map((_, i) => `[n${i}]`).join('');
  filters.push(`${narrLabels}amix=inputs=${narration.length}:normalize=0[nar]`);
  return filters;
}
