'use client';
import Link from 'next/link';
import { useRouter, useParams, usePathname } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ScrollText, LayoutGrid, Film, Play, Loader2, ExternalLink } from 'lucide-react';
import { Button } from '@/components/primitives/Button';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import type { ProjectStatus } from '@emberforge/core';

const MODES = [
  { key: 'script', label: 'Script', icon: ScrollText },
  { key: 'board', label: 'Board', icon: LayoutGrid },
  { key: 'timeline', label: 'Timeline', icon: Film },
] as const;

// Status sets that drive the Render button state machine.
const RENDERABLE: ReadonlySet<ProjectStatus> = new Set([
  'assets_ready',
  'published',
  'failed',
]);
const RENDERING: ReadonlySet<ProjectStatus> = new Set([
  'timeline_built',
  'audio_mixed',
  'composited',
  'encoded',
]);

export function TopBar() {
  const router = useRouter();
  const path = usePathname();
  const params = useParams() as { projectId?: string };
  const projectId = params.projectId ?? '';
  const qc = useQueryClient();

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId),
    enabled: !!projectId,
    refetchInterval: 3000,
  });

  const startRender = useMutation({
    mutationFn: () => api.startRender(projectId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  });

  const openFinal = useMutation({
    mutationFn: () => api.getRenderUrl(projectId),
    onSuccess: ({ url }) => {
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    },
  });

  const currentMode = MODES.find((m) => path.includes(`/${m.key}`))?.key ?? 'script';

  const status = project?.status as ProjectStatus | undefined;
  const isRenderable = !!status && RENDERABLE.has(status);
  const isRendering = !!status && RENDERING.has(status);
  const isPublished = status === 'published';
  const isFailed = status === 'failed';

  // Derive label + action + disabled from the status state machine
  let label: string;
  let icon = <Play size={13} />;
  let action: (() => void) | undefined;
  let disabled = true;
  let title: string | undefined;

  if (!project) {
    label = 'Loading…';
    title = 'Waiting for project';
  } else if (isPublished) {
    label = 'Open final';
    icon = <ExternalLink size={13} />;
    action = () => openFinal.mutate();
    disabled = openFinal.isPending;
    title = 'Open the final rendered MP4 in a new tab';
  } else if (isFailed) {
    label = 'Retry render';
    action = () => startRender.mutate();
    disabled = startRender.isPending;
    title = 'Re-run the render pipeline from buildTimeline';
  } else if (isRendering) {
    label = 'Rendering…';
    icon = <Loader2 size={13} className="animate-spin" />;
    title = `Pipeline at: ${status}`;
  } else if (status === 'assets_ready') {
    label = 'Render final video';
    action = () => startRender.mutate();
    disabled = startRender.isPending;
    title = 'Build timeline, mix audio, composite, encode, publish';
  } else {
    // ingested / analyzed / segmented / classified / prompted / generating_assets
    label = 'Generating assets…';
    icon = <Loader2 size={13} className="animate-spin" />;
    title = `Waiting for assets to finish (current: ${status ?? 'unknown'})`;
  }

  const renderError = (startRender.error as Error | null)?.message;

  return (
    <header className="h-14 shrink-0 flex items-center justify-between gap-4 px-4 border-b border-border bg-bg-subtle">
      <div className="flex items-center gap-3 min-w-0">
        <Link href="/" className="text-text-dim hover:text-text">
          <ArrowLeft size={18} />
        </Link>
        <div className="font-display text-sm font-semibold truncate">
          {project?.title ?? 'Loading…'}
        </div>
      </div>

      <div className="flex items-center gap-1 p-0.5 rounded-md bg-bg-elev border border-border">
        {MODES.map((m) => {
          const Icon = m.icon;
          const active = currentMode === m.key;
          return (
            <button
              key={m.key}
              onClick={() => router.push(`/p/${projectId}/${m.key}`)}
              className={cn(
                'h-7 px-2.5 rounded text-xs flex items-center gap-1.5 transition-colors',
                active ? 'bg-bg text-text' : 'text-text-dim hover:text-text',
              )}
            >
              <Icon size={13} />
              {m.label}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        {renderError && (
          <span className="text-[11px] text-bad truncate max-w-[18ch]" title={renderError}>
            {renderError}
          </span>
        )}
        <Button
          variant={isRenderable && !disabled ? 'primary' : 'secondary'}
          size="sm"
          disabled={disabled || !action}
          onClick={action}
          title={title}
        >
          {icon}
          {label}
        </Button>
      </div>
    </header>
  );
}
