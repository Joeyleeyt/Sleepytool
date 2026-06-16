import { NextResponse } from 'next/server';
import { authRepo } from '@emberforge/db';
import { SESSION_COOKIE, SESSION_MAX_AGE_S, createSessionToken } from '@/lib/auth';
import { hashPassword, verifyPassword } from '@/lib/password';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Minimum length for a new password. */
const MIN_LEN = 8;

/**
 * POST /api/change-password — change the shared operator password.
 *
 * Requires a valid session (the middleware gates this route). Verifies the
 * caller knows the current password before accepting a new one, then re-issues
 * the session cookie so the caller stays logged in.
 *
 * Body: { currentPassword: string, newPassword: string }
 */
export async function POST(request: Request) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    console.error('[auth] AUTH_SECRET not set — change-password disabled');
    return NextResponse.json({ error: 'auth_not_configured' }, { status: 500 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    currentPassword?: unknown;
    newPassword?: unknown;
  };
  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

  if (newPassword.length < MIN_LEN) {
    return NextResponse.json(
      { error: 'weak_password', message: `New password must be at least ${MIN_LEN} characters.` },
      { status: 400 },
    );
  }
  if (newPassword === currentPassword) {
    return NextResponse.json(
      { error: 'unchanged_password', message: 'New password must differ from the current one.' },
      { status: 400 },
    );
  }

  // Resolve the current hash, bootstrapping from APP_PASSWORD if the row doesn't
  // exist yet (e.g. session minted before any login seeded the row).
  let cred = await authRepo.get();
  if (!cred) {
    const seed = process.env.APP_PASSWORD;
    if (seed) {
      await authRepo.setHash(hashPassword(seed));
      cred = await authRepo.get();
    }
  }
  if (!cred || !verifyPassword(currentPassword, cred.passwordHash)) {
    return NextResponse.json({ error: 'invalid_password' }, { status: 401 });
  }

  await authRepo.setHash(hashPassword(newPassword));

  // Re-issue the session so the operator stays signed in after the change.
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
