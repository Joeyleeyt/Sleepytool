import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth';

/**
 * Single-password gate. Every page and API route requires a valid session cookie
 * EXCEPT the paths below, which must stay reachable without auth:
 *   - /login + /api/login : the gate itself
 *   - /api/health, /api/ready : platform probes (Fly health checks)
 *   - /api/v1/hooks/* : provider webhooks (69labs / veo3) — called server-to-server
 *     by external services that can't carry an operator session cookie. They have
 *     their own payload-based handling; gating them would silently drop callbacks.
 *
 * Unauthenticated requests get a /login redirect (pages) or a 401 (API), so the
 * browser fetch wrappers surface a clear error instead of HTML.
 */
const PUBLIC_EXACT = new Set(['/login', '/api/login', '/api/health', '/api/ready']);
const PUBLIC_PREFIXES = ['/api/v1/hooks/'];

function isPublic(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  const secret = process.env.AUTH_SECRET;
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (secret && token && (await verifySessionToken(token, secret, Date.now()))) {
    return NextResponse.next();
  }

  // API callers get a machine-readable 401 (the fetch wrapper turns this into a
  // thrown Error); page navigations get bounced to the login screen.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  // Preserve where they were headed so login can send them back. Only the
  // path+query is kept (no host) to avoid an open-redirect.
  url.searchParams.set('next', pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  // Run on everything except Next's static output and common static files. The
  // isPublic() check above handles the auth allow-list within the matched set.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|woff2?)$).*)'],
};
