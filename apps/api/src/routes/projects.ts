import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { CreateProjectSchema } from '@emberforge/core/schemas';
import {
  assetsRepo,
  db,
  eventsRepo,
  projectsRepo,
  schema,
  scenesRepo,
  shotsRepo,
  transcriptsRepo,
} from '@emberforge/db';
import { queues, startAssetsFlow, startRenderFlow } from '@emberforge/queue';
import { signGet } from '@emberforge/storage';

const DEV_OWNER_ID = process.env.DEV_OWNER_ID ?? '00000000-0000-0000-0000-000000000001';

const STAGE_DISPATCH: Record<
  string,
  { queue: keyof typeof queues; name: string; buildData: (projectId: string) => Record<string, unknown> }
> = {
  analyze:        { queue: 'analysis',     name: 'analyze',        buildData: (p) => ({ projectId: p, stage: 'analyze' }) },
  segment:        { queue: 'analysis',     name: 'segment',        buildData: (p) => ({ projectId: p, stage: 'segment' }) },
  classify:       { queue: 'analysis',     name: 'classify',       buildData: (p) => ({ projectId: p, stage: 'classify' }) },
  prompt:         { queue: 'prompt',       name: 'prompt',         buildData: (p) => ({ projectId: p }) },
  generateAssets: { queue: 'orchestrator', name: 'generateAssets', buildData: (p) => ({ projectId: p, stage: 'generateAssets' }) },
  buildTimeline:  { queue: 'timeline',     name: 'buildTimeline',  buildData: (p) => ({ projectId: p }) },
  mixAudio:       { queue: 'audio',        name: 'mixAudio',       buildData: (p) => ({ projectId: p }) },
  composite:      { queue: 'render',       name: 'composite',      buildData: (p) => ({ projectId: p, stage: 'composite' }) },
  encode:         { queue: 'render',       name: 'encode',         buildData: (p) => ({ projectId: p, stage: 'encode' }) },
  publish:        { queue: 'publish',      name: 'publish',        buildData: (p) => ({ projectId: p }) },
};

