import { NextResponse } from 'next/server';
import { z } from 'zod';
import { eventsRepo, promptsRepo, shotsRepo } from '@emberforge/db';
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
    // project_events.project_id is FK'd to projects.id, so the event must carry
    // the PROJECT id — not the prompt's shotId (which would violate the FK and
    // 500 the whole PATCH, silently aborting the "Save & send" regenerate flow
    // before it ever re-enqueues the shot). Resolve it via the shot.
    const shot = await shotsRepo.findById(existing.shotId);
    if (shot) {
      await eventsRepo.emit(shot.projectId, 'prompt', 'edited', {
        promptId: params.id,
        shotId: existing.shotId,
        target: existing.target,
      });
    }
  }
  return NextResponse.json(row);
}
