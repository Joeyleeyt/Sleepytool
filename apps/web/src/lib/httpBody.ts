import { NextResponse } from 'next/server';
import { ZodError, type ZodTypeAny, type z } from 'zod';

/**
 * Parse + validate a Route Handler's JSON body.
 *
 * Returns the validated object on success. On any failure (unreadable body,
 * malformed JSON, schema mismatch) returns a `NextResponse` carrying a 400
 * with a consistent error shape — the caller just `return`s it.
 *
 *   const body = await parseJsonBody(request, MySchema);
 *   if (body instanceof NextResponse) return body;
 *
 * Without this helper, `await request.json()` throws on malformed input and
 * crashes the handler with a 500. Each route was reinventing its own
 * try/catch (or, worse, swallowing errors with `.catch(() => ({}))` and then
 * trusting the result).
 */
export async function parseJsonBody<S extends ZodTypeAny>(
  request: Request,
  schema: S,
): Promise<z.infer<S> | NextResponse> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid JSON body — send Content-Type: application/json with a JSON-encoded body' },
      { status: 400 },
    );
  }
  try {
    return schema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: 'validation failed', issues: err.issues }, { status: 400 });
    }
    throw err;
  }
}
