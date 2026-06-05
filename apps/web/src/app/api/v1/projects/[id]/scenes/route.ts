import { NextResponse } from 'next/server';
import { assetsRepo, generationsRepo, promptsRepo, scenesRepo, shotsRepo } from '@emberforge/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Provider IDs are grouped into "visual" vs "narration" so the UI can show one
// failure pill per affected leg even if the worker emits multiple attempts.
const VISUAL_PROVIDERS = new Set(['veo3', '69labs.video', '69labs.image']);
const NARRATION_PROVIDERS = new Set(['69labs.tts']);

function extractErrorMessage(err: unknown): string {
  if (err == null) return 'unknown error';
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return JSON.stringify(err).slice(0, 200);
}

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const { id } = params;
  const [scenes, shots, assets, visualPrompts, failedGenerations, activeGenerations] =
    await Promise.all([
      scenesRepo.findByProject(id),
      shotsRepo.findByProject(id),
      assetsRepo.findByProject(id),
      promptsRepo.findVisualByProject(id),
      generationsRepo.findFailedByProject(id),
      generationsRepo.findActiveByProject(id),
    ]);

  const assetsByShot = new Map<string, typeof assets>();
  for (const a of assets) {
    if (!a.shotId) continue;
    const arr = assetsByShot.get(a.shotId) ?? [];
    arr.push(a);
    assetsByShot.set(a.shotId, arr);
  }

  // `visualPrompts` is ordered createdAt DESC by the repo; keep only the
  // first occurrence per shotId so a stale prompt row (e.g. left behind by
  // a target switch) never overwrites the current one.
  const visualPromptByShot = new Map<string, (typeof visualPrompts)[number]>();
  for (const p of visualPrompts) {
    if (!visualPromptByShot.has(p.shotId)) visualPromptByShot.set(p.shotId, p);
  }

  // Group failures per shot, split into visual vs narration legs. The repo
  // returns them ordered finishedAt DESC, so we keep only the most recent
  // failure per (shotId, leg) — older retries don't pollute the UI.
  type Failure = { provider: string; message: string; finishedAt: string | null };
  const failuresByShot = new Map<string, { visual?: Failure; narration?: Failure }>();
  for (const g of failedGenerations) {
    if (!g.shotId) continue;
    const slot = failuresByShot.get(g.shotId) ?? {};
    const leg: 'visual' | 'narration' | null = VISUAL_PROVIDERS.has(g.provider)
      ? 'visual'
      : NARRATION_PROVIDERS.has(g.provider)
        ? 'narration'
        : null;
    if (!leg) continue;
    if (slot[leg]) continue; // already saw a more recent failure for this leg
    slot[leg] = {
      provider: g.provider,
      message: extractErrorMessage(g.error),
      finishedAt: g.finishedAt ? g.finishedAt.toISOString() : null,
    };
    failuresByShot.set(g.shotId, slot);
  }

  // Group the latest in-progress generation per (shotId, leg). `activeGenerations`
  // is ordered startedAt DESC, so the first row we see per leg is the freshest.
  // `inLabs` means a providerJobId has been persisted — i.e. the job was handed
  // to 69labs and is rendering; without it the job is still in the worker queue
  // waiting for a concurrency slot.
  type Active = { inLabs: boolean };
  const activeByShot = new Map<string, { visual?: Active; narration?: Active }>();
  for (const g of activeGenerations) {
    if (!g.shotId) continue;
    const leg: 'visual' | 'narration' | null = VISUAL_PROVIDERS.has(g.provider)
      ? 'visual'
      : NARRATION_PROVIDERS.has(g.provider)
        ? 'narration'
        : null;
    if (!leg) continue;
    const slot = activeByShot.get(g.shotId) ?? {};
    if (slot[leg]) continue; // already saw a fresher active row for this leg
    slot[leg] = { inLabs: g.status === 'running' && !!g.providerJobId };
    activeByShot.set(g.shotId, slot);
  }

  const shotsByScene = new Map<string, typeof shots>();
  for (const s of shots) {
    const arr = shotsByScene.get(s.sceneId) ?? [];
    arr.push(s);
    shotsByScene.set(s.sceneId, arr);
  }

  return NextResponse.json({
    scenes: scenes.map((scene) => ({
      ...scene,
      shots: (shotsByScene.get(scene.id) ?? []).map((shot) => {
        const a = assetsByShot.get(shot.id) ?? [];
        const visual = a.find((x) => x.kind === 'video_clip' || x.kind === 'image') ?? null;
        const narration = a.find((x) => x.kind === 'audio_narration') ?? null;
        const p = visualPromptByShot.get(shot.id) ?? null;
        const failure = failuresByShot.get(shot.id) ?? null;
        const active = activeByShot.get(shot.id) ?? null;
        // A leg is "failed" iff there's a recorded failure, no asset has landed
        // for it yet, AND there's no fresh attempt already in flight. The last
        // clause matters because a failure row is never deleted: when a job is
        // retried (BullMQ auto-retry on its attempts budget, or the per-shot
        // Retry button) a new queued/running generation supersedes the old
        // failure, so the shot should read as queued/in_labs — not stay pinned
        // on the failed pill while it's actually regenerating.
        const visualFailed = !!failure?.visual && !visual && !active?.visual;
        const narrationFailed = !!failure?.narration && !narration && !active?.narration;
        const baseStatus =
          visual && narration ? 'ready' : visual || narration ? 'partial' : 'pending';
        const status =
          visualFailed || narrationFailed ? 'failed' : baseStatus;
        // Per-leg generation phase, surfaced so the card can distinguish a shot
        // waiting in the worker queue from one already rendering on 69labs.
        const legPhase = (
          asset: unknown,
          failed: boolean,
          a: Active | undefined,
        ): 'ready' | 'failed' | 'in_labs' | 'queued' =>
          asset ? 'ready' : failed ? 'failed' : a?.inLabs ? 'in_labs' : 'queued';
        return {
          ...shot,
          assets: {
            visual: visual
              ? { id: visual.id, kind: visual.kind, r2Key: visual.r2Key, durationS: visual.durationS }
              : null,
            narration: narration ? { id: narration.id, durationS: narration.durationS } : null,
          },
          visualPrompt: p
            ? { id: p.id, target: p.target, promptText: p.promptText, negative: p.negative }
            : null,
          failures: {
            visual: visualFailed ? failure!.visual : null,
            narration: narrationFailed ? failure!.narration : null,
          },
          progress: {
            visual: legPhase(visual, visualFailed, active?.visual),
            narration: legPhase(narration, narrationFailed, active?.narration),
          },
          status,
        };
      }),
    })),
  });
}
