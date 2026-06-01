import { asc, eq } from 'drizzle-orm';
import { db } from '../client.js';
import { shots } from '../schema/index.js';

export const shotsRepo = {
  async bulkInsert(rows: (typeof shots.$inferInsert)[]) {
    if (rows.length === 0) return [];
    return db.insert(shots).values(rows).returning();
  },

  async findByProject(projectId: string) {
    return db.select().from(shots).where(eq(shots.projectId, projectId)).orderBy(asc(shots.ordinal));
  },

  async findByScene(sceneId: string) {
    return db.select().from(shots).where(eq(shots.sceneId, sceneId)).orderBy(asc(shots.ordinal));
  },

  async findById(id: string) {
    const [row] = await db.select().from(shots).where(eq(shots.id, id)).limit(1);
    return row ?? null;
  },

  /**
   * Overwrite per-shot `duration_s` after the narration-timing pass measures
   * the real per-scene TTS duration. Called once per shot with the
   * proportionally redistributed seconds.
   */
  async setDuration(id: string, durationS: number) {
    await db
      .update(shots)
      .set({ durationS: String(durationS) })
      .where(eq(shots.id, id));
  },
};
