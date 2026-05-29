'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Plus, Film } from 'lucide-react';
import { NavRail } from '@/components/layout/NavRail';
import { Button } from '@/components/primitives/Button';
import { Badge } from '@/components/primitives/Badge';
import { api } from '@/lib/api';
import { STAGE_LABELS, formatRelative } from '@/lib/utils';

export default function WorkspaceHome() {
  const [showNew, setShowNew] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ['projects'], queryFn: api.listProjects, refetchInterval: 5000 });

  return (
    <div className="h-screen flex">
      <NavRail />
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 shrink-0 flex items-center justify-between px-6 border-b border-border bg-bg-subtle">
          <h1 className="font-display text-base font-semibold">Projects</h1>
          <Button variant="primary" onClick={() => setShowNew(true)}>
            <Plus size={14} /> New project
          </Button>
        </header>

        <div className="flex-1 overflow-y-auto p-6">
          {isLoading ? (
            <Skeleton />
          ) : !data || data.projects.length === 0 ? (
            <Empty onNew={() => setShowNew(true)} />
          ) : (
            <ProjectGrid projects={data.projects} />
          )}
        </div>
      </div>

      {showNew && <NewProjectModal onClose={() => setShowNew(false)} />}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-56 rounded-card border border-border bg-bg-elev shimmer" />
      ))}
    </div>
  );
}

function Empty({ onNew }: { onNew: () => void }) {
  return (
    <div className="grid place-items-center min-h-[60vh] text-center">
      <div>
        <Film size={36} className="mx-auto text-text-faint" />
        <h2 className="mt-4 font-display text-lg">No projects yet</h2>
        <p className="mt-1 text-text-dim text-sm">Paste a transcript to make your first cinematic video.</p>
        <Button variant="primary" className="mt-5" onClick={onNew}>
          <Plus size={14} /> New project
        </Button>
      </div>
    </div>
  );
}

function ProjectGrid({ projects }: { projects: Awaited<ReturnType<typeof api.listProjects>>['projects'] }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {projects.map((p) => (
        <Link
          key={p.id}
          href={`/p/${p.id}/script`}
          className="group rounded-card border border-border bg-bg-elev hover:border-border-strong transition-colors overflow-hidden"
        >
          <div className="aspect-video bg-bg-subtle grid place-items-center text-text-faint group-hover:text-text-dim">
            <Film size={28} />
          </div>
          <div className="p-3">
            <div className="text-sm font-medium truncate">{p.title}</div>
            <div className="mt-2 flex items-center justify-between">
              <Badge tone={p.status === 'published' ? 'ok' : p.status === 'failed' ? 'bad' : p.status === 'ingested' ? 'neutral' : 'busy'}>
                {STAGE_LABELS[p.status] ?? p.status}
              </Badge>
              <span className="text-[11px] text-text-faint">{formatRelative(p.updatedAt)}</span>
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}

function NewProjectModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [transcript, setTranscript] = useState('');

  const create = useMutation({
    mutationFn: () => api.createProject({ title: title || `Untitled ${new Date().toLocaleString()}`, transcript }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      router.push(`/p/${res.projectId}/board`);
    },
  });

  const wordCount = transcript.trim() ? transcript.trim().split(/\s+/).length : 0;
  const estMin = Math.round((wordCount / 150) * 10) / 10;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 grid place-items-center p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl bg-bg-elev border border-border rounded-card overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-border">
          <h2 className="font-display text-lg font-semibold">New project</h2>
          <p className="text-sm text-text-dim mt-1">Paste a transcript. EmberForge will segment, generate, and render automatically.</p>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="text-xs text-text-dim">Title</label>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Cosmic Origins"
              className="mt-1 w-full bg-bg border border-border rounded-md px-3 h-9 text-sm focus:outline-none focus:border-ember-500"
            />
          </div>
          <div>
            <label className="text-xs text-text-dim">Transcript</label>
            <textarea
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              placeholder="In the cold silence before the first dawn..."
              rows={12}
              className="mt-1 w-full bg-bg border border-border rounded-md px-3 py-2 text-sm font-narration leading-relaxed focus:outline-none focus:border-ember-500"
            />
            <div className="mt-1 flex items-center justify-between text-[11px] text-text-faint tabular-nums">
              <span>{wordCount.toLocaleString()} words</span>
              <span>≈ {estMin} min of finished video</span>
            </div>
          </div>
          {create.error && <div className="text-bad text-sm">{(create.error as Error).message}</div>}
        </div>
        <div className="p-5 border-t border-border flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => create.mutate()} disabled={create.isPending || transcript.trim().length < 100}>
            {create.isPending ? 'Creating…' : 'Start generating'}
          </Button>
        </div>
      </div>
    </div>
  );
}
