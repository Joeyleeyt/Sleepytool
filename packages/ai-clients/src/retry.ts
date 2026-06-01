const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface RetryOpts {
  attempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  retriable?: (err: unknown) => boolean;
}

const TRANSIENT_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  // undici socket errors — see https://github.com/nodejs/undici/blob/main/types/errors.d.ts
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_RESPONSE_TIMEOUT',
]);

const TRANSIENT_MESSAGE_PATTERNS = [
  // undici wraps socket EOF as plain TypeError without a code; the message
  // is our only signal that the remote end hung up mid-request.
  /other side closed/i,
  /socket hang up/i,
  /Premature close/i,
  /fetch failed/i,
];

const defaultRetriable = (err: unknown): boolean => {
  const e = err as { status?: number; code?: string; message?: string; cause?: unknown };
  if (e?.code && TRANSIENT_CODES.has(e.code)) return true;
  if (e?.status && [408, 425, 429, 500, 502, 503, 504].includes(e.status)) return true;
  // undici puts the real network error on `.cause`; check it the same way.
  if (e?.cause) {
    const c = e.cause as { code?: string; message?: string };
    if (c.code && TRANSIENT_CODES.has(c.code)) return true;
    if (c.message && TRANSIENT_MESSAGE_PATTERNS.some((re) => re.test(c.message!))) return true;
  }
  if (e?.message && TRANSIENT_MESSAGE_PATTERNS.some((re) => re.test(e.message!))) return true;
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
