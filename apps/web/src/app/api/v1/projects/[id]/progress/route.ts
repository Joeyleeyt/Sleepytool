import { NextResponse } from 'next/server';
import { assetsRepo, generationsRepo, projectsRepo, shotsRepo } from '@emberforge/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Provider grouping mirrors /scenes: a shot's two "legs" are visual and
// narration. A leg counts as failed only when it has a recorded failure AND no
// asset has landed for it (a later retry that succeeded supersedes the failure).
const VISUAL_PROVIDERS = new Set(['veo3', '69labs.video', '69labs.image']);
const NARRATION_PROVIDERS = new Set(['69labs.tts']);

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const { id } = params;

  const [project, shots, assets, failedGenerations] = await Promise.all([
    projectsRepo.findById(id),
    shotsRepo.findByProject(id),
    assetsRepo.findByProject(id),
    generationsRepo.findFailedByProject(id),
  ]);

  if (!project) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const assetsByShot = new Map<string, typeof assets>();
  for (const a of assets) {
    if (!a.shotId) continue;
    const arr = assetsByShot.get(a.shotId) ?? [];
    arr.push(a);
    assetsByShot.set(a.shotId, arr);
  }

  // Which legs have a recorded failure, per shot.
  const failedLegsByShot = new Map<string, { visual: boolean; narration: boolean }>();
  for (const g of failedGenerations) {
    if (!g.shotId) continue;
    const slot = failedLegsByShot.get(g.shotId) ?? { visual: false, narration: false };
    if (VISUAL_PROVIDERS.has(g.provider)) slot.visual = true;
    else if (NARRATION_PROVIDERS.has(g.provider)) slot.narration = true;
    failedLegsByShot.set(g.shotId, slot);
  }

  // `ready`  — both assets present (fully succeeded).
  // `failed` — blocked: a leg failed and its asset never landed (and the shot
  //            isn't already ready via a successful retry).
  // `resolved` = ready + failed — shots that have finished generating either
  // way. The bottom progress bar fills to 100% when resolved === total so a
  // permanent failure no longer stalls it short.
  let ready = 0;
  let failed = 0;
  for (const shot of shots) {
    const a = assetsByShot.get(shot.id) ?? [];
    const hasVisual = a.some((x) => x.kind === 'video_clip' || x.kind === 'image');
    const hasNarration = a.some((x) => x.kind === 'audio_narration');
    if (hasVisual && hasNarration) {
      ready += 1;
      continue;
    }
    const f = failedLegsByShot.get(shot.id);
    const visualFailed = !!f?.visual && !hasVisual;
    const narrationFailed = !!f?.narration && !hasNarration;
    if (visualFailed || narrationFailed) failed += 1;
  }

  return NextResponse.json({
    status: project.status,
    shots: { total: shots.length, ready, failed, resolved: ready + failed },
    updatedAt: project.updatedAt,
  });
}
