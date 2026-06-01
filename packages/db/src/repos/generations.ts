import { and, desc, eq } from 'drizzle-orm';
import type { GenStatus } from '@emberforge/core';
import { db } from '../client.js';
import { generations, prompts, shots } from '../schema/index.js';

export const generationsRepo = {
  async create(row: typeof generations.$inferInsert) {
    const [out] = await db.insert(generations).values(row).returning();
    return out!;
  },

  /**
   * Latest failed generation per (shotId, provider) in a project. Used by
   * /scenes to surface a per-shot failure reason in the UI and by the retry
   * endpoint to know which leaf jobs to re-enqueue.
   */
  async findFailedByProject(projectId: string) {
    const rows = await db
      .select({
        id: generations.id,
        shotId: prompts.shotId,
        provider: generations.provider,
        error: generations.error,
        finishedAt: generations.finishedAt,
      })
      .from(generations)
      .innerJoin(prompts, eq(prompts.id, generations.promptId))
      .innerJoin(shots, eq(shots.id, prompts.shotId))
      .where(and(eq(shots.projectId, projectId), eq(generations.status, 'failed' as GenStatus)))
      .orderBy(desc(generations.finishedAt));
    return rows;
  },

  async markStarted(id: string) {
    await db.update(generations).set({ status: 'running', startedAt: new Date() }).where(eq(generations.id, id));
  },

  async markSucceeded(id: string, opts: { providerJobId?: string; latencyMs?: number }) {
    await db
      .update(generations)
      .set({
        status: 'succeeded',
        providerJobId: opts.providerJobId,
        latencyMs: opts.latencyMs,
        finishedAt: new Date(),
      })
      .where(eq(generations.id, id));
  },

  async markFailed(id: string, error: unknown) {
    await db
      .update(generations)
      .set({ status: 'failed' as GenStatus, error: error as object, finishedAt: new Date() })
      .where(eq(generations.id, id));
  },
};
