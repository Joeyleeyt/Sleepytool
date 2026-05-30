import { NextResponse } from 'next/server';
import { promptsRepo, shotsRepo } from '@emberforge/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: { shotId: string } }) {
  const shot = await shotsRepo.findById(params.shotId);
  if (!shot) return NextResponse.json({ error: 'shot not found' }, { status: 404 });
  const rows = await promptsRepo.findByShot(params.shotId);
  return NextResponse.json({ shotId: params.shotId, prompts: rows });
}
