'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Power,
  PowerOff,
  Plus,
  Trash2,
} from 'lucide-react';
import { NavRail } from '@/components/layout/NavRail';
import { Badge } from '@/components/primitives/Badge';
import { Button } from '@/components/primitives/Button';
import { api, type ApiKey } from '@/lib/api';
import { cn, formatRelative } from '@/lib/utils';

export default function KeysPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['keys'],
    queryFn: api.listKeys,
    // Poll so a key the WORKER auto-disables (bad key / no credits) flips to
    // "disabled" here without a manual refresh.
    refetchInterval: 5_000,
  });

  const keys = data?.keys ?? [];
  // Active keys are tried oldest-first, so show them in that order (rotation
  // order) with the disabled ones parked at the bottom.
  const active = keys.filter((k) => k.isActive);
  const disabled = keys.filter((k) => !k.isActive);

  return (
    <div className="h-screen flex">
      <NavRail />
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 flex items-center px-6 border-b border-border bg-bg-subtle">
          <KeyRound size={18} className="text-ember-500" />
          <h1 className="font-display text-base font-semibold ml-2">69labs API Keys</h1>
          <Badge tone="ok" className="ml-3">
            {active.length} active
          </Badge>
          {disabled.length > 0 && <Badge className="ml-1.5">{disabled.length} disabled</Badge>}
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto p-6 space-y-6">
            <RotationNote />
            <AddKeyForm />

            <div className="space-y-2">
              {isLoading && <div className="text-text-dim text-sm">Loading…</div>}

              {!isLoading && keys.length === 0 && (
                <div className="rounded-card border border-dashed border-border p-8 text-center">
                  <KeyRound size={24} className="text-text-dim mx-auto mb-2" />
                  <div className="text-sm text-text-dim">
                    No keys yet. Add a 69labs key above to start generating.
                  </div>
                </div>
              )}

              {active.map((k, i) => (
                <KeyCard key={k.id} k={k} order={i + 1} />
              ))}

              {disabled.length > 0 && active.length > 0 && (
                <div className="pt-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-text-dim">
                  Disabled
                </div>
              )}
              {disabled.map((k) => (
                <KeyCard key={k.id} k={k} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Short explainer that ties the UI to how workers actually use the keys. */
function RotationNote() {
  return (
    <div className="rounded-card border border-border bg-bg-subtle px-4 py-3 text-xs text-text-dim leading-relaxed">
      Workers try active keys <span className="text-text">top-to-bottom</span> and shift to the next
      one whenever a generation fails. A key that returns an auth or out-of-credits error is{' '}
      <span className="text-text">disabled automatically</span>. Add or remove keys anytime — changes
      apply on the next job, no redeploy.
    </div>
  );
}

function AddKeyForm() {
  const qc = useQueryClient();
  const [apiKey, setApiKey] = useState('');
  const [label, setLabel] = useState('');
  const [reveal, setReveal] = useState(false);

  const add = useMutation({
    mutationFn: () => api.addKey({ apiKey: apiKey.trim(), label: label.trim() || undefined }),
    onSuccess: () => {
      setApiKey('');
      setLabel('');
      void qc.invalidateQueries({ queryKey: ['keys'] });
    },
  });

  const canAdd = apiKey.trim().length >= 8 && !add.isPending;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canAdd) add.mutate();
      }}
      className="rounded-card border border-border bg-bg-elev p-4 space-y-3"
    >
      <div className="text-sm font-medium">Add a key</div>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            type={reveal ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            placeholder="vk_live_…  (paste your 69labs API key)"
            className="w-full h-9 pl-3 pr-9 rounded-md bg-bg-subtle border border-border text-sm font-mono placeholder:text-text-dim placeholder:font-sans focus:outline-none focus:ring-2 focus:ring-ember-500/60"
          />
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            title={reveal ? 'Hide' : 'Show'}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-text-dim hover:text-text"
          >
            {reveal ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (optional)"
          maxLength={40}
          className="w-40 h-9 px-3 rounded-md bg-bg-subtle border border-border text-sm placeholder:text-text-dim focus:outline-none focus:ring-2 focus:ring-ember-500/60"
        />
        <Button type="submit" variant="primary" disabled={!canAdd}>
          {add.isPending ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
          Add
        </Button>
      </div>
      {add.isError && (
        <div className="flex items-center gap-1.5 text-xs text-bad">
          <AlertTriangle size={13} />
          {cleanError((add.error as Error).message)}
        </div>
      )}
      <div className="text-[11px] text-text-dim">
        The key is encrypted before it’s stored and never shown again — only its fingerprint.
      </div>
    </form>
  );
}

function KeyCard({ k, order }: { k: ApiKey; order?: number }) {
  const qc = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['keys'] });
  const toggle = useMutation({
    mutationFn: () => api.setKeyActive(k.id, !k.isActive),
    onSuccess: invalidate,
  });
  const del = useMutation({ mutationFn: () => api.deleteKey(k.id), onSuccess: invalidate });

  const busy = toggle.isPending || del.isPending;

  return (
    <div
      className={cn(
        'rounded-card border bg-bg-elev p-4 flex items-center gap-4 transition-colors',
        k.isActive ? 'border-border' : 'border-border/60 opacity-75',
      )}
    >
      {/* Rotation order pill — only meaningful for active keys */}
      <div className="w-8 shrink-0 text-center">
        {order ? (
          <span
            className="inline-grid place-items-center w-7 h-7 rounded-md bg-bg-subtle border border-border text-xs font-semibold tabular-nums"
            title={order === 1 ? 'Primary — tried first' : `Tried #${order}`}
          >
            {order}
          </span>
        ) : (
          <PowerOff size={15} className="text-text-dim mx-auto" />
        )}
      </div>

      {/* Identity */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{k.label || 'Unlabeled key'}</span>
          {order === 1 && (
            <Badge tone="ember" className="shrink-0">
              primary
            </Badge>
          )}
          {k.isActive ? (
            <Badge tone="ok" className="shrink-0">
              active
            </Badge>
          ) : (
            <Badge tone="bad" className="shrink-0">
              {reasonLabel(k.disabledReason)}
            </Badge>
          )}
        </div>
        <div className="mt-1 flex items-center gap-3 text-xs text-text-dim">
          <span className="font-mono">key ••••{k.keyFingerprint}</span>
          <span>·</span>
          <span>{k.lastUsedAt ? `used ${formatRelative(k.lastUsedAt)}` : 'never used'}</span>
        </div>
        {!k.isActive && k.lastError?.message && (
          <div className="mt-1.5 flex items-start gap-1.5 text-xs text-bad/90">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span className="truncate" title={k.lastError.message}>
              {k.lastError.message}
            </span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => toggle.mutate()}
          title={k.isActive ? 'Disable (skip in rotation)' : 'Enable'}
        >
          {toggle.isPending ? (
            <Loader2 size={14} className="animate-spin" />
          ) : k.isActive ? (
            <PowerOff size={14} />
          ) : (
            <Power size={14} />
          )}
          {k.isActive ? 'Disable' : 'Enable'}
        </Button>

        {confirmDelete ? (
          <>
            <Button variant="danger" size="sm" disabled={busy} onClick={() => del.mutate()}>
              {del.isPending ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              Confirm
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
            title="Delete permanently"
          >
            <Trash2 size={14} />
          </Button>
        )}
      </div>
    </div>
  );
}

function reasonLabel(reason: string | null): string {
  switch (reason) {
    case 'invalid_key':
      return 'invalid key';
    case 'no_credits':
      return 'no credits';
    case 'manual':
      return 'disabled';
    default:
      return reason || 'disabled';
  }
}

/**
 * The http() helper throws `"<status> <statusText>: <body>"`. Dig the
 * human-readable reason out of that — Zod validation issues, our `{ error }`
 * JSON shape, or a plain message — so the user sees "API_KEY_ENCRYPTION_SECRET
 * not set …" rather than `500 Internal Server Error: {"error":"…"}`.
 */
function cleanError(msg: string): string {
  const validation = msg.match(/validation failed.*?"message":"([^"]+)"/);
  if (validation) return validation[1]!;
  const errorField = msg.match(/"error":"([^"]+)"/);
  if (errorField) return errorField[1]!;
  return msg.replace(/^\d{3}\s[\w ]+:\s*/, '') || 'Could not add key';
}
