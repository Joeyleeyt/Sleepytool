import { and, asc, eq } from 'drizzle-orm';
import { db } from '../client.js';
import { apiKeys, type ApiKeyRow } from '../schema/apiKeys.js';
import { decryptSecret, encryptSecret, keyFingerprint } from '../crypto.js';

/** Active key projected to what rotation needs (no decrypted plaintext). */
export interface ActiveKey {
  id: string;
  encryptedApiKey: string;
}

export const apiKeysRepo = {
  /**
   * Register a key. Encrypts before insert — plaintext never hits the DB.
   * Idempotent: re-adding the same key (same fingerprint) just re-activates it.
   */
  async add(input: { provider?: string; apiKey: string; label?: string }): Promise<ApiKeyRow> {
    const provider = input.provider ?? '69labs';
    const [row] = await db
      .insert(apiKeys)
      .values({
        provider,
        label: input.label,
        encryptedApiKey: encryptSecret(input.apiKey),
        keyFingerprint: keyFingerprint(input.apiKey),
      })
      .onConflictDoUpdate({
        target: [apiKeys.provider, apiKeys.keyFingerprint],
        set: { isActive: true, disabledReason: null, label: input.label, updatedAt: new Date() },
      })
      .returning();
    return row!;
  },

  /** Active keys for a provider, oldest first → stable in-order rotation. */
  async listActive(provider = '69labs'): Promise<ActiveKey[]> {
    return db
      .select({ id: apiKeys.id, encryptedApiKey: apiKeys.encryptedApiKey })
      .from(apiKeys)
      .where(and(eq(apiKeys.provider, provider), eq(apiKeys.isActive, true)))
      .orderBy(asc(apiKeys.createdAt));
  },

  /** Decrypt a stored key's plaintext, just-in-time at point of use. */
  decrypt(encryptedApiKey: string): string {
    return decryptSecret(encryptedApiKey);
  },

  /** Bump last-used after a key successfully generated something. */
  async markUsed(id: string): Promise<void> {
    await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, id));
  },

  /** Turn a key off (manually, or automatically when it's clearly dead). */
  async disable(id: string, reason = 'manual', error?: unknown): Promise<void> {
    await db
      .update(apiKeys)
      .set({
        isActive: false,
        disabledReason: reason,
        lastError: (error ?? null) as object,
        updatedAt: new Date(),
      })
      .where(eq(apiKeys.id, id));
  },

  /** Turn a key back on and clear its disable reason. */
  async enable(id: string): Promise<void> {
    await db
      .update(apiKeys)
      .set({ isActive: true, disabledReason: null, updatedAt: new Date() })
      .where(eq(apiKeys.id, id));
  },

  /** Permanently delete a key. */
  async remove(id: string): Promise<void> {
    await db.delete(apiKeys).where(eq(apiKeys.id, id));
  },

  /** All keys for the CLI/UI — metadata only, never the secret. */
  async list(provider?: string) {
    return db
      .select({
        id: apiKeys.id,
        provider: apiKeys.provider,
        label: apiKeys.label,
        keyFingerprint: apiKeys.keyFingerprint,
        isActive: apiKeys.isActive,
        disabledReason: apiKeys.disabledReason,
        lastUsedAt: apiKeys.lastUsedAt,
        lastError: apiKeys.lastError,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .where(provider ? eq(apiKeys.provider, provider) : undefined)
      .orderBy(asc(apiKeys.provider), asc(apiKeys.createdAt));
  },
};
