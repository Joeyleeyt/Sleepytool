import { NextResponse } from 'next/server';
import { and, desc, eq, gt } from 'drizzle-orm';
import { db, schema } from '@emberforge/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const { id } = params;
  const sinceRaw = new URL(request.url).searchParams.get('since');
  const sinceId = sinceRaw ? Number(sinceRaw) : 0;
  const rows = await db
    .select()
    .from(schema.projectEvents)
    .where(and(eq(schema.projectEvents.projectId, id), gt(schema.projectEvents.id, sinceId)))
    .orderBy(desc(schema.projectEvents.id))
    .limit(50);
  return NextResponse.json({ events: rows });
}
