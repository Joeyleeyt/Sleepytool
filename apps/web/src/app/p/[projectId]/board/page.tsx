'use client';
import { useState, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Filter } from 'lucide-react';
import { ThreePane } from '@/components/layout/ThreePane';
import { SceneCard } from '@/components/scene/SceneCard';
import { Button } from '@/components/primitives/Button';
import { Badge } from '@/components/primitives/Badge';
import { api } from '@/lib/api';
import { formatUsd } from '@/lib/utils';

type StatusFilter = 'all' | 'ready' | 'pending' | 'partial';

export default function BoardPage() {
  const router = useRouter();
  const { projectId } = useParams() as { projectId: string };
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<StatusFilter>('all');

  const { data, isLoading } = useQuery({
    queryKey: ['scenes', projectId],
    queryFn: () => api.getScenes(projectId),
    refetchInterval: 3000,
  });

  const allShots = useMemo(() => {
    if (!data) return [];
    return data.scenes.flatMap((s) => s.shots.map((shot) => ({ shot, sceneOrdinal: s.ordinal })));
  }, [data]);

  const filtered = useMemo(() => {
    if (filter === 'all') return allShots;
    return allShots.filter(({ shot }) => shot.status === filter);
  }, [allShots, filter]);

  const counts = useMemo(() => {
    const c = { all: allShots.length, ready: 0, pending: 0, partial: 0 };
    for (const { shot } of allShots) {
      if (shot.status === 'ready') c.ready++;
      else if (shot.status === 'partial') c.partial++;
      else c.pending++;
    }
    return c;
  }, [allShots]);

  const handleSelect = (id: string, multi?: boolean) => {
    const next = new Set(multi ? selected : []);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  return (
    <ThreePane
      inspector={
        selected.size > 0 ? (
          <BulkInspector selectedCount={selected.size} onClear={() => setSelected(new Set())} />
        ) : (
          <ProjectInspector counts={counts} />
        )
      }
    >
      <div className="h-full flex flex-col min-h-0">
        <div className="h-12 shrink-0 flex items-center gap-2 px-4 border-b border-border bg-bg-subtle">
          <Filter size={14} className="text-text-dim" />
          <FilterTab label="All" count={counts.all} active={filter === 'all'} onClick={() => setFilter('all')} />
          <FilterTab label="Ready" count={counts.ready} active={filter === 'ready'} tone="ok" onClick={() => setFilter('ready')} />
          <FilterTab label="Generating" count={counts.pending} active={filter === 'pending'} tone="busy" onClick={() => setFilter('pending')} />
          <FilterTab label="Partial" count={counts.partial} active={filter === 'partial'} tone="warn" onClick={() => setFilter('partial')} />
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {isLoading ? (
            <GridSkeleton />
          ) : filtered.length === 0 ? (
            <div className="grid place-items-center h-full text-text-dim text-sm">
              {allShots.length === 0 ? 'Waiting for shot classification…' : 'No shots match this filter'}
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
              {filtered.map(({ shot, sceneOrdinal }) => (
                <SceneCard
                  key={shot.id}
                  shot={shot}
                  sceneOrdinal={sceneOrdinal}
                  selected={selected.has(shot.id)}
                  onSelect={handleSelect}
                  onOpenStudio={(id) => router.push(`/p/${projectId}/studio/${id}`)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </ThreePane>
  );
}

function FilterTab({
  label,
  count,
  active,
  tone,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  tone?: 'ok' | 'busy' | 'warn';
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`h-7 px-2.5 rounded text-xs flex items-center gap-1.5 transition-colors ${
        active ? 'bg-bg-elev text-text border border-border' : 'text-text-dim hover:text-text'
      }`}
    >
      {label}
      <Badge tone={tone ?? 'neutral'}>{count}</Badge>
    </button>
  );
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
      {Array.from({ length: 12 }).map((_, i) => (
        <div key={i} className="aspect-[5/4] rounded-card border border-border bg-bg-elev shimmer" />
      ))}
    </div>
  );
}

function ProjectInspector({ counts }: { counts: { all: number; ready: number; pending: number; partial: number } }) {
  const pct = counts.all > 0 ? (counts.ready / counts.all) * 100 : 0;
  return (
    <div className="p-4 space-y-4">
      <h3 className="text-xs uppercase tracking-wider text-text-faint">Scene Board</h3>
      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs">
          <span className="text-text-dim">Ready</span>
          <span className="font-mono tabular-nums">{counts.ready} / {counts.all}</span>
        </div>
        <div className="h-1.5 bg-bg-elev rounded-full overflow-hidden">
          <div className="h-full bg-ember-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-xs uppercase tracking-wider text-text-faint">Tips</h3>
        <ul className="text-xs text-text-dim space-y-1.5">
          <li>· Click to select, ⌘-click for multi.</li>
          <li>· Double-click to open Studio.</li>
          <li>· Bulk regenerate from this panel.</li>
        </ul>
      </div>
    </div>
  );
}

function BulkInspector({ selectedCount, onClear }: { selectedCount: number; onClear: () => void }) {
  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs uppercase tracking-wider text-text-faint">Selection</h3>
        <button onClick={onClear} className="text-[11px] text-text-dim hover:text-text">Clear</button>
      </div>
      <div className="text-2xl font-display font-semibold">{selectedCount}<span className="text-sm text-text-dim ml-1.5">shots</span></div>

      <div className="space-y-2">
        <h3 className="text-xs uppercase tracking-wider text-text-faint">Bulk actions</h3>
        <Button className="w-full justify-start">Regenerate selected</Button>
        <Button className="w-full justify-start">Lock visual identity</Button>
        <Button className="w-full justify-start">Change FX preset</Button>
        <Button className="w-full justify-start">Force visual type…</Button>
      </div>

      <div className="text-xs text-text-faint">Cost preview: <span className="text-text-dim font-mono">{formatUsd(selectedCount * 0.04)}</span></div>
    </div>
  );
}
