import { connection } from './connection.js';

/**
 * 69labs worker "lanes" — parallel worker groups so two projects can generate
 * assets concurrently instead of one queueing behind the other.
 *
 * A lane is one set of asset queues (labsImage{N} / labsVideo{N}) drained by its
 * own Worker instances. `generateAssets` assigns each project to a lane and fans
 * that project's image/video jobs into the lane's queues; the matching workers
 * drain them. The job handler is identical across lanes — it routes on
 * `job.data.kind`, not the queue name.
 *
 * IMPORTANT: every lane still shares the SAME global 69labs per-key slot pools
 * and rate buckets (`cc:69labs.image:<keyId>`, the rateLimiter token buckets),
 * so total in-flight work never exceeds the provider's concurrency caps no
 * matter how many lanes run. Lanes only decide WHICH queue a project's jobs sit
 * in — not how much 69labs capacity they get. Because that shared slot pool is
 * the real limiter, and each lane's BullMQ concurrency is left at the full pool
 * size, the behaviour is work-conserving:
 *
 *   • one active project  → its lane fills every slot              → 100%
 *   • two active projects → both lanes contend for the same slots  → ~50% each
 */

// Number of parallel lanes. 1 = the original single-group behaviour (so the
// single-project path and existing in-flight jobs are byte-for-byte unchanged).
export const NUM_LANES = Math.max(1, Number(process.env.LABS_LANES ?? 2));

export interface LaneQueues {
  image: string;
  video: string;
  tts: string;
  veo3: string;
}

/**
 * Queue names for a lane, one per asset type. Lane 1 keeps the original base
 * names for back-compat (`labsImage`, `labsVideo`, `tts`, `veo3`); lane k>1 gets
 * a numeric suffix (`labsImage2`, `tts2`, `veo32`, …).
 */
export function laneQueues(lane: number): LaneQueues {
  const s = lane <= 1 ? '' : String(lane);
  return { image: `labsImage${s}`, video: `labsVideo${s}`, tts: `tts${s}`, veo3: `veo3${s}` };
}

/** Every lane's queue names — for registering workers across all lanes. */
export function allLaneQueues(): ({ lane: number } & LaneQueues)[] {
  return Array.from({ length: NUM_LANES }, (_, i) => ({ lane: i + 1, ...laneQueues(i + 1) }));
}

/** Which asset queue family a name belongs to (any lane) — for provider logs
 *  and routing. The numeric-suffix scheme means a trailing digit is the lane. */
export function isLabsImageQueue(name: string): boolean {
  return /^labsImage\d*$/.test(name);
}
export function isLabsVideoQueue(name: string): boolean {
  return /^labsVideo\d*$/.test(name);
}
export function isTtsQueue(name: string): boolean {
  return /^tts\d*$/.test(name);
}
export function isVeo3Queue(name: string): boolean {
  return /^veo3\d*$/.test(name);
}

// A lane assignment expires this long after its last heartbeat, so a crashed
// orchestrator frees its lane (the divisor self-corrects) instead of pinning it.
const LEASE_MS = Math.max(60_000, Number(process.env.LABS_LANE_LEASE_MS ?? 60_000));
const laneKey = (lane: number) => `lane:${lane}:active`;

/**
 * Assign a project to the least-loaded lane and register it there (lease-backed).
 * Ties break to the lowest-numbered lane, so the first of two concurrent
 * projects lands on lane 1 and the second on lane 2.
 */
export async function assignLane(projectId: string): Promise<number> {
  const now = Date.now();
  let best = 1;
  let bestCount = Infinity;
  for (let lane = 1; lane <= NUM_LANES; lane++) {
    await connection.zremrangebyscore(laneKey(lane), '-inf', now); // evict expired
    const count = await connection.zcard(laneKey(lane));
    if (count < bestCount) {
      bestCount = count;
      best = lane;
    }
  }
  await connection.zadd(laneKey(best), now + LEASE_MS, projectId);
  return best;
}

/** Refresh a lane assignment's lease — call periodically while the asset phase
 *  blocks on `waitUntilFinished`. */
export async function heartbeatLane(projectId: string, lane: number): Promise<void> {
  await connection.zadd(laneKey(lane), Date.now() + LEASE_MS, projectId);
}

/** Release a lane assignment when the project's asset phase ends (or fails). */
export async function releaseLane(projectId: string, lane: number): Promise<void> {
  await connection.zrem(laneKey(lane), projectId);
}
