/**
 * Single-password auth for the EmberForge operator console.
 *
 * This is a SHARED-PASSWORD gate, not multi-user auth: one password (APP_PASSWORD)
 * unlocks the whole app. On success we mint a stateless session cookie — an HMAC
 * over an expiry timestamp signed with AUTH_SECRET — so no session store is needed.
 * The middleware verifies the cookie on every request.
 *
 * Everything here uses Web Crypto (crypto.subtle) and the global TextEncoder, with
 * NO Node-only imports, so it runs unchanged in BOTH the Edge middleware runtime
 * and the Node route handlers.
 */

export const SESSION_COOKIE = 'ef_session';

/** Session lifetime: 30 days. Re-login after that. */
export const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30;

const enc = new TextEncoder();

function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return bufToHex(sig);
}

/**
 * Constant-time comparison of two equal-purpose strings. Always compares the full
 * length so the timing doesn't leak how many leading characters matched. Used for
 * both the cookie signature check and the password check.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  // Length is allowed to leak (it's not secret for an HMAC hex digest), but a
  // length mismatch must still not short-circuit on the first differing char.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Mint a session token of the form `<expiryMs>.<hmac(expiryMs)>`. Stateless: the
 * expiry is carried in the token and protected by the signature, so a tampered
 * expiry fails verification.
 */
export async function createSessionToken(secret: string, nowMs: number): Promise<string> {
  const exp = String(nowMs + SESSION_MAX_AGE_S * 1000);
  const sig = await hmacHex(secret, exp);
  return `${exp}.${sig}`;
}

/** Verify a session token's signature and that it hasn't expired. */
export async function verifySessionToken(
  token: string,
  secret: string,
  nowMs: number,
): Promise<boolean> {
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const expStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= nowMs) return false;
  const expected = await hmacHex(secret, expStr);
  return timingSafeEqual(sig, expected);
}
