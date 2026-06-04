import { NextResponse } from 'next/server';
import { z } from 'zod';
import { assetsRepo, eventsRepo, promptsRepo, shotsRepo } from '@emberforge/db';
import { queues } from '@emberforge/queue';
import { parseJsonBody } from '@/lib/httpBody';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RetryBodySchema = z
  .object({
    legs: z.array(z.enum(['visual', 'narration'])).min(1).optional(),
  })
  .default({});

const DISABLE_VEO3 = (process.env.DISABLE_VEO3 ?? 'false') === 'true';

type VisualRoute = { queue: 'veo3' | 'labsImage' | 'labsVideo'; name: string; data: Record<string, unknown> };

// Map a prompt target (the provider the shot was ACTUALLY prompted for) to its
// queue + job payload. This is the source of truth so a retry always lands on
// the same worker that generated the shot.
function routeForTarget(
  target: string,
  projectId: string,
  shotId: string,
): VisualRoute | null {
  switch (target) {
    case 'veo3':
      return { queue: 'veo3', name: 'veo3', data: { projectId, shotId } };
    case '69labs.image':
      return { queue: 'labsImage', name: 'labsImage', data: { projectId, shotId, kind: 'image' } };
    case '69labs.video':
      return { queue: 'labsVideo', name: 'labsVideo', data: { projectId, shotId, kind: 'video' } };
    default:
      return null;
  }
}

// Fallback only when a shot has no visual prompt row yet (shouldn't happen for
// a shot that was generated). Mirrors generateAssets.ts's env-based routing.
function routeForVisualType(
  visualType: string,
  projectId: string,
  shotId: string,
): VisualRoute {
  if (visualType === 'image_with_motion') {
    return { queue: 'labsImage', name: 'labsImage', data: { projectId, shotId, kind: 'image' } };
  }
  if (visualType === 'cinematic_video' && !DISABLE_VEO3) {
    return { queue: 'veo3', name: 'veo3', data: { projectId, shotId } };
  }
  // cinematic_video (safe-mode) + atmospheric_broll + the motion-graphics types
  // all route through 69labs video.
  return { queue: 'labsVideo', name: 'labsVideo', data: { projectId, shotId, kind: 'video' } };
}

/**
 * Re-enqueue the leaf job(s) for a single shot. Used by the per-shot Retry
 * button when a generation failed all its BullMQ attempts.
 *
 * Body:
 *   { legs?: ('visual' | 'narration')[] }   // default: retry both legs
 *
 * Side effects:
 *   - DELETE assets rows for the requested legs (so the worker's cache
 *     check misses and a fresh generation runs).
 *   - ADD one BullMQ job per leg to the appropriate queue (labs/veo3/tts).
 *
 * NOT a flow tree — this runs outside of generateAssetsStage's parent. The
 * project status is left as-is; the user can replay the whole stage if they
 * need a new aggregate gate.
 */
export async function POST(request: Request, { params }: { params: { shotId: string } }) {
  const shot = await shotsRepo.findById(params.shotId);
  if (!shot) return NextResponse.json({ error: 'shot not found' }, { status: 404 });

  const body = await parseJsonBody(request, RetryBodySchema);
  if (body instanceof NextResponse) return body;
  const legs = new Set(body.legs ?? ['visual', 'narration']);

  const enqueued: { leg: 'visual' | 'narration'; queue: string; name: string }[] = [];

  if (legs.has('visual')) {
    // Drop the cached asset row so the worker's cache check misses.
    await assetsRepo.deleteByShot(shot.id, 'video_clip');
    await assetsRepo.deleteByShot(shot.id, 'image');

    // Route by the shot's ACTUAL visual prompt target, not by re-reading
    // DISABLE_VEO3 here — the web process's env can differ from the
    // orchestrator's (or DISABLE_VEO3 may have flipped), which would send the
    // retry to a queue no worker is consuming (e.g. veo3) so it silently never
    // runs. The prompt target is what the shot was generated for.
    const visualPrompt = await promptsRepo.findLatestVisualForShot(shot.id);
    const route =
      (visualPrompt && routeForTarget(visualPrompt.target, shot.projectId, shot.id)) ??
      routeForVisualType(shot.visualType, shot.projectId, shot.id);

    await queues[route.queue].add(route.name, route.data);
    enqueued.push({ leg: 'visual', queue: route.queue, name: route.name });
  }

  if (legs.has('narration')) {
    await assetsRepo.deleteByShot(shot.id, 'audio_narration');
    await queues.tts.add('tts', { projectId: shot.projectId, shotId: shot.id });
    enqueued.push({ leg: 'narration', queue: 'tts', name: 'tts' });
  }

  await eventsRepo.emit(shot.projectId, 'retry_shot', 'enqueued', {
    shotId: shot.id,
    legs: [...legs],
  });

  // Make the retry visible on the web console so it's obvious the click reached
  // the server and which queue/worker each leg was handed to. If you see this
  // line but no matching `[labs:video] … picked_up` on the worker console, the
  // worker process isn't running/consuming that queue.
  console.log(
    `[retry] shot=${shot.id} legs=${[...legs].join(',')} → ${enqueued
      .map((e) => `${e.leg}:${e.queue}`)
      .join(', ')}`,
  );

  return NextResponse.json({ ok: true, shotId: shot.id, enqueued }, { status: 202 });
}
