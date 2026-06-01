import { NextResponse } from 'next/server';
import { z } from 'zod';
import { eventsRepo, projectsRepo } from '@emberforge/db';
import { parseJsonBody } from '@/lib/httpBody';
import { reconcileAssetsReady, reconcileRenderPublished } from '@/lib/reconcile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STYLE_PRESETS = ['cinematic_dark_ember', 'cosmic_minimal', 'noir_documentary', 'warm_archival'] as const;

const ProjectPatchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  stylePreset: z.enum(STYLE_PRESETS).optional(),
  targetRes: z.enum(['1920x1080', '3840x2160']).optional(),
  targetFps: z.union([z.literal(24), z.literal(30), z.literal(60)]).optional(),
});

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  let p = await projectsRepo.findById(params.id);
  if (!p) return NextResponse.json({ error: 'project not found' }, { status: 404 });

  // Self-heal the well-known "wait promise died on orchestrator restart"
  // footgun. Two transition paths can stick — generate-assets and render.
  // Both pre-check status cheaply so the no-op case is one in-memory compare.
  if (p.status === 'generating_assets') {
    const healed = await reconcileAssetsReady(p.id);
    if (healed > 0) {
      const fresh = await projectsRepo.findById(p.id);
      if (fresh) p = fresh;
    }
  } else {
    const healed = await reconcileRenderPublished(p.id, p.status);
    if (healed > 0) {
      const fresh = await projectsRepo.findById(p.id);
      if (fresh) p = fresh;
    }
  }

  return NextResponse.json(p);
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const body = await parseJsonBody(request, ProjectPatchSchema);
  if (body instanceof NextResponse) return body;
  const row = await projectsRepo.update(params.id, body);
  if (!row) return NextResponse.json({ error: 'project not found' }, { status: 404 });
  await eventsRepo.emit(params.id, 'project', 'updated', body as Record<string, unknown>);
  return NextResponse.json(row);
}
