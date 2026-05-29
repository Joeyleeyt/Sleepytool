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
