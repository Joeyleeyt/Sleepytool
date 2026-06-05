import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiKeysRepo } from '@emberforge/db';
import { parseJsonBody } from '@/lib/httpBody';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 69labs API key pool.
 *
 *   GET  /api/v1/keys   → all keys (metadata only — never the secret)
 *   POST /api/v1/keys   → add a key  { apiKey, label?, provider? }
 *
 * The secret is encrypted before storage and is NEVER returned by any endpoint
 * — the UI only ever sees the fingerprint + label.
 */
export async function GET() {
  try {
    const keys = await apiKeysRepo.list();
    return NextResponse.json({ keys });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

const AddKeySchema = z.object({
  apiKey: z.string().trim().min(8, 'key looks too short'),
  label: z.string().trim().max(40).optional(),
  provider: z.string().trim().optional(),
});

export async function POST(request: Request) {
  const body = await parseJsonBody(request, AddKeySchema);
  if (body instanceof NextResponse) return body;

  try {
    const row = await apiKeysRepo.add(body);
    return NextResponse.json(
      {
        id: row.id,
        provider: row.provider,
        label: row.label,
        fingerprint: row.keyFingerprint,
        isActive: row.isActive,
      },
      { status: 201 },
    );
  } catch (err) {
    // e.g. API_KEY_ENCRYPTION_SECRET not set, or DB unreachable — surface the
    // reason cleanly so the UI shows it instead of a raw 500 stack.
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
