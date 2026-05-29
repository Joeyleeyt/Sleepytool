/**
 * Dev/debug: re-enqueue a single stage for a project. Useful when iterating on
 * a single piece of the pipeline without re-running expensive AI calls.
 *
 *   pnpm tsx scripts/replay-project.ts <projectId> <stage>
 */
import { queues } from '@emberforge/queue';

const [, , projectId, stage] = process.argv;
if (!projectId || !stage) {
  console.error('usage: replay-project <projectId> <stage>');
  process.exit(1);
}

const STAGE_TO_QUEUE: Record<string, keyof typeof queues> = {
  analyze: 'analysis',
  segment: 'analysis',
  classify: 'analysis',
  prompt: 'prompt',
  generateAssets: 'orchestrator',
  buildTimeline: 'timeline',
  mixAudio: 'audio',
  composite: 'render',
  encode: 'render',
  publish: 'publish',
};

const queueName = STAGE_TO_QUEUE[stage];
if (!queueName) {
  console.error(`unknown stage ${stage}`);
  process.exit(1);
}

await queues[queueName].add(stage, { projectId, stage });
console.log(`enqueued ${stage} for project ${projectId} on queue ${queueName}`);
process.exit(0);
