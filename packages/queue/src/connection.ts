/**
 * Lazy Redis connection — created on first property access, not at module
 * load. This matters for serverless / Next.js Route Handlers where the build
 * step imports this module without REDIS_URL being valid and without Redis
 * actually being reachable yet.
 *
 * Direct callers can either use the `connection` proxy (compatibility shim
 * with the previous eager export) or call `getConnection()` for the underlying
 * client.
 */
import IORedis, { type Redis } from 'ioredis';

let cached: Redis | null = null;

export function getConnection(): Redis {
  if (cached) return cached;
  const url = (process.env.REDIS_URL ?? 'redis://localhost:6379').trim();
  const isTls = url.startsWith('rediss://');
  // `family: 0` (dual-stack) only on Windows — there `localhost`/Upstash DNS
  // prefers IPv6 first and gets EACCES on v4-only endpoints. On Linux/macOS,
  // forcing dual-stack changes resolution order in container networks (e.g.
  // IPv6-disabled CI hosts) and can SLOW connect or spam reconnect errors.
  // Override with REDIS_FAMILY=0|4|6 if you need to pin it explicitly.
  const familyEnv = process.env.REDIS_FAMILY;
  const family =
    familyEnv != null && familyEnv !== ''
      ? (Number(familyEnv) as 0 | 4 | 6)
      : process.platform === 'win32'
        ? 0
        : undefined;

  // On Vercel only the FlowProducer runs (a non-blocking producer that enqueues
  // pipeline jobs from the API routes) — never a Worker. So we can fail fast
  // there: an unreachable / misconfigured REDIS_URL (e.g. a Fly-internal host
  // or a non-TLS endpoint) must reject `flowProducer.add()` with a readable
  // error instead of having ioredis queue the command and reconnect forever,
  // which hangs the serverless function past maxDuration and surfaces as an
  // opaque 504 FUNCTION_INVOCATION_TIMEOUT. This mirrors the DB connect_timeout
  // fail-fast in packages/db/src/client.ts.
  //
  // Long-lived Fly workers MUST keep maxRetriesPerRequest: null (BullMQ requires
  // it for the blocking BRPOPLPUSH/XREAD commands) and want forever-reconnect so
  // a transient network blip doesn't kill the process.
  const onVercel = !!process.env.VERCEL;
  cached = new IORedis(url, {
    maxRetriesPerRequest: onVercel ? 3 : null,
    enableReadyCheck: false,
    lazyConnect: false,
    connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT_MS ?? (onVercel ? 6000 : 10000)),
    ...(onVercel
      ? {
          // Bound a hung command (no blocking commands run on Vercel) and give
          // up reconnecting after a couple of attempts so the offline queue is
          // flushed with an error rather than retried forever.
          commandTimeout: Number(process.env.REDIS_COMMAND_TIMEOUT_MS ?? 10000),
          retryStrategy: (times: number) => (times > 2 ? null : Math.min(times * 300, 1000)),
        }
      : {}),
    ...(family !== undefined ? { family } : {}),
    ...(isTls ? { tls: {} } : {}),
  });
  cached.on('error', (err) => {
    // BullMQ swallows connection errors silently — log them so workers don't
    // appear to "just hang" when Redis is unreachable.
    // eslint-disable-next-line no-console
    console.error('[redis] connection error:', err.message);
  });
  return cached;
}

// Back-compat: transparent proxy that defers to the real client on every
// property access. Allows existing `connection.foo()` calls to keep working
// while ensuring the underlying TCP connection isn't opened at import time.
//
// CRITICAL: when the property is a function, we must bind it to the real
// client. BullMQ internally calls `client[name](...args)` where `name` is a
// Redis command (xadd, evalsha, etc.); without binding, `this` ends up as
// the Proxy and ioredis's instance methods break with
//   TypeError: client[name] is not a function
// because their prototype lookups via `this` go through the trap that
// doesn't expose private slots.
export const connection: Redis = new Proxy({} as Redis, {
  get(_target, prop) {
    const real = getConnection() as unknown as Record<string | symbol, unknown>;
    const value = real[prop as string];
    return typeof value === 'function' ? (value as Function).bind(real) : value;
  },
  set(_target, prop, value) {
    (getConnection() as unknown as Record<string | symbol, unknown>)[prop as string] = value;
    return true;
  },
  has(_target, prop) {
    return prop in (getConnection() as unknown as Record<string | symbol, unknown>);
  },
});
