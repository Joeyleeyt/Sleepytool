import { and, desc, eq, ne } from 'drizzle-orm';
import { db } from '../client.js';
import { prompts, shots } from '../schema/index.js';

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
   * Visual prompts (everything except the TTS prompt) for every shot in a
   * project. One query, used by /scenes so the board can show a per-shot
   * prompt preview without 1 fetch per card.
   *
   * Ordered by createdAt DESC so the caller (which collapses to one prompt
   * per shotId in a Map) deterministically keeps the MOST RECENT prompt row
   * — important when DISABLE_VEO3 flips mid-project and a shot ends up with
   * both a stale veo3 row and a fresh 69labs.video row.
   */
  async findVisualByProject(projectId: string) {
    return db
      .select({
        id: prompts.id,
        shotId: prompts.shotId,
        target: prompts.target,
        promptText: prompts.promptText,
        negative: prompts.negative,
      })
      .from(prompts)
      .innerJoin(shots, eq(shots.id, prompts.shotId))
      .where(and(eq(shots.projectId, projectId), ne(prompts.target, '69labs.tts')))
      .orderBy(desc(prompts.createdAt));
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
