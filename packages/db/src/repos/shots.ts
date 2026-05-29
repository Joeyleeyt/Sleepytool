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
};
