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
