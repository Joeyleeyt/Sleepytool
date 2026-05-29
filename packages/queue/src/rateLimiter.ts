import { connection } from './connection.js';

interface BucketConfig {
  capacity: number;
  refillPerSec: number;
}

// 69labs published rate limits (req/min):
//   images: 10, videos: 5, tts: 20, motion: 5
// Token bucket: capacity = burst size, refill = sustained rate per second.
const LIMITS: Record<string, BucketConfig> = {
  veo3: { capacity: 30, refillPerSec: 0.5 },
  '69labs.image': { capacity: 8, refillPerSec: 10 / 60 },
  '69labs.video': { capacity: 4, refillPerSec: 5 / 60 },
  '69labs.tts':   { capacity: 16, refillPerSec: 20 / 60 },
  '69labs.motion':{ capacity: 4, refillPerSec: 5 / 60 },
  // Generic '69labs' kept for back-compat with existing workers
  '69labs':       { capacity: 8, refillPerSec: 10 / 60 },
  claude: { capacity: 100, refillPerSec: 5 },
};

// Atomic token-bucket in Lua so concurrent workers cannot oversubscribe.
const LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local weight = tonumber(ARGV[3])
local now_ms = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1]) or capacity
local ts = tonumber(data[2]) or now_ms

local elapsed = math.max(0, now_ms - ts) / 1000
tokens = math.min(capacity, tokens + elapsed * refill)

if tokens >= weight then
  tokens = tokens - weight
  redis.call('HMSET', key, 'tokens', tokens, 'ts', now_ms)
  redis.call('PEXPIRE', key, 60000)
  return 1
else
  redis.call('HMSET', key, 'tokens', tokens, 'ts', now_ms)
  redis.call('PEXPIRE', key, 60000)
  return 0
end
`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function acquire(provider: keyof typeof LIMITS | string, weight = 1): Promise<void> {
  const cfg = LIMITS[provider];
  if (!cfg) return;
  const key = `tb:${provider}`;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ok = (await connection.eval(
      LUA,
      1,
      key,
      String(cfg.capacity),
      String(cfg.refillPerSec),
      String(weight),
      String(Date.now()),
    )) as number;
    if (ok === 1) return;
    await sleep(250 + Math.floor(Math.random() * 250));
  }
}
