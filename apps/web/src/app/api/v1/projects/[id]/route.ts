import { NextResponse } from 'next/server';
import { eventsRepo, projectsRepo } from '@emberforge/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STYLE_PRESETS = ['cinematic_dark_ember', 'cosmic_minimal', 'noir_documentary', 'warm_archival'];

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const p = await projectsRepo.findById(params.id);
  if (!p) return NextResponse.json({ error: 'project not found' }, { status: 404 });
  return NextResponse.json(p);
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const body = (await request.json().catch(() => ({}))) as {
    title?: string;
    stylePreset?: string;
    targetRes?: '1920x1080' | '3840x2160';
    targetFps?: 24 | 30 | 60;
  };
  if (body.stylePreset && !STYLE_PRESETS.includes(body.stylePreset)) {
    return NextResponse.json({ error: `unknown stylePreset '${body.stylePreset}'` }, { status: 400 });
  }
  const row = await projectsRepo.update(params.id, body);
  if (!row) return NextResponse.json({ error: 'project not found' }, { status: 404 });
  await eventsRepo.emit(params.id, 'project', 'updated', body as Record<string, unknown>);
  return NextResponse.json(row);
}
