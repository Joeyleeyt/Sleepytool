const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface RetryOpts {
  attempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  retriable?: (err: unknown) => boolean;
}

const defaultRetriable = (err: unknown): boolean => {
  const e = err as { status?: number; code?: string };
  if (e?.code === 'ETIMEDOUT' || e?.code === 'ECONNRESET' || e?.code === 'ECONNREFUSED') return true;
  if (e?.status && [408, 425, 429, 500, 502, 503, 504].includes(e.status)) return true;
  return false;
};

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const initialDelay = opts.initialDelayMs ?? 1000;
  const maxDelay = opts.maxDelayMs ?? 30_000;
  const retriable = opts.retriable ?? defaultRetriable;

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !retriable(err)) throw err;
      // Honor server-supplied Retry-After (set by 69labs on 429 etc.) before
      // falling back to capped exponential backoff with jitter.
      const e = err as { retryAfterMs?: number };
      const backoff = Math.min(maxDelay, initialDelay * 2 ** i) + Math.floor(Math.random() * 500);
      const delay = e?.retryAfterMs && e.retryAfterMs > 0 ? Math.min(maxDelay, e.retryAfterMs) : backoff;
      await sleep(delay);
    }
  }
  throw lastErr;
}
