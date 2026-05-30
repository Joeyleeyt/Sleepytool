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
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  cached = new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
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
