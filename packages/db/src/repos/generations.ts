import { and, desc, eq, gte, inArray, isNotNull, lt } from 'drizzle-orm';
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

  /**
   * Latest in-progress generation per (shotId, provider) in a project — i.e.
   * rows still `queued` or `running`. Used by /scenes to tell the UI whether a
   * shot's leg is sitting in the worker queue (no providerJobId yet) or has
   * been submitted to the provider and is rendering (providerJobId set).
   * Ordered startedAt DESC NULLS LAST so the freshest attempt wins per leg.
   */
  async findActiveByProject(projectId: string) {
    const rows = await db
      .select({
        id: generations.id,
        shotId: prompts.shotId,
        provider: generations.provider,
        status: generations.status,
        providerJobId: generations.providerJobId,
        startedAt: generations.startedAt,
      })
      .from(generations)
      .innerJoin(prompts, eq(prompts.id, generations.promptId))
      .innerJoin(shots, eq(shots.id, prompts.shotId))
      .where(
        and(
          eq(shots.projectId, projectId),
          inArray(generations.status, ['queued', 'running'] as GenStatus[]),
        ),
      )
      .orderBy(desc(generations.startedAt));
    return rows;
  },

  /**
   * Recent non-succeeded generations (failed / still running / queued) joined
   * to their shot, newest first. Used by scripts to diagnose why some shot
   * assets didn't generate. Optionally scoped to one project.
   */
  async findRecentUnsuccessful(opts: { sinceMs: number; projectId?: string }) {
    const since = new Date(Date.now() - opts.sinceMs);
    const filters = [
      inArray(generations.status, ['failed', 'running', 'queued'] as GenStatus[]),
      gte(generations.startedAt, since),
    ];
    if (opts.projectId) filters.push(eq(shots.projectId, opts.projectId));
    return db
      .select({
        genId: generations.id,
        status: generations.status,
        provider: generations.provider,
        providerJobId: generations.providerJobId,
        error: generations.error,
        startedAt: generations.startedAt,
        finishedAt: generations.finishedAt,
        shotId: prompts.shotId,
        visualType: shots.visualType,
        projectId: shots.projectId,
      })
      .from(generations)
      .innerJoin(prompts, eq(prompts.id, generations.promptId))
      .innerJoin(shots, eq(shots.id, prompts.shotId))
      .where(and(...filters))
      .orderBy(desc(generations.startedAt));
  },

  /**
   * In-flight ('running') generations that still hold a provider job id and
   * started before `before`. Used by scripts/reap-69labs-orphans.ts to cancel
   * jobs left behind by a crashed/killed worker so they release their provider
   * concurrency slot.
   */
  async findStaleRunning(before: Date) {
    return db
      .select({
        id: generations.id,
        provider: generations.provider,
        providerJobId: generations.providerJobId,
        startedAt: generations.startedAt,
      })
      .from(generations)
      .where(
        and(
          eq(generations.status, 'running' as GenStatus),
          isNotNull(generations.providerJobId),
          lt(generations.startedAt, before),
        ),
      );
  },

  // `providerJobId` is recorded here, at submit time, so an in-flight job is
  // recoverable/cancelable even if the worker dies mid-poll (otherwise the id
  // is only persisted on success and the job leaks a provider concurrency slot
  // — see scripts/reap-69labs-orphans.ts).
  async markStarted(id: string, providerJobId?: string) {
    await db
      .update(generations)
      .set({ status: 'running', startedAt: new Date(), ...(providerJobId ? { providerJobId } : {}) })
      .where(eq(generations.id, id));
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
