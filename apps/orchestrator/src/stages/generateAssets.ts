import { FlowProducer, QueueEvents, type JobsOptions } from 'bullmq';
import { connection, jobOptionsFor, type QueueName } from '@emberforge/queue';
import { eventsRepo, projectsRepo, shotsRepo } from '@emberforge/db';

const flow = new FlowProducer({ connection });
const DISABLE_VEO3 = (process.env.DISABLE_VEO3 ?? 'false') === 'true';

// Which external provider each fan-out queue actually hits — so the logs answer
// "did this asset go to 69labs or veo3?" without cross-referencing the workers.
const QUEUE_PROVIDER: Record<string, string> = {
  tts: '69labs',
  labsImage: '69labs',
  labsVideo: '69labs',
  veo3: 'veo3',
};

/**
 * Fan out a job per shot per asset type and BLOCK until every leaf finishes.
 *
 * We use BullMQ's parent-with-children flow: the "assetsReady" parent job
 * stays in the 'waiting-children' state until all children complete. We then
 * await its completion via QueueEvents so the upstream stage (buildTimeline)
 * only runs once every asset is persisted.
 */
export async function generateAssetsStage(projectId: string) {
  await eventsRepo.emit(projectId, 'generateAssets', 'started');

  const shots = await shotsRepo.findByProject(projectId);
  if (shots.length === 0) throw new Error(`project ${projectId} has no shots to generate`);

  const children: { name: string; queueName: string; data: unknown; opts?: JobsOptions }[] = [];

  // Track what we fanned out, broken down by queue, so we can both log a
  // per-shot trail and emit a summary of "how many of each / which provider".
  // `opts` carries the queue's attempts/backoff: FlowProducer children do NOT
  // inherit a queue's defaultJobOptions, so without this each asset job would
  // run with attempts:1 and a single 69labs/veo3 FAILED would never be retried.
  const enqueue = (queueName: string, data: unknown, asset: string, shotId: string) => {
    children.push({ name: queueName, queueName, data, opts: jobOptionsFor(queueName as QueueName) });
    console.log(
      `[generateAssets] enqueued ${asset.padEnd(11)} -> ${queueName.padEnd(10)} (${QUEUE_PROVIDER[queueName]})  shot=${shotId}`,
    );
  };

  for (const shot of shots) {
    // TTS (narration audio) for every shot
    enqueue('tts', { projectId, shotId: shot.id }, 'narration', shot.id);

    // Visual job — routed by visualType
    switch (shot.visualType) {
      case 'cinematic_video':
        if (DISABLE_VEO3) {
          enqueue('labsVideo', { projectId, shotId: shot.id, kind: 'video' }, 'video_clip', shot.id);
        } else {
          enqueue('veo3', { projectId, shotId: shot.id }, 'video_clip', shot.id);
        }
        break;
      case 'image_with_motion':
        enqueue('labsImage', { projectId, shotId: shot.id, kind: 'image' }, 'image', shot.id);
        break;
      case 'atmospheric_broll':
      case 'infographic':
      case 'animated_diagram':
      case 'motion_typography':
        enqueue('labsVideo', { projectId, shotId: shot.id, kind: 'video' }, 'video_clip', shot.id);
        break;
    }
  }

  // Summary: count of children per queue, e.g. { tts: 20, veo3: 8, labsVideo: 12 }.
  const byQueue = children.reduce<Record<string, number>>((acc, c) => {
    acc[c.queueName] = (acc[c.queueName] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`[generateAssets] fan-out for project ${projectId}: ${shots.length} shots -> ${children.length} jobs`);
  console.table(
    Object.entries(byQueue).map(([queue, count]) => ({ queue, provider: QUEUE_PROVIDER[queue], count })),
  );

  // Submit the assetsReady parent with all children. BullMQ keeps the parent
  // in 'waiting-children' until every leaf finishes.
  const tree = await flow.add({
    name: 'assetsReady',
    queueName: 'orchestrator',
    data: { projectId, stage: 'assetsReady' },
    children,
  });

  await projectsRepo.setStatus(projectId, 'generating_assets');
  await eventsRepo.emit(projectId, 'generateAssets', 'fanned_out', { jobs: children.length, byQueue });

  // Block until the parent (and therefore every child) is done.
  const events = new QueueEvents('orchestrator', { connection });
  try {
    await tree.job.waitUntilFinished(events);
  } finally {
    await events.close();
  }

  await projectsRepo.setStatus(projectId, 'assets_ready');
  await eventsRepo.emit(projectId, 'generateAssets', 'succeeded', { jobs: children.length });
  return { fannedOut: children.length };
}
