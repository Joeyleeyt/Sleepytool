import { and, desc, eq } from 'drizzle-orm';
import { assetsRepo, db, eventsRepo, schema, shotsRepo } from '@emberforge/db';

const RENDER_IN_FLIGHT = new Set([
  'timeline_built',
  'audio_mixed',
  'composited',
  'encoded',
]);

/**
 * Self-heal for the well-known "generateAssetsStage promise died on
 * orchestrator restart" footgun.
 *
 * `projects.status` only advances from `generating_assets` to `assets_ready`
 * when the orchestrator's `tree.job.waitUntilFinished()` resolves. That
 * promise only lives while the orchestrator process stays up — a restart
 * (Ctrl-C, file save under `tsx watch`, container redeploy) drops it, the
 * `setStatus` line never executes, and the status stays frozen forever even
 * though leaf workers continued and wrote every asset row.
 *
 * This function does what the dead promise would have done: check that every
 * shot in the project has BOTH a visual asset (video_clip or image) AND a
 * narration asset, and if so promote the status with a single conditional
 * UPDATE so only one caller wins the race.
 *
 * Returns the number of rows updated (0 = nothing changed, 1 = healed).
 *
 * Safe to call on every poll. Cheap: two SELECTs already needed by the page
 * anyway, plus the conditional UPDATE.
 */
export async function reconcileAssetsReady(projectId: string): Promise<number> {
  const [shots, assets] = await Promise.all([
    shotsRepo.findByProject(projectId),
    assetsRepo.findByProject(projectId),
  ]);
  if (shots.length === 0) return 0;

  const visualByShot = new Set<string>();
  const narrationByShot = new Set<string>();
  for (const a of assets) {
    if (!a.shotId) continue;
    if (a.kind === 'video_clip' || a.kind === 'image') visualByShot.add(a.shotId);
    if (a.kind === 'audio_narration') narrationByShot.add(a.shotId);
  }
  for (const s of shots) {
    if (!visualByShot.has(s.id) || !narrationByShot.has(s.id)) return 0;
  }

  // Conditional update. If two pollers race we want exactly one to win and
  // exactly one event row to be emitted, so the `from = generating_assets`
  // predicate is critical — the loser sees 0 rows updated and bails out.
  const updated = await db
    .update(schema.projects)
    .set({ status: 'assets_ready', updatedAt: new Date() })
    .where(and(eq(schema.projects.id, projectId), eq(schema.projects.status, 'generating_assets')))
    .returning({ id: schema.projects.id });

  if (updated.length === 0) return 0;

  await eventsRepo.emit(projectId, 'generateAssets', 'reconciled', {
    reason: 'API watchdog detected all assets present while status was generating_assets',
    shotCount: shots.length,
  });
  return 1;
}

/**
 * Render-stage twin of `reconcileAssetsReady`. The same `waitUntilFinished`
 * fragility lives in the render flow — if the orchestrator restarts during
 * the long composite/encode pass, `projects.status` sticks at `timeline_built`
 * / `audio_mixed` / `composited` / `encoded` forever even though render-worker
 * already inserted a `renders` row with `status='succeeded'` and uploaded the
 * mp4 to R2.
 *
 * This function checks: if status is one of the in-flight render states AND
 * there's a succeeded `renders` row for this project, promote to `published`.
 * Race-safe via the conditional UPDATE predicate.
 *
 * Returns 1 if it healed, 0 otherwise.
 */
export async function reconcileRenderPublished(projectId: string, currentStatus: string): Promise<number> {
  if (!RENDER_IN_FLIGHT.has(currentStatus)) return 0;

  // Is there a finished render row? We only need to know if one exists with
  // status='succeeded' — the actual r2_key etc. is fetched on demand by
  // /render-url.
  const [render] = await db
    .select({ id: schema.renders.id })
    .from(schema.renders)
    .where(and(eq(schema.renders.projectId, projectId), eq(schema.renders.status, 'succeeded')))
    .orderBy(desc(schema.renders.finishedAt))
    .limit(1);
  if (!render) return 0;

  // Conditional update against the snapshot we were given so a concurrent
  // poll can't double-fire the event row.
  const updated = await db
    .update(schema.projects)
    .set({ status: 'published', updatedAt: new Date() })
    .where(
      and(
        eq(schema.projects.id, projectId),
        eq(schema.projects.status, currentStatus as 'timeline_built'),
      ),
    )
    .returning({ id: schema.projects.id });
  if (updated.length === 0) return 0;

  await eventsRepo.emit(projectId, 'publish', 'reconciled', {
    reason: `API watchdog detected a succeeded render row while project status was '${currentStatus}'`,
    renderId: render.id,
    from: currentStatus,
  });
  return 1;
}
