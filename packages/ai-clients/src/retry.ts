const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface RetryOpts {
  attempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  retriable?: (err: unknown) => boolean;
  // Throttle errors (HTTP 429 + the 69labs concurrency-cap 403) get their OWN,
  // more patient budget: they clear on the order of seconds-to-minutes as
  // in-flight jobs finish, so a couple of 1–2s retries (the generic budget)
  // almost never rides them out. Kept separate so genuine transient failures
  // (5xx, socket resets) still fail fast — important for the LLM clients that
  // share this helper.
  throttleAttempts?: number;
  throttleInitialDelayMs?: number;
  throttleMaxDelayMs?: number;
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

// A handful of providers return a non-retryable-looking status for what is
// actually a transient throttle. 69labs answers `403 FORBIDDEN` when the
// account's concurrent-job cap is reached ("Concurrent video generation limit
// reached (5)") — but slots free up as in-flight jobs finish, so this IS worth
// retrying with backoff. Matched by message so genuine 403s (bad/expired key,
// real authorization failures) still fail fast.
const RETRYABLE_403_MESSAGE_PATTERNS = [/concurrent[^]*limit reached/i];

// Cloudflare origin-side 5xx (520–527): the edge reached 69labs's origin but it
// timed out / refused / is down (522 = "Connection timed out"). These are
// provider OUTAGES that clear on the order of minutes, so they belong on the
// patient budget — not the fast generic one that would burn 3 retries in ~3s.
const CLOUDFLARE_ORIGIN_CODES = new Set([520, 521, 522, 523, 524, 525, 526, 527]);

// Errors that mean "valid request, the provider just needs a moment" — retried
// on the patient budget rather than the fast generic one:
//   • HTTP 429                       — too many requests
//   • 69labs concurrency-cap 403     — all provider slots busy
//   • Cloudflare origin 5xx (520–527) — provider origin down/overloaded
const isPatient = (err: unknown): boolean => {
  const e = err as { status?: number; message?: string };
  if (e?.status === 429) return true;
  if (e?.status && CLOUDFLARE_ORIGIN_CODES.has(e.status)) return true;
  if (e?.status === 403 && e?.message && RETRYABLE_403_MESSAGE_PATTERNS.some((re) => re.test(e.message!))) {
    return true;
  }
  return false;
};

const defaultRetriable = (err: unknown): boolean => {
  const e = err as { status?: number; code?: string; message?: string; cause?: unknown };
  if (e?.code && TRANSIENT_CODES.has(e.code)) return true;
  if (e?.status && [408, 425, 429, 500, 502, 503, 504].includes(e.status)) return true;
  if (isPatient(err)) return true;
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
  // Throttle defaults: ~6 tries growing 5s→10s→20s→40s→60s ≈ up to ~3 min of
  // patience, enough to outlast a typical concurrency-cap window.
  const throttleAttempts = opts.throttleAttempts ?? 6;
  const throttleInitialDelay = opts.throttleInitialDelayMs ?? 5_000;
  const throttleMaxDelay = opts.throttleMaxDelayMs ?? 60_000;
  const retriable = opts.retriable ?? defaultRetriable;

  // Two independent budgets: patient errors (throttle / provider outage) don't
  // burn the (small) generic budget and vice-versa, so a flurry of 429s/522s
  // can't starve the retries we'd want for a transient socket reset.
  let genericTries = 0;
  let patientTries = 0;

  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!retriable(err)) throw err;

      const patient = isPatient(err);
      const tryIndex = patient ? patientTries++ : genericTries++;
      const budget = patient ? throttleAttempts : attempts;
      // Exhausted this category's budget → give up (surface the real error).
      if (tryIndex >= budget - 1) throw err;

      const base = patient ? throttleInitialDelay : initialDelay;
      const cap = patient ? throttleMaxDelay : maxDelay;
      // Honor server-supplied Retry-After (set by 69labs on 429 etc.) before
      // falling back to capped exponential backoff with jitter.
      const e = err as { retryAfterMs?: number };
      const backoff = Math.min(cap, base * 2 ** tryIndex) + Math.floor(Math.random() * 500);
      const delay = e?.retryAfterMs && e.retryAfterMs > 0 ? Math.min(cap, e.retryAfterMs) : backoff;
      await sleep(delay);
    }
  }
}
