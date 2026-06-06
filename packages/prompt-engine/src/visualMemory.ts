import { visualMemoryRepo } from '@emberforge/db';
import type { Shot } from '@emberforge/core';

export type VisualMemoryKind = 'character' | 'environment' | 'palette' | 'style_token';

/**
 * Look up recurring characters/environments for this project and return a
 * comma-separated descriptor fragment to inject into the visual prompt.
 *
 * The naive implementation matches by keyword presence in narration text.
 * Swap in pgvector + embeddings later — the call signature stays the same.
 *
 * `opts.kinds` restricts which memory kinds may be injected. Callers building
 * people-free b-roll pass `['environment','palette','style_token']` so a
 * recurring *character* descriptor never lands in a "no people" prompt and
 * contradicts it. Omit to allow every kind (the default for hero image/video).
 */
export async function recallMemory(
  projectId: string,
  shot: Shot,
  opts?: { kinds?: VisualMemoryKind[] },
): Promise<string> {
  const all = await visualMemoryRepo.findByProject(projectId);
  if (all.length === 0) return '';

  const allow = opts?.kinds;
  const pool = allow ? all.filter((m) => allow.includes(m.kind as VisualMemoryKind)) : all;
  if (pool.length === 0) return '';

  const narr = shot.narrationText.toLowerCase();
  const summary = (shot.visualSummary ?? '').toLowerCase();

  const hits = pool.filter((m) => {
    const k = m.key.toLowerCase();
    return narr.includes(k) || summary.includes(k);
  });

  // Always inject palette + style tokens (they aren't keyword-gated)
  const always = pool.filter((m) => m.kind === 'palette' || m.kind === 'style_token');

  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of [...always, ...hits]) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m.descriptor);
  }
  return out.join(', ');
}

/** Persist a recurring entity discovered during analysis. */
export async function rememberEntity(input: {
  projectId: string;
  kind: 'character' | 'environment' | 'palette' | 'style_token';
  key: string;
  descriptor: string;
  referenceImageR2?: string;
}) {
  return visualMemoryRepo.upsert({
    projectId: input.projectId,
    kind: input.kind,
    key: input.key,
    descriptor: input.descriptor,
    referenceImageR2: input.referenceImageR2,
  });
}
