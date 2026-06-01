'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { NavRail } from '@/components/layout/NavRail';
import { Badge } from '@/components/primitives/Badge';
import { ProgressBar } from '@/components/primitives/ProgressBar';
import { api } from '@/lib/api';
import { STAGE_LABELS, TERMINAL_STATUSES } from '@/lib/utils';

export default function QueuePage() {
  const { data, isLoading } = useQuery({ queryKey: ['projects'], queryFn: api.listProjects, refetchInterval: 3000 });

  const active = (data?.projects ?? []).filter((p) => !TERMINAL_STATUSES.has(p.status));

  return (
    <div className="h-screen flex">
      <NavRail />
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 flex items-center px-6 border-b border-border bg-bg-subtle">
          <h1 className="font-display text-base font-semibold">Render Queue</h1>
          <Badge className="ml-3">{active.length} active</Badge>
        </header>
        <div className="flex-1 overflow-y-auto p-6 space-y-3">
          {isLoading && <div className="text-text-dim text-sm">Loading…</div>}
          {!isLoading && active.length === 0 && (
            <div className="text-text-dim text-sm">No active jobs. The queue is idle.</div>
          )}
          {active.map((p) => (
            <QueueRow key={p.id} projectId={p.id} title={p.title} status={p.status} />
          ))}
        </div>
      </div>
    </div>
  );
}

function QueueRow({ projectId, title, status }: { projectId: string; title: string; status: string }) {
  const { data } = useQuery({
    queryKey: ['progress', projectId],
    queryFn: () => api.getProgress(projectId),
    refetchInterval: 3000,
  });

  const pct = data?.shots && data.shots.total > 0 ? data.shots.ready / data.shots.total : 0;

  return (
    <Link
      href={`/p/${projectId}/board`}
      className="block rounded-card border border-border bg-bg-elev p-4 hover:border-border-strong transition-colors"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge tone="busy">{STAGE_LABELS[status] ?? status}</Badge>
          <span className="text-sm font-medium">{title}</span>
        </div>
      </div>
      <div className="mt-3">
        <ProgressBar value={pct} tone="busy" />
      </div>
      <div className="mt-2 text-xs text-text-dim tabular-nums">
        Assets: {data?.shots?.ready ?? 0} / {data?.shots?.total ?? 0}
        {data?.shots && data.shots.failed > 0 && <span className="text-bad ml-3">⚠ {data.shots.failed} failed</span>}
      </div>
    </Link>
  );
}
