const AVG_WORDS_PER_SECOND = 150 / 60; // 2.5

export function estimateNarrationDuration(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return words / AVG_WORDS_PER_SECOND;
}

export function splitSentences(text: string): string[] {
  return text
    .replace(/([.!?])\s+/g, '$1\n')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

const VISUAL_BEAT_RE = /\b(imagine|picture|consider|suddenly|but then|now|behold|envision|recall)\b/i;
export function isVisualBeat(sentence: string): boolean {
  return VISUAL_BEAT_RE.test(sentence);
}

/**
 * Pack sentences into shot-sized buckets honoring min/max duration and natural
 * visual-beat breakpoints. Returns chunks of narration text.
 */
export function packShots(
  sentences: string[],
  opts: { minS?: number; maxS?: number; preferredS?: number } = {},
): { text: string; durationS: number }[] {
  const min = opts.minS ?? 5;
  const max = opts.maxS ?? 12;
  const target = opts.preferredS ?? 8;
  const out: { text: string; durationS: number }[] = [];

  let buf: string[] = [];
  let bufDur = 0;
  for (const s of sentences) {
    const d = estimateNarrationDuration(s);
    const wouldOverflow = bufDur + d > max;
    const atBreakpoint = bufDur >= min && (isVisualBeat(s) || bufDur >= target);
    if (buf.length > 0 && (wouldOverflow || atBreakpoint)) {
      out.push({ text: buf.join(' '), durationS: bufDur });
      buf = [s];
      bufDur = d;
    } else {
      buf.push(s);
      bufDur += d;
    }
  }
  if (buf.length) out.push({ text: buf.join(' '), durationS: bufDur });
  return out;
}

/**
 * Split narration into shot-sized chunks at SENTENCE boundaries.
 *
 * One sentence == one shot. When a sentence is too short to stand on its own
 * (its estimated narration duration is below `minS`), the following sentence(s)
 * are tapped onto it until the shot reaches `minS` — so a shot may end up
 * consisting of 2-3 short sentences. Sentences are never split mid-sentence.
 * A too-short trailing remainder is folded back into the previous shot rather
 * than emitted as a runt clip.
 *
 * This is the per-shot pacing used by the LLM classify stage: the boundaries
 * are decided here (deterministically, by meaning-preserving sentence units)
 * and the LLM only assigns the cinematic treatment for each resulting chunk.
 */
export function packBySentence(
  text: string,
  opts: { minS?: number } = {},
): { text: string; durationS: number }[] {
  const min = opts.minS ?? 5;
  const sentences = splitSentences(text);
  const out: { text: string; durationS: number }[] = [];

  let buf: string[] = [];
  let bufDur = 0;
  for (const s of sentences) {
    buf.push(s);
    bufDur += estimateNarrationDuration(s);
    // Emit the shot once it's long enough to be meaningful; otherwise keep
    // tapping the next sentence onto it.
    if (bufDur >= min) {
      out.push({ text: buf.join(' '), durationS: bufDur });
      buf = [];
      bufDur = 0;
    }
  }
  // Leftover sentences that never reached `min`: fold them into the previous
  // shot so we never emit a runt. If there's no previous shot (the whole text
  // is shorter than `min`), emit the single short shot as-is.
  if (buf.length > 0) {
    if (out.length > 0) {
      const last = out[out.length - 1]!;
      last.text = `${last.text} ${buf.join(' ')}`;
      last.durationS += bufDur;
    } else {
      out.push({ text: buf.join(' '), durationS: bufDur });
    }
  }
  return out;
}
