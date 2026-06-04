import { connection } from './connection.js';

/**
 * Distributed concurrency limiter (a counting semaphore).
 *
 * This is the companion to the token-bucket rate limiter in `rateLimiter.ts`.
 * The rate limiter caps *requests per minute*; it does NOT cap how many jobs
 * are *in flight at once*. 69labs enforces a separate per-tier, per-job-type
 * "max concurrent jobs" limit (e.g. 4 concurrent image jobs). A single labs
 * job here = submit + poll-until-done + download, which can span minutes; for
 * that whole window it occupies one provider slot. If we run more concurrent
 * jobs than the tier allows, every extra submit gets `403 Concurrent ... limit
 * reached` and the job dies.
 *
 * Each held slot is a member of a Redis sorted set scored by its lease expiry.
 * Before taking a slot we evict expired leases, so a crashed/killed worker's
 * slot is auto-reclaimed instead of wedging the pool forever (the failure mode
 * that exhausted the image limit during `--watch` dev restarts).
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// A held slot stays valid this long without renewal before it's treated as
// abandoned and reclaimed. Must exceed the longest submit→poll→download span
// (image poll timeout is 10 min) so a legitimately slow job isn't evicted out
// from under itself. The owning worker releases its slot in a `finally`, so
// this lease is only a crash-safety backstop.
const DEFAULT_LEASE_MS = 12 * 60_000;

// How often a waiter re-checks for a free slot, plus jitter so concurrent
// waiters don't wake in lockstep and stampede Redis.
const POLL_MS = 500;
const POLL_JITTER_MS = 150;

// Atomic in Lua so two workers can't both see "one free slot" and oversubscribe:
//   1. drop expired leases
//   2. if under capacity, claim a slot and return 1; else return 0
const ACQUIRE_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local max = tonumber(ARGV[2])
local token = ARGV[3]
local expiry = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
if redis.call('ZCARD', key) < max then
  redis.call('ZADD', key, expiry, token)
  redis.call('PEXPIRE', key, 86400000)
  return 1
end
return 0
`;

export interface Slot {
  /** Release the slot back to the pool. Safe to call more than once. */
  release: () => Promise<void>;
}

let counter = 0;
function mkToken(provider: string): string {
  counter = (counter + 1) % 1_000_000;
  return `${provider}:${process.pid}:${Date.now()}:${counter}`;
}

/**
 * Block until a concurrency slot for `provider` is free (at most `max` held at
 * once across all workers), then return a handle whose `release()` frees it.
 *
 * Always release in a `finally`:
 *   const slot = await acquireSlot('69labs.image', 4);
 *   try { ...do the work... } finally { await slot.release(); }
 */
export async function acquireSlot(
  provider: string,
  max: number,
  opts: { leaseMs?: number; signal?: AbortSignal } = {},
): Promise<Slot> {
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const key = `cc:${provider}`;
  const token = mkToken(provider);
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await connection.zrem(key, token).catch(() => {});
  };
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (opts.signal?.aborted) throw new Error(`acquireSlot(${provider}) aborted`);
    const ok = (await connection.eval(
      ACQUIRE_LUA,
      1,
      key,
      String(Date.now()),
      String(max),
      token,
      String(Date.now() + leaseMs),
    )) as number;
    if (ok === 1) return { release };
    await sleep(POLL_MS + Math.floor(Math.random() * POLL_JITTER_MS));
  }
}
