import { eq } from 'drizzle-orm';
import { db } from '../client.js';
import { authCredential, type AuthCredentialRow } from '../schema/auth.js';

/** The pinned id of the single shared-password row (see schema/auth.ts). */
const SINGLETON = 'singleton';

export const authRepo = {
  /** The stored credential, or null before it's been bootstrapped. */
  async get(): Promise<AuthCredentialRow | null> {
    const [row] = await db
      .select()
      .from(authCredential)
      .where(eq(authCredential.id, SINGLETON))
      .limit(1);
    return row ?? null;
  },

  /**
   * Set (or replace) the shared password hash. Upsert on the singleton id so the
   * first call bootstraps the row and every later call is a change-password.
   */
  async setHash(passwordHash: string): Promise<void> {
    await db
      .insert(authCredential)
      .values({ id: SINGLETON, passwordHash })
      .onConflictDoUpdate({
        target: authCredential.id,
        set: { passwordHash, updatedAt: new Date() },
      });
  },
};
