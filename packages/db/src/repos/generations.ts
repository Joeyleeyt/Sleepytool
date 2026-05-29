import { eq } from 'drizzle-orm';
import type { GenStatus } from '@emberforge/core';
import { db } from '../client.js';
import { generations } from '../schema/index.js';

export const generationsRepo = {
  async create(row: typeof generations.$inferInsert) {
    const [out] = await db.insert(generations).values(row).returning();
    return out!;
  },

  async markStarted(id: string) {
    await db.update(generations).set({ status: 'running', startedAt: new Date() }).where(eq(generations.id, id));
  },

  async markSucceeded(id: string, opts: { providerJobId?: string; costUsd?: number; latencyMs?: number }) {
    await db
      .update(generations)
      .set({
        status: 'succeeded',
        providerJobId: opts.providerJobId,
        costUsd: opts.costUsd != null ? String(opts.costUsd) : undefined,
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
