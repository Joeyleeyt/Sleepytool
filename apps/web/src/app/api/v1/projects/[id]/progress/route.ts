import { NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { assetsRepo, db, projectsRepo, schema, shotsRepo } from '@emberforge/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const { id } = params;

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
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

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

  // `and` was imported only to mirror the Fastify file's import list — drop
  // if you want a leaner diff; it's harmless here.
  void and;

  return NextResponse.json({
    status: project.status,
    shots: { total: shots.length, ready, failed },
    cost: { totalUsd: totalCostUsd, byProvider },
    updatedAt: project.updatedAt,
  });
}