export async function projectsRoutes(app: FastifyInstance) {
  // ---- list ----
  app.get('/projects', async () => {
    const rows = await projectsRepo.listByOwner(DEV_OWNER_ID, { limit: 100 });
    return { projects: rows };
  });

  // ---- create ----
  app.post('/projects', async (req, reply) => {
    const body = CreateProjectSchema.parse(req.body);
    const project = await projectsRepo.create({
      ownerId: DEV_OWNER_ID,
      title: body.title,
      stylePreset: body.stylePreset,
      targetRes: body.targetRes,
      targetFps: body.targetFps,
    });
    await transcriptsRepo.create({ projectId: project.id, rawText: body.transcript });
    await eventsRepo.emit(project.id, 'ingest', 'succeeded', { wordCount: body.transcript.split(/\s+/).length });
    // Tree A: analyze → segment → classify → prompt → generateAssets.
    // Stops at `assets_ready` so the user can review every shot before paying
    // for the render. The render half is kicked off separately via
    // POST /v1/projects/:id/render.
    await startAssetsFlow(project.id);
    reply.code(201);
    return { projectId: project.id, status: project.status };
  });

  // ---- start render (Tree B) ----
  // Called from the UI once the user has reviewed the generated assets on
  // the Board and is ready to assemble the long-form video.
  app.post('/projects/:id/render', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = await projectsRepo.findById(id);
    if (!project) {
      reply.code(404);
      return { error: 'project not found' };
    }
    // Allow the render to fire from any post-assets state so the user can
    // re-render after a published or failed run.
    const RENDERABLE = new Set([
      'assets_ready',
      'timeline_built',
      'audio_mixed',
      'composited',
      'encoded',
      'published',
      'failed',
    ]);
    if (!RENDERABLE.has(project.status)) {
      reply.code(409);
      return {
        error: `cannot render in status '${project.status}' — assets are still generating`,
        status: project.status,
      };
    }
    await startRenderFlow(id);
    await eventsRepo.emit(id, 'render', 'enqueued', { status: project.status });
    reply.code(202);
    return { ok: true, projectId: id };
  });

  // ---- detail ----
  app.get('/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = await projectsRepo.findById(id);
    if (!p) {
      reply.code(404);
      return { error: 'project not found' };
    }
    return p;
  });

  // ---- scenes + shots + asset status ----
  app.get('/projects/:id/scenes', async (req) => {
    const { id } = req.params as { id: string };
    const [scenes, shots, assets] = await Promise.all([
      scenesRepo.findByProject(id),
      shotsRepo.findByProject(id),
      assetsRepo.findByProject(id),
    ]);

    const assetsByShot = new Map<string, typeof assets>();
    for (const a of assets) {
      if (!a.shotId) continue;
      const arr = assetsByShot.get(a.shotId) ?? [];
      arr.push(a);
      assetsByShot.set(a.shotId, arr);
    }

    const shotsByScene = new Map<string, typeof shots>();
    for (const s of shots) {
      const arr = shotsByScene.get(s.sceneId) ?? [];
      arr.push(s);
      shotsByScene.set(s.sceneId, arr);
    }

    return {
      scenes: scenes.map((scene) => ({
        ...scene,
        shots: (shotsByScene.get(scene.id) ?? []).map((shot) => {
          const a = assetsByShot.get(shot.id) ?? [];
          const visual = a.find((x) => x.kind === 'video_clip' || x.kind === 'image') ?? null;
          const narration = a.find((x) => x.kind === 'audio_narration') ?? null;
          return {
            ...shot,
            assets: {
              visual: visual ? { id: visual.id, kind: visual.kind, r2Key: visual.r2Key, durationS: visual.durationS } : null,
              narration: narration ? { id: narration.id, durationS: narration.durationS } : null,
            },
            status:
              visual && narration ? 'ready' :
              visual || narration ? 'partial' : 'pending',
          };
        }),
      })),
    };
  });

  // ---- progress + costs (single endpoint, polled by UI) ----
  app.get('/projects/:id/progress', async (req, reply) => {
    const { id } = req.params as { id: string };

    const [project, shots, assets, costRows] = await Promise.all([
      projectsRepo.findById(id),
      shotsRepo.findByProject(id),
      assetsRepo.findByProject(id),
      db
        .select({
          provider: schema.generations.provider,
          total: sql<string>`COALESCE(SUM(${schema.generations.costUsd}), 0)`,
          count: sql<string>`COUNT(*)`,
          failed: sql<string>`SUM(CASE WHEN ${schema.generations.status} = 'failed' THEN 1 ELSE 0 END)`,
        })
        .from(schema.generations)
        .innerJoin(schema.prompts, eq(schema.prompts.id, schema.generations.promptId))
        .innerJoin(schema.shots, eq(schema.shots.id, schema.prompts.shotId))
        .where(eq(schema.shots.projectId, id))
        .groupBy(schema.generations.provider),
    ]);

    if (!project) {
      reply.code(404);
      return { error: 'not found' };
    }

    // count "ready" shots = those with both a visual asset AND a narration asset
    const assetsByShot = new Map<string, typeof assets>();
    for (const a of assets) {
      if (!a.shotId) continue;
      const arr = assetsByShot.get(a.shotId) ?? [];
      arr.push(a);
      assetsByShot.set(a.shotId, arr);
    }
    let ready = 0;
    let failed = 0;
    for (const shot of shots) {
      const a = assetsByShot.get(shot.id) ?? [];
      const hasVisual = a.some((x) => x.kind === 'video_clip' || x.kind === 'image');
      const hasNarration = a.some((x) => x.kind === 'audio_narration');
      if (hasVisual && hasNarration) ready += 1;
    }
    for (const c of costRows) failed += Number(c.failed ?? 0);

    const totalCostUsd = costRows.reduce((sum, r) => sum + Number(r.total ?? 0), 0);
    const byProvider = costRows.reduce<Record<string, { cost: number; count: number }>>((acc, r) => {
      acc[r.provider] = { cost: Number(r.total ?? 0), count: Number(r.count ?? 0) };
      return acc;
    }, {});

    return {
      status: project.status,
      shots: { total: shots.length, ready, failed },
      cost: { totalUsd: totalCostUsd, byProvider },
      updatedAt: project.updatedAt,
    };
  });

  // ---- recent events (poll-friendly: ?since=<id>) ----
  app.get('/projects/:id/events', async (req) => {
    const { id } = req.params as { id: string };
    const { since } = req.query as { since?: string };
    const sinceId = since ? Number(since) : 0;
    const rows = await db
      .select()
      .from(schema.projectEvents)
      .where(and(eq(schema.projectEvents.projectId, id), gt(schema.projectEvents.id, sinceId)))
      .orderBy(desc(schema.projectEvents.id))
      .limit(50);
    return { events: rows };
  });

  // ---- latest render signed URL ----
  app.get('/projects/:id/render-url', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [r] = await db
      .select()
      .from(schema.renders)
      .where(and(eq(schema.renders.projectId, id), eq(schema.renders.status, 'succeeded')))
      .orderBy(desc(schema.renders.finishedAt))
      .limit(1);
    if (!r || !r.r2Key) {
      reply.code(404);
      return { error: 'no completed render' };
    }
    return { url: await signGet(r.r2Key, 3600), durationS: r.durationS, renderId: r.id };
  });

  // ---- replay a single stage ----
  app.post('/projects/:id/replay/:stage', async (req, reply) => {
    const { id, stage } = req.params as { id: string; stage: string };
    const dispatch = STAGE_DISPATCH[stage];
    if (!dispatch) {
      reply.code(400);
      return { error: `unknown stage: ${stage}`, validStages: Object.keys(STAGE_DISPATCH) };
    }
    const project = await projectsRepo.findById(id);
    if (!project) {
      reply.code(404);
      return { error: 'project not found' };
    }
    const job = await queues[dispatch.queue].add(dispatch.name, dispatch.buildData(id));
    await eventsRepo.emit(id, stage, 'replay_enqueued', { jobId: job.id, queue: dispatch.queue });
    return { ok: true, replay: { projectId: id, stage, jobId: job.id, queue: dispatch.queue } };
  });
}
