import { and, eq } from 'drizzle-orm';
import type { AssetKind } from '@emberforge/core';
import { db } from '../client.js';
import { assets } from '../schema/index.js';

export const assetsRepo = {
  async create(row: typeof assets.$inferInsert) {
    const [out] = await db.insert(assets).values(row).returning();
    return out!;
  },

  async findByProject(projectId: string) {
    return db.select().from(assets).where(eq(assets.projectId, projectId));
  },

  async findByShotKind(shotId: string, kind: AssetKind) {
    const [row] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.shotId, shotId), eq(assets.kind, kind)))
      .limit(1);
    return row ?? null;
  },
};
