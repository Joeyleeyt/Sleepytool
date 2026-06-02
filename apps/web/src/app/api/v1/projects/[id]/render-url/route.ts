import { NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '@emberforge/db';
import { signGet } from '@emberforge/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const { id } = params;
  const [r] = await db
    .select()
    .from(schema.renders)
    .where(and(eq(schema.renders.projectId, id), eq(schema.renders.status, 'succeeded')))
    .orderBy(desc(schema.renders.finishedAt))
    .limit(1);
  if (!r || !r.r2Key) {
    return NextResponse.json({ error: 'no completed render' }, { status: 404 });
  }
  return NextResponse.json({
    url: await signGet(r.r2Key, 3600),
    durationS: r.durationS,
    renderId: r.id,
  });
}
