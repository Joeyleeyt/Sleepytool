/**
 * Password hashing for the shared operator password (stored in the
 * auth_credential DB row). Uses Node's scrypt — a deliberately slow, salted KDF
 * — so a leaked DB dump can't be brute-forced cheaply.
 *
 * Node-only (node:crypto): import this ONLY from Node-runtime route handlers
 * (/api/login, /api/change-password). Do NOT import it from the Edge middleware —
 * middleware verifies the session token via the Web-Crypto helpers in lib/auth.ts,
 * never the password itself.
 *
 * Stored format (single string, safe for a text column):
 *   scrypt:<salt_b64>:<hash_b64>
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const VERSION = 'scrypt';
const SALT_BYTES = 16;
const KEY_BYTES = 64;

/** Hash a plaintext password into the salted envelope above. */
export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(plain, salt, KEY_BYTES);
  return `${VERSION}:${salt.toString('base64')}:${hash.toString('base64')}`;
}

/**
 * Verify a plaintext password against a stored envelope. Constant-time on the
 * digest comparison; returns false (never throws) on any malformed envelope.
 */
export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== VERSION) return false;
  const salt = Buffer.from(parts[1]!, 'base64');
  const expected = Buffer.from(parts[2]!, 'base64');
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = scryptSync(plain, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
