import { NextResponse } from 'next/server';
import { eventsRepo, projectsRepo } from '@emberforge/db';
import { startRenderFlow } from '@emberforge/queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RENDERABLE = new Set([
  'assets_ready',
  'timeline_built',
  'audio_mixed',
  'composited',
  'encoded',
  'published',
  'failed',
]);

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const { id } = params;
  const project = await projectsRepo.findById(id);
  if (!project) return NextResponse.json({ error: 'project not found' }, { status: 404 });
  if (!RENDERABLE.has(project.status)) {
    return NextResponse.json(
      { error: `cannot render in status '${project.status}' — assets are still generating`, status: project.status },
      { status: 409 },
    );
  }
  await startRenderFlow(id);
  await eventsRepo.emit(id, 'render', 'enqueued', { status: project.status });
  return NextResponse.json({ ok: true, projectId: id }, { status: 202 });
}
