/**
 * Run a 69labs call with automatic key rotation.
 *
 *   await withProviderKey('69labs', (apiKey) => labs69.image({ ...input, apiKey }))
 *
 * It reads your active keys from the api_keys table, tries them IN ORDER, and:
 *
 *   success            → mark the key used, return the result
 *   bad key / no funds → disable that key, try the next one
 *   other failure      → try the next one
 *   content failure    → NOT a key problem (e.g. 69labs CENSORED) → rethrow now,
 *                        don't waste your other keys on a doomed prompt
 *
 * Rotation re-runs your whole function under a different key — for 69labs that's
 * a fresh submit→poll→download under the next account, which is the only way
 * (a provider job belongs to the key that created it).
 *
 * No Redis, no weighting, no cooldowns — just "next key on failure". That's all
 * a single-operator setup needs.
 */
import { apiKeysRepo } from '@emberforge/db';

export class NoKeyAvailableError extends Error {
  constructor(provider: string) {
    super(`no active API key for "${provider}" — add one with: pnpm tsx scripts/keys.ts add <key>`);
    this.name = 'NoKeyAvailableError';
  }
}

// Provider errors from labs69.ts carry a numeric `status`; we classify off that.
interface ProviderError extends Error {
  status?: number;
}

type Action = 'disable' | 'rotate' | 'rethrow';

/** Decide what to do with a key after a failed call. */
function actionFor(err: unknown): { action: Action; reason?: string } {
  const e = err as ProviderError;
  const status = typeof e?.status === 'number' ? e.status : undefined;
  const msg = (e?.message ?? '').toLowerCase();

  // A CENSORED / content-failed job won't succeed on ANY key — surface it
  // instead of burning the whole pool re-running the same prompt.
  if (msg.includes('censored') || (msg.includes('failed') && !status)) {
    return { action: 'rethrow' };
  }
  // Dead key: bad/revoked (401) or account-level block (403 that isn't a
  // "concurrent limit" throttle). Disable it so we stop trying it every job.
  if (status === 401 || (status === 403 && !msg.includes('concurrent') && !msg.includes('rate'))) {
    return { action: 'disable', reason: 'invalid_key' };
  }
  // Out of credits: the key works but the account can't pay — disable until you
  // top it up (otherwise every job wastes a round-trip on it).
  if (status === 402 || msg.includes('insufficient') || msg.includes('credit')) {
    return { action: 'disable', reason: 'no_credits' };
  }
  // Everything else (429, 5xx, timeouts, concurrent-limit throttles) — just try
  // the next key. Keep this key active; it's probably fine.
  return { action: 'rotate' };
}

export interface WithProviderKeyOptions {
  /**
   * Key to use when the api_keys table has no active key yet — lets the worker
   * keep running on the legacy `LABS69_API_KEY` env value until you've added
   * keys. Pass `undefined`/empty to disable.
   */
  fallbackKey?: string;
}

export async function withProviderKey<T>(
  provider: string,
  fn: (apiKey: string) => Promise<T>,
  opts: WithProviderKeyOptions = {},
): Promise<T> {
  const keys = await apiKeysRepo.listActive(provider);

  if (keys.length === 0) {
    const fallback = opts.fallbackKey?.trim();
    if (fallback) return fn(fallback); // table not populated yet → legacy env key
    throw new NoKeyAvailableError(provider);
  }

  let lastErr: unknown;
  for (const key of keys) {
    const apiKey = apiKeysRepo.decrypt(key.encryptedApiKey);
    try {
      const result = await fn(apiKey);
      // Best-effort bookkeeping — never block or fail the job on it.
      void apiKeysRepo.markUsed(key.id).catch(() => {});
      return result;
    } catch (err) {
      lastErr = err;
      const { action, reason } = actionFor(err);
      if (action === 'disable') {
        void apiKeysRepo.disable(key.id, reason ?? 'auto', serializeError(err)).catch(() => {});
      }
      if (action === 'rethrow') throw err;
      // 'disable' and 'rotate' both fall through to the next key.
    }
  }

  // Every key failed — surface the last error so the worker logs the real cause.
  throw lastErr;
}

