import { FlowProducer, QueueEvents, type JobsOptions } from 'bullmq';
import {
  connection,
  jobOptionsFor,
  assignLane,
  heartbeatLane,
  releaseLane,
  laneQueues,
  isLabsImageQueue,
  isLabsVideoQueue,
  isTtsQueue,
  isVeo3Queue,
  type QueueName,
} from '@emberforge/queue';
import { eventsRepo, projectsRepo, shotsRepo } from '@emberforge/db';

const flow = new FlowProducer({ connection });
const DISABLE_VEO3 = (process.env.DISABLE_VEO3 ?? 'false') === 'true';

// Which external provider a fan-out queue actually hits — so the logs answer
// "did this asset go to 69labs or veo3?" without cross-referencing the workers.
// Handles every lane (labsImage2, labsVideo2, …), not just the base queues.
function providerFor(queueName: string): string {
  if (isVeo3Queue(queueName)) return 'veo3';
  if (isTtsQueue(queueName) || isLabsImageQueue(queueName) || isLabsVideoQueue(queueName)) return '69labs';
  return 'unknown';
}

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

  // Assign this project to a 69labs lane (worker group) so its image/video jobs
  // get their own queues and don't sit behind another project's backlog. The
  // lane's workers share the same per-key slot pools, so 69labs caps still hold.
  const lane = await assignLane(projectId);
  const lq = laneQueues(lane);
  console.log(`[generateAssets] project ${projectId} -> lane ${lane} (${lq.image} / ${lq.video})`);

  const children: { name: string; queueName: string; data: unknown; opts?: JobsOptions }[] = [];

  // Track what we fanned out, broken down by queue, so we can both log a
  // per-shot trail and emit a summary of "how many of each / which provider".
  // `opts` carries the queue's attempts/backoff: FlowProducer children do NOT
  // inherit a queue's defaultJobOptions, so without this each asset job would
  // run with attempts:1 and a single 69labs/veo3 FAILED would never be retried.
  const enqueue = (queueName: string, data: unknown, asset: string, shotId: string) => {
    children.push({
      name: queueName,
      queueName,
      data,
      // ignoreDependencyOnFailure: a single shot that exhausts its retries (e.g. a
      // 69labs content-moderation rejection) must NOT leave the assetsReady parent
      // stuck in 'waiting-children' forever. Without it, BullMQ never completes the
      // parent while any child stays failed, so generateAssets blocks indefinitely:
      // the project hangs in 'generating_assets' and the blocking job pins a worker
      // slot. With it, the parent completes once every child has SETTLED (succeeded
      // OR permanently failed); the project advances to 'assets_ready' and the
      // operator clears the stragglers with the per-shot Retry. (That retry enqueues
      // a standalone job, not a child of this tree, so it can't satisfy the
      // dependency either way — making "proceed on failure" the only non-stuck
      // option.)
      opts: { ...jobOptionsFor(queueName as QueueName), ignoreDependencyOnFailure: true },
    });
    console.log(
      `[generateAssets] enqueued ${asset.padEnd(11)} -> ${queueName.padEnd(10)} (${providerFor(queueName)})  shot=${shotId}`,
    );
  };

  for (const shot of shots) {
    // TTS (narration audio) for every shot
    enqueue(lq.tts, { projectId, shotId: shot.id }, 'narration', shot.id);

    // Visual job — routed by visualType
    switch (shot.visualType) {
      case 'cinematic_video':
        if (DISABLE_VEO3) {
          enqueue(lq.video, { projectId, shotId: shot.id, kind: 'video' }, 'video_clip', shot.id);
        } else {
          enqueue(lq.veo3, { projectId, shotId: shot.id }, 'video_clip', shot.id);
        }
        break;
      case 'image_with_motion':
        enqueue(lq.image, { projectId, shotId: shot.id, kind: 'image' }, 'image', shot.id);
        break;
      case 'atmospheric_broll':
      case 'infographic':
      case 'animated_diagram':
      case 'motion_typography':
        enqueue(lq.video, { projectId, shotId: shot.id, kind: 'video' }, 'video_clip', shot.id);
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
    Object.entries(byQueue).map(([queue, count]) => ({ queue, provider: providerFor(queue), count })),
  );

  // Submit the assetsReady parent with all children. BullMQ keeps the parent
  // in 'waiting-children' until every leaf finishes.
  //
  // The parent lives on the dedicated 'assetsGate' queue — NOT 'orchestrator'.
  // This generateAssets job is itself an 'orchestrator' job that blocks below on
  // waitUntilFinished for the parent's completion. If the parent also sat on
  // 'orchestrator', it would need a free slot in the very pool this (and every
  // other concurrent) generateAssets job is occupying — so once concurrency was
  // saturated by blocked generateAssets jobs, none of their assetsReady parents
  // could ever run and the whole queue deadlocked. A separate gate queue with
  // its own worker breaks that cycle.
  const tree = await flow.add({
    name: 'assetsReady',
    queueName: 'assetsGate',
    data: { projectId, stage: 'assetsReady' },
    children,
  });

  await projectsRepo.setStatus(projectId, 'generating_assets');
  await eventsRepo.emit(projectId, 'generateAssets', 'fanned_out', { jobs: children.length, byQueue });

  // Block until the parent (and therefore every child) is done. Heartbeat the
  // lane assignment so a crash mid-generation frees the lane (its slot in the
  // least-loaded picker) instead of pinning it; release it when the phase ends.
  const events = new QueueEvents('assetsGate', { connection });
  const laneHeartbeat = setInterval(
    () => void heartbeatLane(projectId, lane).catch(() => {}),
    20_000,
  );
  try {
    await tree.job.waitUntilFinished(events);
  } finally {
    clearInterval(laneHeartbeat);
    await releaseLane(projectId, lane).catch(() => {});
    await events.close();
  }

  await projectsRepo.setStatus(projectId, 'assets_ready');
  await eventsRepo.emit(projectId, 'generateAssets', 'succeeded', { jobs: children.length });
  return { fannedOut: children.length };
}
