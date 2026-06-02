import { NextResponse } from 'next/server';
import { eventsRepo } from '@emberforge/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Veo 3 async-completion webhook. Polling inside the worker is still primary;
 * this hook just wakes faster by emitting an event tagged with the project.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    jobId?: string;
    projectId?: string;
    status?: string;
  };
  if (body.projectId) {
    await eventsRepo.emit(body.projectId, 'veo3', `webhook:${body.status ?? 'unknown'}`, body);
  }
  return NextResponse.json({ ok: true });
}
