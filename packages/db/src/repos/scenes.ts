import { asc, eq } from 'drizzle-orm';
import { db } from '../client.js';
import { scenes } from '../schema/index.js';

export const scenesRepo = {
  async bulkInsert(rows: (typeof scenes.$inferInsert)[]) {
    if (rows.length === 0) return [];
    return db.insert(scenes).values(rows).returning();
  },

  async findByProject(projectId: string) {
    return db.select().from(scenes).where(eq(scenes.projectId, projectId)).orderBy(asc(scenes.ordinal));
  },

  async deleteByProject(projectId: string) {
    await db.delete(scenes).where(eq(scenes.projectId, projectId));
  },

  /**
   * Overwrite a scene's `estimated_dur_s` with a measured value. Used by the
   * narration-timing stage to record the real per-scene TTS duration so the
   * UI's "Runtime" stat and downstream estimates reflect actual pacing.
   */
  async setEstimatedDuration(id: string, durationS: number) {
    await db
      .update(scenes)
      .set({ estimatedDurS: String(durationS) })
      .where(eq(scenes.id, id));
  },
};
