/**
 * Symmetric encryption for provider secrets (e.g. 69labs API keys) stored in
 * Postgres. We NEVER persist a provider key in plaintext — only the output of
 * `encryptSecret()`. Decryption happens just-in-time in a trusted process
 * (worker / web route) right before the key is used, and the plaintext is kept
 * only on the stack for the duration of one request.
 *
 * Algorithm: AES-256-GCM (authenticated encryption). GCM gives us
 * confidentiality AND tamper-detection — a flipped byte in the DB fails the
 * auth-tag check on decrypt instead of silently yielding garbage that then gets
 * sent to the provider as a bearer token.
 *
 * Master secret: `API_KEY_ENCRYPTION_SECRET`, a 32-byte key supplied via env
 * (Vercel / Fly secrets), NEVER committed and NEVER stored in Redis or the DB.
 * This is the one piece that must stay out of band: a leaked DB/cache dump is
 * useless without it. Generate one with:
 *
 *   openssl rand -base64 32
 *
 * Ciphertext envelope (single string, safe for a `text` column):
 *
 *   v1:<iv_b64>:<authTag_b64>:<ciphertext_b64>
 *
 * The leading version tag lets us rotate the algorithm/secret later without a
 * destructive migration (read both v1 and a future v2; re-encrypt lazily).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const VERSION = 'v1';
const IV_BYTES = 12; // 96-bit nonce — the standard/recommended size for GCM.

let cachedKey: Buffer | null = null;

/**
 * Resolve the 32-byte master key from `API_KEY_ENCRYPTION_SECRET`. Accepts the
 * secret as base64 (the `openssl rand -base64 32` form), hex (64 chars), or a
 * raw 32-char passphrase, so operators aren't forced into one encoding.
 */
function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.API_KEY_ENCRYPTION_SECRET;
  if (!raw) {
    throw new Error(
      'API_KEY_ENCRYPTION_SECRET not set — generate one with `openssl rand -base64 32`',
    );
  }
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    const b64 = Buffer.from(raw, 'base64');
    key = b64.length === 32 ? b64 : Buffer.from(raw, 'utf8');
  }
  if (key.length !== 32) {
    throw new Error(
      `API_KEY_ENCRYPTION_SECRET must decode to exactly 32 bytes (got ${key.length}). ` +
        'Generate one with `openssl rand -base64 32`.',
    );
  }
  cachedKey = key;
  return key;
}

/** Encrypt a plaintext secret into the versioned envelope described above. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/**
 * Decrypt an envelope produced by `encryptSecret()`. Throws if the version is
 * unknown, the envelope is malformed, or the auth tag fails (tampered/corrupt
 * ciphertext, or wrong master secret).
 */
export function decryptSecret(envelope: string): string {
  const parts = envelope.split(':');
  if (parts.length !== 4) throw new Error('malformed ciphertext envelope');
  const [version, ivB64, tagB64, ctB64] = parts;
  if (version !== VERSION) throw new Error(`unsupported ciphertext version: ${version}`);
  const decipher = createDecipheriv(ALGO, masterKey(), Buffer.from(ivB64!, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64!, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64!, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}

/**
 * Stable, non-reversible fingerprint of a plaintext key. Used to dedupe
 * (a `unique(provider, key_fingerprint)` constraint stops the same key being
 * added twice) and to refer to a key in logs/UI without exposing it. Truncated
 * to 12 hex chars — collision-safe at our key counts, and short enough to read.
 */
export function keyFingerprint(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex').slice(0, 12);
}
