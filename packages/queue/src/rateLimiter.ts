import { connection } from './connection.js';

interface BucketConfig {
  capacity: number;
  refillPerSec: number;
}

// 69labs published rate limits (req/min), per https://69labs.vip/api-docs:
//   POST /images/generate: 60, /videos/generate: 5, /tts/generate: 20,
//   /motion-graphics/render: 10
// NOTE: these are REQUEST-RATE caps, not concurrency. 69labs separately caps
// CONCURRENT in-flight jobs per tier+job-type — enforced by the counting
// semaphore in `concurrency.ts` (see `acquireSlot`), not here.
//
// Separately again, the plan caps TOTAL jobs PER HOUR PER KEY (100 images /
// 40 videos). With concurrency=2 that hourly cap is the binding constraint
// (sustained generation would otherwise do far more than 100/40 an hour), so
// the `.hourly` buckets below are the real throttle. They're consumed under a
// PER-KEY bucket id (`69labs.image.hourly:<keyId>`) so two keys give 200/80 an
// hour total and a disabled key only drops its own share — see labs-worker.
// Token bucket: capacity = burst size, refill = sustained rate per second.
const LIMITS: Record<string, BucketConfig> = {
  veo3: { capacity: 30, refillPerSec: 0.5 },
  '69labs.image': { capacity: 10, refillPerSec: 60 / 60 },
  '69labs.video': { capacity: 4, refillPerSec: 5 / 60 },
  // Per-key hourly quotas. Small capacity = small head-start burst, then
  // throttle to the sustained hourly rate. Token buckets admit up to
  // `capacity + rate×window`, so keeping capacity well under the hourly number
  // leaves headroom against 69labs' fixed-window enforcement.
  '69labs.image.hourly': { capacity: 10, refillPerSec: 100 / 3600 },
  '69labs.video.hourly': { capacity: 4, refillPerSec: 40 / 3600 },
  '69labs.tts':   { capacity: 16, refillPerSec: 20 / 60 },
  '69labs.motion':{ capacity: 6, refillPerSec: 10 / 60 },
  // Generic '69labs' kept for back-compat with existing workers
  '69labs':       { capacity: 10, refillPerSec: 60 / 60 },
  claude: { capacity: 100, refillPerSec: 5 },
};

// Atomic token-bucket in Lua so concurrent workers cannot oversubscribe.
//
// Return value is the number of MILLISECONDS the caller should wait before the
// requested weight will have refilled: 0 means "acquired, go now". Returning
// the wait time (instead of a 0/1 yes/no) is what lets the client sleep for the
// real deficit instead of busy-polling every ~250ms — see `acquire()`. A token
// bucket refills at a known rate, so the wait is exactly computable here; there
// is no reason to keep asking Redis "is it ready yet?" on a fixed tick.
const LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local weight = tonumber(ARGV[3])
local now_ms = tonumber(ARGV[4])
local ttl_ms = tonumber(ARGV[5])

local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1]) or capacity
local ts = tonumber(data[2]) or now_ms

local elapsed = math.max(0, now_ms - ts) / 1000
tokens = math.min(capacity, tokens + elapsed * refill)

if tokens >= weight then
  tokens = tokens - weight
  redis.call('HMSET', key, 'tokens', tokens, 'ts', now_ms)
  redis.call('PEXPIRE', key, ttl_ms)
  return 0
end

-- Not enough tokens. Persist the accrual (so 'ts' advances and we don't
-- re-credit the same elapsed window next call), then tell the caller how long
-- to wait for the deficit to refill, in ms. Guard refill<=0 to avoid div-by-0.
redis.call('HMSET', key, 'tokens', tokens, 'ts', now_ms)
redis.call('PEXPIRE', key, ttl_ms)
if refill <= 0 then
  return 60000
end
local deficit = weight - tokens
return math.ceil(deficit / refill * 1000)
`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Cap a single sleep so a long wait still re-checks periodically: another
// worker may have consumed the tokens this caller was waiting for (the returned
// wait assumes the deficit is all ours), or clock skew may shift things. At 5s
// a 12s wait costs ~3 EVALs instead of the ~32 the old 250ms poll burned.
const MAX_SLEEP_MS = 5_000;

export async function acquire(
  provider: keyof typeof LIMITS | string,
  weight = 1,
  // Bucket id to throttle, when it differs from the config name — e.g. a
  // per-key hourly bucket `69labs.image.hourly:<keyId>` that reads its limits
  // from the `69labs.image.hourly` config. Defaults to `provider`.
  bucketKey: string = provider,
): Promise<void> {
  const cfg = LIMITS[provider];
  if (!cfg) return;
  const key = `tb:${bucketKey}`;
  // Keep the bucket alive at least as long as it takes to refill from empty to
  // full (capacity/refill); expiring sooner would drop accrued state and reset
  // it to full — silently refunding the budget. Critical for the slow hourly
  // buckets (a 60s idle gap must NOT wipe an hour's quota). +60s margin; never
  // below the original 60s so fast buckets are unaffected.
  const refillFullMs = cfg.refillPerSec > 0 ? Math.ceil((cfg.capacity / cfg.refillPerSec) * 1000) : 0;
  const ttlMs = Math.max(60_000, refillFullMs + 60_000);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const waitMs = (await connection.eval(
      LUA,
      1,
      key,
      String(cfg.capacity),
      String(cfg.refillPerSec),
      String(weight),
      String(Date.now()),
      String(ttlMs),
    )) as number;
    if (waitMs <= 0) return;
    // Small jitter so concurrent waiters don't all wake on the same tick and
    // stampede the bucket (and Redis) in lockstep.
    const jitter = Math.floor(Math.random() * 100);
    await sleep(Math.min(waitMs, MAX_SLEEP_MS) + jitter);
  }
}
