import { NextResponse } from 'next/server';
import { eventsRepo, projectsRepo } from '@emberforge/db';
import { startGenerateAssetsFlow } from '@emberforge/queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const ALLOWED = new Set(['prompted', 'generating_assets', 'assets_ready', 'failed']);

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const { id } = params;
  const project = await projectsRepo.findById(id);
  if (!project) return NextResponse.json({ error: 'project not found' }, { status: 404 });
  if (!ALLOWED.has(project.status)) {
    return NextResponse.json(
      {
        error: `cannot generate assets in status '${project.status}' — finish shot planning first`,
        status: project.status,
      },
      { status: 409 },
    );
  }
  await startGenerateAssetsFlow(id);
  await eventsRepo.emit(id, 'generate_assets', 'enqueued', { from: project.status });
  return NextResponse.json({ ok: true, projectId: id }, { status: 202 });
}
