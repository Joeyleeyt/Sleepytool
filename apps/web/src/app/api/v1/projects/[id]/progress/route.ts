import { NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { assetsRepo, db, projectsRepo, schema, shotsRepo } from '@emberforge/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const { id } = params;

  // Count failed generations per project. Kept as a single grouped query (vs
  // a count on the assets table) because BullMQ jobs can fail multiple times
  // and we want the raw failure count, not just the latest cached state.
  const [project, shots, assets, failedRows] = await Promise.all([
    projectsRepo.findById(id),
    shotsRepo.findByProject(id),
    assetsRepo.findByProject(id),
    db
      .select({
        failed: sql<string>`SUM(CASE WHEN ${schema.generations.status} = 'failed' THEN 1 ELSE 0 END)`,
      })
      .from(schema.generations)
      .innerJoin(schema.prompts, eq(schema.prompts.id, schema.generations.promptId))
      .innerJoin(schema.shots, eq(schema.shots.id, schema.prompts.shotId))
      .where(eq(schema.shots.projectId, id)),
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
  for (const shot of shots) {
    const a = assetsByShot.get(shot.id) ?? [];
    const hasVisual = a.some((x) => x.kind === 'video_clip' || x.kind === 'image');
    const hasNarration = a.some((x) => x.kind === 'audio_narration');
    if (hasVisual && hasNarration) ready += 1;
  }
  const failed = Number(failedRows[0]?.failed ?? 0);

  return NextResponse.json({
    status: project.status,
    shots: { total: shots.length, ready, failed },
    updatedAt: project.updatedAt,
  });
}
