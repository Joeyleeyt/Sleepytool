import { Queue, type JobsOptions } from 'bullmq';
import { getConnection } from './connection.js';
import type { QueueName } from './types.js';

function backoff(attempts = 5, delay = 5_000): JobsOptions {
  return {
    attempts,
    backoff: { type: 'exponential', delay },
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
  veo32:        backoff(8),
  labsImage:    backoff(8),
  labsImage2:   backoff(8),
  labsVideo:    backoff(8),
  labsVideo2:   backoff(8),
  tts:          backoff(5),
  tts2:         backoff(5),
  remotion:     backoff(3),
  // timeline + audio are pure read→compute→upsert (timeline) and resume-safe
  // (audio reuses a valid mix on disk), so a transient Redis/R2/DB fault — e.g.
  // a Supabase-pooler EMAXCONN burst — must not discard the job. Retry with a
  // long backoff so the spike has time to clear (a pooler saturation lasts
  // seconds-to-minutes, not the 5s a leaf-LLM retry assumes). These also feed
  // the render flow's children via jobOptionsFor() — without that, flow leaves
  // run attempts:1 and a single blip kills the whole render. See flows.ts.
  timeline:     backoff(3, 30_000),
  audio:        backoff(3, 60_000),
  render:       backoff(3),
  publish:      undefined,
  orchestrator: undefined,
  // No retry/backoff: the gate body is a no-op that only flips to completed once
  // all its flow children finish. Its options come from the FlowProducer parent.
  assetsGate:   undefined,
};

/**
 * The default job options for a queue (attempts + backoff). Exported so callers
 * that enqueue a queue's jobs through a `FlowProducer` can apply them per child:
 * BullMQ only applies `defaultJobOptions` to jobs added via `Queue.add`, NOT to
 * flow children, which otherwise run with `attempts: 1` (no retry). The fan-out
 * in generateAssets.ts uses this so an initial 69labs/veo3 FAILED is retried
 * with the same backoff as the per-shot retry path. Returns a fresh object so a
 * caller can spread extra fields without mutating the shared default.
 */
export function jobOptionsFor(name: QueueName): JobsOptions | undefined {
  const o = OPTS[name];
  return o ? { ...o } : undefined;
}

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
