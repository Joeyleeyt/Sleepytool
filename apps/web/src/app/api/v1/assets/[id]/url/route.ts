import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@emberforge/db';
import { signGet } from '@emberforge/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const [a] = await db.select().from(schema.assets).where(eq(schema.assets.id, params.id)).limit(1);
  if (!a) return NextResponse.json({ error: 'asset not found' }, { status: 404 });
  return NextResponse.json({
    url: await signGet(a.r2Key, 3600),
    kind: a.kind,
    durationS: a.durationS,
    bytes: a.bytes,
  });
}
