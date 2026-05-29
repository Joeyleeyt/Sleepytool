import type { Timeline } from '@emberforge/core';

const ASS_HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: 3840
PlayResY: 2160
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Inter,72,&H00FFFFFF,&H000000FF,&H80000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,2,2,160,160,180,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

function fmt(t: number): string {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${s}`;
}

export function buildAssSubtitles(timeline: Timeline, narrationByClip: Map<string, string>): string {
  const events: string[] = [];
  for (const clip of timeline.clips) {
    const text = (narrationByClip.get(clip.shotId) ?? '').replace(/\n/g, ' ').replace(/,/g, '\\,');
    if (!text) continue;
    events.push(`Dialogue: 0,${fmt(clip.startS)},${fmt(clip.endS)},Default,,0,0,0,,${text}`);
  }
  return ASS_HEADER + events.join('\n') + '\n';
}
