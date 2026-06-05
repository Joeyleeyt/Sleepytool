import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiKeysRepo } from '@emberforge/db';
import { parseJsonBody } from '@/lib/httpBody';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 *   PATCH  /api/v1/keys/:id   { action: 'enable' | 'disable' }
 *   DELETE /api/v1/keys/:id   → permanently remove
 */
const PatchSchema = z.object({ action: z.enum(['enable', 'disable']) });

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const body = await parseJsonBody(request, PatchSchema);
  if (body instanceof NextResponse) return body;

  try {
    if (body.action === 'enable') await apiKeysRepo.enable(params.id);
    else await apiKeysRepo.disable(params.id, 'manual');
    return NextResponse.json({ ok: true, id: params.id, action: body.action });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  try {
    await apiKeysRepo.remove(params.id);
    return NextResponse.json({ ok: true, id: params.id });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
