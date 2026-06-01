import { NextResponse } from 'next/server';
import { z } from 'zod';
import { eventsRepo, promptsRepo } from '@emberforge/db';
import { parseJsonBody } from '@/lib/httpBody';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PromptPatchSchema = z
  .object({
    promptText: z.string().optional(),
    negative: z.string().nullable().optional(),
  })
  .refine((b) => b.promptText !== undefined || b.negative !== undefined, {
    message: 'nothing to update — provide promptText and/or negative',
  });

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const body = await parseJsonBody(request, PromptPatchSchema);
  if (body instanceof NextResponse) return body;
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
