import { NextResponse } from 'next/server';
import { authRepo } from '@emberforge/db';
import { SESSION_COOKIE, SESSION_MAX_AGE_S, createSessionToken } from '@/lib/auth';
import { hashPassword, verifyPassword } from '@/lib/password';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/login  — verify the shared password, set the session cookie.
 * DELETE /api/login — log out (clear the cookie).
 *
 * The password lives as a salted hash in the auth_credential DB row, bootstrapped
 * from APP_PASSWORD on first login and changeable thereafter (see /api/change-password).
 * AUTH_SECRET signs the session cookie. Both are server-only; neither is ever
 * sent to the browser.
 */
export async function POST(request: Request) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    // Misconfiguration — fail closed and make it loud in the server logs.
    console.error('[auth] AUTH_SECRET not set — login disabled');
    return NextResponse.json({ error: 'auth_not_configured' }, { status: 500 });
  }

  // Resolve the stored password hash, bootstrapping it from APP_PASSWORD the very
  // first time anyone logs in (no row yet). After a change-password, the DB value
  // is authoritative and APP_PASSWORD no longer grants access.
  let cred = await authRepo.get();
  if (!cred) {
    const seed = process.env.APP_PASSWORD;
    if (!seed) {
      console.error('[auth] no stored password and APP_PASSWORD not set — login disabled');
      return NextResponse.json({ error: 'auth_not_configured' }, { status: 500 });
    }
    await authRepo.setHash(hashPassword(seed));
    cred = await authRepo.get();
  }

  const body = (await request.json().catch(() => ({}))) as { password?: unknown };
  const submitted = typeof body.password === 'string' ? body.password : '';
  if (!cred || !verifyPassword(submitted, cred.passwordHash)) {
    return NextResponse.json({ error: 'invalid_password' }, { status: 401 });
  }

  const token = await createSessionToken(secret, Date.now());
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE_S,
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  });
  return res;
}
