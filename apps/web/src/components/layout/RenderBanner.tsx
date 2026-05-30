'use client';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Play, Download, X, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/primitives/Button';
import { api } from '@/lib/api';
import { formatDuration } from '@/lib/utils';

/**
 * Shown at the bottom of the project shell when the project status is
 * `published`. Provides one-click playback + download of the final MP4.
 */
export function RenderBanner() {
  const params = useParams() as { projectId?: string };
  const projectId = params.projectId ?? '';
  const [open, setOpen] = useState(false);

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId),
    enabled: !!projectId,
    refetchInterval: (q) => (q.state.data?.status === 'published' ? false : 5000),
  });

  const { data: render } = useQuery({
    queryKey: ['render-url', projectId],
    queryFn: () => api.getRenderUrl(projectId),
    enabled: project?.status === 'published',
    staleTime: 50 * 60_000,
  });

  if (!projectId || project?.status !== 'published' || !render?.url) return null;

  return (
    <>
      <div className="px-4 py-2.5 border-t border-ember-500/40 bg-gradient-to-r from-ember-500/10 via-ember-500/5 to-transparent flex items-center gap-3">
        <CheckCircle2 size={16} className="text-ok shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-text">Render ready</div>
          <div className="text-xs text-text-dim tabular-nums">
            {render.durationS ? formatDuration(Number(render.durationS)) : ''} · final_v1.mp4
          </div>
        </div>
        <Button size="sm" onClick={() => setOpen(true)}>
          <Play size={13} /> Watch
        </Button>
        <Button size="sm" variant="primary" onClick={() => window.open(render.url, '_blank')}>
          <Download size={13} /> Download
        </Button>
      </div>

      {open && (
        <div className="fixed inset-0 z-50 bg-black/85 grid place-items-center p-6" onClick={() => setOpen(false)}>
          <div className="relative w-full max-w-5xl" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setOpen(false)} className="absolute -top-9 right-0 text-text-dim hover:text-text">
              <X size={20} />
            </button>
            <video
              src={render.url}
              controls
              autoPlay
              className="w-full rounded-card bg-black"
              style={{ aspectRatio: '16/9' }}
            />
          </div>
        </div>
      )}
    </>
  );
}
