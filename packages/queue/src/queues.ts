import { Queue, type JobsOptions } from 'bullmq';
import { getConnection } from './connection.js';
import type { QueueName } from './types.js';

function backoff(attempts = 5): JobsOptions {
  return {
    attempts,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 86_400, count: 10_000 },
    removeOnFail: { age: 604_800 },
  };
}

// Per-queue job-option defaults.
//   analysis + prompt: 2 attempts. LLM failures are usually schema mismatches
//   or quota issues — 5 retries with 75s backoff just masks the real error
//   and makes the orchestrator look like it's looping. Fail fast and surface
//   the exception in the events log.
const OPTS: Record<QueueName, JobsOptions | undefined> = {
  analysis:     backoff(2),
  prompt:       backoff(2),
  veo3:         backoff(8),
  labs:         backoff(8),
  tts:          backoff(5),
  remotion:     backoff(3),
  timeline:     undefined,
  audio:        undefined,
  render:       backoff(3),
  publish:      undefined,
  orchestrator: undefined,
};

// Lazy queue cache. `new Queue(...)` opens a Redis connection — defer it
// until the first time a queue is actually used so module loading stays
// side-effect free. Critical for Next.js Route Handlers / Vercel where
// build-time imports happen without Redis being reachable.
const cache = new Map<QueueName, Queue>();
function lazyQueue(name: QueueName): Queue {
  let q = cache.get(name);
  if (!q) {
    q = new Queue(name, { connection: getConnection(), defaultJobOptions: OPTS[name] });
    cache.set(name, q);
  }
  return q;
}

export const queues: Record<QueueName, Queue> = new Proxy(
  {} as Record<QueueName, Queue>,
  {
    get(_target, prop: string) {
      return lazyQueue(prop as QueueName);
    },
  },
);

export type Queues = typeof queues;