/** Compact, loggable error shape stored in api_keys.last_error. */
function serializeError(err: unknown): Record<string, unknown> {
  const e = err as ProviderError;
  return { message: e?.message ?? String(err), status: e?.status, at: new Date().toISOString() };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Slot handle — structurally compatible with the queue package's `Slot`. */
export interface KeySlot {
  release: () => Promise<void>;
}

export interface WithKeySlotOptions {
  /**
   * Max concurrent jobs allowed PER KEY (the provider's per-account in-flight
   * cap, e.g. 2 for 69labs). Each active key gets its own pool of this size, so
   * N keys run up to N×perKeyMax jobs at once.
   */
  perKeyMax: number;
  /** Crash-safety lease for a held slot (must exceed one job's full span). */
  leaseMs: number;
  /**
   * Non-blocking slot claim, injected by the caller (Redis-backed in prod):
   * returns a handle if a slot under `slotKey` is free (pool cap `max`), else
   * null. Keeps this module decoupled from the queue/Redis layer.
   */
  tryAcquireSlot: (slotKey: string, max: number, opts: { leaseMs: number }) => Promise<KeySlot | null>;
  /** Build a key's slot-pool name, e.g. `id => '69labs.image:' + id`. */
  slotKeyFor: (keyId: string) => string;
  /** Legacy env key to run (on its own pool) until the api_keys table is set up. */
  fallbackKey?: string;
  /** How long to wait before re-checking when every key is at capacity. */
  pollMs?: number;
  signal?: AbortSignal;
}

/**
 * Like {@link withProviderKey}, but DISTRIBUTES load across all active keys
 * instead of funnelling every job through key #1.
 *
 * Each key gets its own concurrency pool of `perKeyMax` slots. A job grabs the
 * first key with a free slot, so two keys with perKeyMax=2 run 4 jobs at once
 * (2 per account) with no speculative `403 Concurrent limit` round-trips. When
 * every key is at capacity it waits for a slot to free; failover (disable a
 * dead key / rotate past a transient error / rethrow a content failure) matches
 * `withProviderKey` exactly. Total throughput is dynamic: it tracks the number
 * of *active* keys, so a disabled key simply drops capacity by perKeyMax.
 *
 *   const result = await withKeySlot('69labs', (apiKey) => labs69.image({ ...input, apiKey }), {
 *     perKeyMax: 2, leaseMs: 12 * 60_000, tryAcquireSlot,
 *     slotKeyFor: (id) => `69labs.image:${id}`, fallbackKey: process.env.LABS69_API_KEY,
 *   });
 *
 * `fn` also receives the chosen key's id (the db row id, or `'legacy'` for the
 * env fallback) so callers can apply per-key throttling — e.g. an hourly quota
 * bucket scoped to that key.
 */
export async function withKeySlot<T>(
  provider: string,
  fn: (apiKey: string, keyId: string) => Promise<T>,
  opts: WithKeySlotOptions,
): Promise<T> {
  const { perKeyMax, leaseMs, tryAcquireSlot, slotKeyFor, pollMs = 500, signal } = opts;
  const wait = () => sleep(pollMs + Math.floor(Math.random() * 150));
  // Keys we've already tried and that failed in THIS call — don't re-run them.
  const triedFailed = new Set<string>();
  let lastErr: unknown;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (signal?.aborted) throw new Error(`withKeySlot(${provider}) aborted`);
    const keys = await apiKeysRepo.listActive(provider);

    if (keys.length === 0) {
      // Table not populated yet → run the legacy env key on its own slot pool.
      const fallback = opts.fallbackKey?.trim();
      if (!fallback) throw new NoKeyAvailableError(provider);
      const slot = await tryAcquireSlot(slotKeyFor('legacy'), perKeyMax, { leaseMs });
      if (!slot) {
        await wait();
        continue;
      }
      try {
        return await fn(fallback, 'legacy');
      } finally {
        await slot.release();
      }
    }

    const candidates = keys.filter((k) => !triedFailed.has(k.id));
    // Every active key was tried and failed here — surface the real cause.
    if (candidates.length === 0) throw lastErr ?? new NoKeyAvailableError(provider);

    let gotSlot = false;
    for (const key of candidates) {
      const slot = await tryAcquireSlot(slotKeyFor(key.id), perKeyMax, { leaseMs });
      if (!slot) continue; // this key is at capacity — try another
      gotSlot = true;
      const apiKey = apiKeysRepo.decrypt(key.encryptedApiKey);
      try {
        const result = await fn(apiKey, key.id);
        void apiKeysRepo.markUsed(key.id).catch(() => {});
        return result;
      } catch (err) {
        lastErr = err;
        const { action, reason } = actionFor(err);
        if (action === 'disable') {
          void apiKeysRepo.disable(key.id, reason ?? 'auto', serializeError(err)).catch(() => {});
        }
        if (action === 'rethrow') throw err;
        // 'disable' and 'rotate' both fall through: don't reuse this key here.
        triedFailed.add(key.id);
      } finally {
        await slot.release();
      }
      // After a failure, re-list from the top (the key may now be disabled) and
      // pick another — break the per-key scan so candidates get recomputed.
      break;
    }

    // Every candidate key is busy (no free slot) — wait, then re-check.
    if (!gotSlot) await wait();
  }
}
