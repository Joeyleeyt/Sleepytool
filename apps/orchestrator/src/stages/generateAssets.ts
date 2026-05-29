import { FlowProducer, QueueEvents } from 'bullmq';
import { connection } from '@emberforge/queue';
import { eventsRepo, projectsRepo, shotsRepo } from '@emberforge/db';

const flow = new FlowProducer({ connection });
const DISABLE_VEO3 = (process.env.DISABLE_VEO3 ?? 'false') === 'true';

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

  const children: { name: string; queueName: string; data: unknown }[] = [];

  for (const shot of shots) {
    // TTS for every shot
    children.push({ name: 'tts', queueName: 'tts', data: { projectId, shotId: shot.id } });

    // Visual job
    switch (shot.visualType) {
      case 'cinematic_video':
        if (DISABLE_VEO3) {
          children.push({ name: 'labsVideo', queueName: 'labs', data: { projectId, shotId: shot.id, kind: 'video' } });
        } else {
          children.push({ name: 'veo3', queueName: 'veo3', data: { projectId, shotId: shot.id } });
        }
        break;
      case 'image_with_motion':
        children.push({ name: 'labsImage', queueName: 'labs', data: { projectId, shotId: shot.id, kind: 'image' } });
        break;
      case 'atmospheric_broll':
      case 'infographic':
      case 'animated_diagram':
      case 'motion_typography':
        children.push({ name: 'labsVideo', queueName: 'labs', data: { projectId, shotId: shot.id, kind: 'video' } });
        break;
    }
  }

  // Submit the assetsReady parent with all children. BullMQ keeps the parent
  // in 'waiting-children' until every leaf finishes.
  const tree = await flow.add({
    name: 'assetsReady',
    queueName: 'orchestrator',
    data: { projectId, stage: 'assetsReady' },
    children,
  });

  await projectsRepo.setStatus(projectId, 'generating_assets');
  await eventsRepo.emit(projectId, 'generateAssets', 'fanned_out', { jobs: children.length });

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
