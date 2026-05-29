import { Queue, type JobsOptions } from 'bullmq';
import { connection } from './connection.js';
import type { QueueName } from './types.js';

function backoff(attempts = 5): JobsOptions {
  return {
    attempts,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 86_400, count: 10_000 },
    removeOnFail: { age: 604_800 },
  };
}

function make(name: QueueName, opts?: JobsOptions) {
  return new Queue(name, { connection, defaultJobOptions: opts });
}

export const queues = {
  analysis: make('analysis', backoff()),
  prompt: make('prompt', backoff()),
  veo3: make('veo3', backoff(8)),
  labs: make('labs', backoff(8)),
  tts: make('tts', backoff(5)),
  remotion: make('remotion', backoff(3)),
  timeline: make('timeline'),
  audio: make('audio'),
  render: make('render', backoff(3)),
  publish: make('publish'),
  orchestrator: make('orchestrator'),
} as const;

export type Queues = typeof queues;
