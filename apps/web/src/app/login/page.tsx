'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Flame, Lock } from 'lucide-react';
import { Button } from '@/components/primitives/Button';

/**
 * Shared-password login. Posts the password to /api/login, which sets an httpOnly
 * session cookie on success; the middleware then admits every other route.
 */
export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Only ever follow an internal path (leading "/" but not "//") so the ?next
  // param can't be turned into an open redirect to another origin.
  function safeNext(): string {
    if (typeof window === 'undefined') return '/';
    const next = new URLSearchParams(window.location.search).get('next');
    if (next && next.startsWith('/') && !next.startsWith('//')) return next;
    return '/';
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        setError(res.status === 401 ? 'Incorrect password.' : 'Login failed. Try again.');
        setPending(false);
        return;
      }
      // Full navigation so the new cookie is sent and middleware re-evaluates.
      window.location.assign(safeNext());
    } catch {
      setError('Could not reach the server.');
      setPending(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center bg-bg p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm bg-bg-elev border border-border rounded-card p-6"
      >
        <div className="flex items-center gap-2 text-ember-500">
          <Flame size={22} />
          <span className="font-display text-lg font-semibold text-text">EmberForge</span>
        </div>
        <p className="mt-1 text-sm text-text-dim">Enter the password to continue.</p>

        <label className="mt-5 block text-xs text-text-dim">Password</label>
        <div className="relative mt-1">
          <Lock
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-faint"
          />
          <input
            autoFocus
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className="w-full bg-bg border border-border rounded-md pl-9 pr-3 h-9 text-sm focus:outline-none focus:border-ember-500"
          />
        </div>

        {error && <div className="mt-3 text-sm text-bad">{error}</div>}

        <Button
          type="submit"
          variant="primary"
          className="mt-5 w-full"
          disabled={pending || password.length === 0}
        >
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </div>
  );
}
