import { and, asc, eq } from 'drizzle-orm';
import type { AssetKind } from '@emberforge/core';
import { db } from '../client.js';
import { assets, scenes, shots } from '../schema/index.js';

export const assetsRepo = {
  async create(row: typeof assets.$inferInsert) {
    const [out] = await db.insert(assets).values(row).returning();
    return out!;
  },

  async findByProject(projectId: string) {
    return db.select().from(assets).where(eq(assets.projectId, projectId));
  },

  /**
   * Live assets for a project, sorted in shot-plan order: scene order first,
   * then shot-within-scene order (see shotsRepo.findByProject for why both keys
   * are needed). The inner joins to `shots`/`scenes` drop assets whose `shotId`
   * is null — i.e. project-level or orphaned assets left behind when a shot was
   * deleted (assets.shot_id is ON DELETE SET NULL) — so only assets still bound
   * to a live shot come back. Use this for a flat, ordered manifest/export; the
   * render pipeline doesn't need it (buildTimeline already walks shots in plan
   * order and looks assets up by shot id).
   */
  async findByProjectInPlanOrder(projectId: string) {
    const rows = await db
      .select({ asset: assets })
      .from(assets)
      .innerJoin(shots, eq(assets.shotId, shots.id))
      .innerJoin(scenes, eq(shots.sceneId, scenes.id))
      .where(eq(assets.projectId, projectId))
      .orderBy(asc(scenes.ordinal), asc(shots.ordinal));
    return rows.map((r) => r.asset);
  },

  async findByShotKind(shotId: string, kind: AssetKind) {
    const [row] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.shotId, shotId), eq(assets.kind, kind)))
      .limit(1);
    return row ?? null;
  },

  /**
   * Delete asset row(s) for a shot (optionally narrowed by kind). Used by the
   * retry endpoint so the worker's cache check misses and a fresh generation
   * runs. The R2 object is NOT deleted — content-addressed keys mean a re-run
   * with the same prompt would just upload over it; with an edited prompt the
   * old object becomes unreferenced and can be cleaned by a separate sweep.
   */
  async deleteByShot(shotId: string, kind?: AssetKind) {
    const where = kind
      ? and(eq(assets.shotId, shotId), eq(assets.kind, kind))
      : eq(assets.shotId, shotId);
    return db.delete(assets).where(where);
  },
};
