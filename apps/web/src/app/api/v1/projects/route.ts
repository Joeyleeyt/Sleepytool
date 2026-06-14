import { NextResponse } from 'next/server';
import { CreateProjectSchema } from '@emberforge/core/schemas';
import { assetsRepo, eventsRepo, projectsRepo, transcriptsRepo } from '@emberforge/db';
import { startAnalysisFlow } from '@emberforge/queue';
import { parseJsonBody } from '@/lib/httpBody';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEV_OWNER_ID = process.env.DEV_OWNER_ID ?? '00000000-0000-0000-0000-000000000001';

export async function GET() {
  const rows = await projectsRepo.listByOwner(DEV_OWNER_ID, { limit: 100 });
  // Attach a thumbnail asset id per project (opening visual in plan order) so
  // the grid can render a real frame instead of a placeholder. The client signs
  // the URL lazily per asset id — we return only the stable id here so the list
  // can refetch on its 5s interval without re-signing (and thus reloading) every
  // thumbnail.
  const previews = await assetsRepo.firstVisualByProjects(rows.map((r) => r.id));
  const projects = rows.map((r) => {
    const preview = previews.get(r.id);
    return {
      ...r,
      previewAssetId: preview?.id ?? null,
      previewKind: preview?.kind ?? null,
    };
  });
  return NextResponse.json({ projects });
}

export async function POST(request: Request) {
  const body = await parseJsonBody(request, CreateProjectSchema);
  if (body instanceof NextResponse) return body;
  const project = await projectsRepo.create({
    ownerId: DEV_OWNER_ID,
    title: body.title,
    stylePreset: body.stylePreset,
    targetRes: body.targetRes,
    targetFps: body.targetFps,
  });
  await transcriptsRepo.create({ projectId: project.id, rawText: body.transcript });
  await eventsRepo.emit(project.id, 'ingest', 'succeeded', {
    wordCount: body.transcript.split(/\s+/).length,
  });
  // Phase 1 — analyze + segment. Stops at `segmented` so the user can review
  // scene breakdown + style preset before paying for shot classification.
  await startAnalysisFlow(project.id);
  return NextResponse.json(
    { projectId: project.id, status: project.status },
    { status: 201 },
  );
}
