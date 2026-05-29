import { and, eq, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { visualMemory } from '../schema/index.js';

export const visualMemoryRepo = {
  async upsert(row: typeof visualMemory.$inferInsert) {
    const [out] = await db
      .insert(visualMemory)
      .values(row)
      .onConflictDoUpdate({
        target: [visualMemory.projectId, visualMemory.kind, visualMemory.key],
        set: { descriptor: row.descriptor, usageCount: sql`${visualMemory.usageCount} + 1` },
      })
      .returning();
    return out!;
  },

  async findByProject(projectId: string) {
    return db.select().from(visualMemory).where(eq(visualMemory.projectId, projectId));
  },

  async findByKey(projectId: string, kind: string, key: string) {
    const [row] = await db
      .select()
      .from(visualMemory)
      .where(and(eq(visualMemory.projectId, projectId), eq(visualMemory.kind, kind), eq(visualMemory.key, key)))
      .limit(1);
    return row ?? null;
  },
};
