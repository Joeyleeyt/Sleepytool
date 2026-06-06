/**
 * Global-style anchor: a short fragment injected into EVERY shot's prompt so
 * the whole video keeps one consistent look and mood instead of drifting from
 * shot to shot. Built from the project-wide analyse result (`globalTopic`,
 * `toneSummary`) plus the current scene's `atmosphere`.
 *
 * This is the "world + mood" half of visual continuity; the recurring
 * character/environment descriptors are the other half and are handled
 * separately by `recallMemory()`. Keeping this string identical across
 * consecutive shots is what calms the stream down and stops it wandering.
 */
export interface StyleAnchorInput {
  globalTopic?: string | null;
  toneSummary?: string | null;
  atmosphere?: string | null;
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim().replace(/[.]+$/, '');
}

export function buildStyleAnchor(input: StyleAnchorInput): string {
  const world = input.globalTopic && clean(input.globalTopic);
  const lead = world
    ? `consistent cohesive visual world of ${world}`
    : 'consistent cohesive visual world across the whole film';

  const extra = [
    input.atmosphere && clean(input.atmosphere),
    input.toneSummary && `overall mood ${clean(input.toneSummary)}`,
  ].filter((x): x is string => Boolean(x && x.length));

  return [lead, ...extra].join(', ');
}
