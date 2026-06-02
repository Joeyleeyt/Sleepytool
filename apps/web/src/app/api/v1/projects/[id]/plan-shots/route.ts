import { NextResponse } from 'next/server';
import { eventsRepo, projectsRepo } from '@emberforge/db';
import { startShotPlanningFlow } from '@emberforge/queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const ALLOWED = new Set(['segmented', 'classified', 'prompted', 'failed']);

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const { id } = params;
  const project = await projectsRepo.findById(id);
  if (!project) return NextResponse.json({ error: 'project not found' }, { status: 404 });
  if (!ALLOWED.has(project.status)) {
    return NextResponse.json(
      { error: `cannot plan shots in status '${project.status}'`, status: project.status },
      { status: 409 },
    );
  }
  await startShotPlanningFlow(id);
  await eventsRepo.emit(id, 'plan_shots', 'enqueued', { from: project.status });
  return NextResponse.json({ ok: true, projectId: id }, { status: 202 });
}
