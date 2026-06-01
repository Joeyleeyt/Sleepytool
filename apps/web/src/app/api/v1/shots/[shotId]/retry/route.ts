import { NextResponse } from 'next/server';
import { z } from 'zod';
import { assetsRepo, eventsRepo, shotsRepo } from '@emberforge/db';
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

    let queue: 'veo3' | 'labs';
    let name: string;
    let data: Record<string, unknown>;
    switch (shot.visualType) {
      case 'cinematic_video':
        if (DISABLE_VEO3) {
          queue = 'labs';
          name = 'labsVideo';
          data = { projectId: shot.projectId, shotId: shot.id, kind: 'video' };
        } else {
          queue = 'veo3';
          name = 'veo3';
          data = { projectId: shot.projectId, shotId: shot.id };
        }
        break;
      case 'image_with_motion':
        queue = 'labs';
        name = 'labsImage';
        data = { projectId: shot.projectId, shotId: shot.id, kind: 'image' };
        break;
      default:
        // atmospheric_broll + the motion-graphics types all route through
        // labs.video in safe-mode (see generateAssets.ts).
        queue = 'labs';
        name = 'labsVideo';
        data = { projectId: shot.projectId, shotId: shot.id, kind: 'video' };
        break;
    }
    await queues[queue].add(name, data);
    enqueued.push({ leg: 'visual', queue, name });
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

  return NextResponse.json({ ok: true, shotId: shot.id, enqueued }, { status: 202 });
}
