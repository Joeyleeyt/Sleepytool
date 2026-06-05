import { asc, eq } from 'drizzle-orm';
import { db } from '../client.js';
import { scenes, shots } from '../schema/index.js';

export const shotsRepo = {
  async bulkInsert(rows: (typeof shots.$inferInsert)[]) {
    if (rows.length === 0) return [];
    return db.insert(shots).values(rows).returning();
  },

  /**
   * Project-wide shot order MUST be (scene order, shot-within-scene order).
   * `shots.ordinal` is per-scene (it resets to 0 for each scene — see the
   * (scene_id, ordinal) unique index), so ordering by it alone interleaves
   * scenes (every scene's shot 0, then every scene's shot 1, …) and ties are
   * broken arbitrarily. Joining scenes and ordering by `scenes.ordinal` first
   * gives the true narrative order the timeline/render pipeline depends on.
   */
  async findByProject(projectId: string) {
    const rows = await db
      .select({ shot: shots })
      .from(shots)
      .innerJoin(scenes, eq(shots.sceneId, scenes.id))
      .where(eq(shots.projectId, projectId))
      .orderBy(asc(scenes.ordinal), asc(shots.ordinal));
    return rows.map((r) => r.shot);
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
