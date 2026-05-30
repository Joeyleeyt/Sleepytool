import { NextResponse } from 'next/server';
import { eventsRepo, promptsRepo } from '@emberforge/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const body = (await request.json().catch(() => ({}))) as {
    promptText?: string;
    negative?: string | null;
  };
  if (typeof body.promptText !== 'string' && body.negative === undefined) {
    return NextResponse.json(
      { error: 'nothing to update — provide promptText and/or negative' },
      { status: 400 },
    );
  }
  const existing = await promptsRepo.findById(params.id);
  if (!existing) return NextResponse.json({ error: 'prompt not found' }, { status: 404 });
  const row = await promptsRepo.update(params.id, body);
  if (row) {
    await eventsRepo.emit(existing.shotId, 'prompt', 'edited', {
      promptId: params.id,
      target: existing.target,
    });
  }
  return NextResponse.json(row);
}
