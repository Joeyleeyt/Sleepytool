import { and, eq } from 'drizzle-orm';
import { db } from '../client.js';
import { prompts } from '../schema/index.js';

export const promptsRepo = {
  async upsert(row: typeof prompts.$inferInsert) {
    const [out] = await db
      .insert(prompts)
      .values(row)
      .onConflictDoUpdate({
        target: [prompts.shotId, prompts.target, prompts.inputHash],
        set: { promptText: row.promptText, params: row.params, negative: row.negative },
      })
      .returning();
    return out!;
  },

  async findForShot(shotId: string, target: string) {
    const [row] = await db
      .select()
      .from(prompts)
      .where(and(eq(prompts.shotId, shotId), eq(prompts.target, target)))
      .limit(1);
    return row ?? null;
  },

  async findById(id: string) {
    const [row] = await db.select().from(prompts).where(eq(prompts.id, id)).limit(1);
    return row ?? null;
  },

  async findByShot(shotId: string) {
    return db.select().from(prompts).where(eq(prompts.shotId, shotId));
  },

  /**
   * Patch the prompt text / negative for a prompt row. This is the
   * "user override" path — the worker still looks up the row by
   * (shotId, target) and uses promptText verbatim, so future regenerations
   * pick up the new text automatically.
   *
   * Note: inputHash is NOT recomputed here. That means a re-run with the
   * same hash would still hit the R2 cache and reuse the old asset. The
   * caller (UI) is expected to delete the existing asset row first so the
   * worker treats the next attempt as a fresh generation.
   */
  async update(id: string, patch: { promptText?: string; negative?: string | null }) {
    const [row] = await db
      .update(prompts)
      .set(patch)
      .where(eq(prompts.id, id))
      .returning();
    return row ?? null;
  },
};
