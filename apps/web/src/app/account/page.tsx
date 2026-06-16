'use client';
import { useState } from 'react';
import { CircleUser, Check, Loader2 } from 'lucide-react';
import { NavRail } from '@/components/layout/NavRail';
import { Button } from '@/components/primitives/Button';

const MIN_LEN = 8;

export default function AccountPage() {
  return (
    <div className="h-screen flex">
      <NavRail />
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 flex items-center px-6 border-b border-border bg-bg-subtle">
          <CircleUser size={18} className="text-ember-500" />
          <h1 className="font-display text-base font-semibold ml-2">Account</h1>
        </header>
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-md mx-auto p-6">
            <ChangePasswordForm />
          </div>
        </div>
      </div>
    </div>
  );
}

function ChangePasswordForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  // Client-side guard mirrors the server checks for instant feedback; the server
  // is still authoritative.
  const clientError =
    next.length > 0 && next.length < MIN_LEN
      ? `New password must be at least ${MIN_LEN} characters.`
      : confirm.length > 0 && next !== confirm
        ? 'New passwords do not match.'
        : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (clientError) {
      setError(clientError);
      return;
    }
    setPending(true);
    try {
      const res = await fetch('/api/change-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        setError(
          data.message ??
            (res.status === 401 ? 'Current password is incorrect.' : 'Could not change password.'),
        );
        setPending(false);
        return;
      }
      setDone(true);
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch {
      setError('Could not reach the server.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="bg-bg-elev border border-border rounded-card p-6">
      <h2 className="font-display text-base font-semibold">Change password</h2>
      <p className="mt-1 text-sm text-text-dim">
        Update the shared password used to sign in. You&apos;ll stay logged in on this device.
      </p>

      <Field label="Current password" value={current} onChange={setCurrent} autoFocus />
      <Field label="New password" value={next} onChange={setNext} />
      <Field label="Confirm new password" value={confirm} onChange={setConfirm} />

      {(error || clientError) && <div className="mt-3 text-sm text-bad">{error ?? clientError}</div>}
      {done && (
        <div className="mt-3 flex items-center gap-1.5 text-sm text-ok">
          <Check size={14} /> Password changed.
        </div>
      )}

      <Button
        type="submit"
        variant="primary"
        className="mt-5 w-full"
        disabled={pending || !current || !next || !confirm || !!clientError}
      >
        {pending ? (
          <>
            <Loader2 size={14} className="animate-spin" /> Saving…
          </>
        ) : (
          'Change password'
        )}
      </Button>
    </form>
  );
}

function Field({
  label,
  value,
  onChange,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <div className="mt-4">
      <label className="block text-xs text-text-dim">{label}</label>
      <input
        autoFocus={autoFocus}
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full bg-bg border border-border rounded-md px-3 h-9 text-sm focus:outline-none focus:border-ember-500"
      />
    </div>
  );
}
