'use client';
import Link from 'next/link';
import { useRouter, useParams, usePathname } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ScrollText, LayoutGrid, Film, Play, Loader2, ExternalLink, ArrowRight, Wand2, Pin, PinOff } from 'lucide-react';
import { Button } from '@/components/primitives/Button';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { useAutoRedirectEnabled } from '@/lib/autoRedirect';
import type { ProjectStatus } from '@emberforge/core';

const MODES = [
  { key: 'script', label: 'Script', icon: ScrollText },
  { key: 'board', label: 'Board', icon: LayoutGrid },
  { key: 'timeline', label: 'Timeline', icon: Film },
] as const;

// Statuses where the next-step button is actionable — user clicks to advance.
// Drives the "primary" filled variant for visual emphasis.
const ACTIONABLE: ReadonlySet<ProjectStatus> = new Set([
  'segmented',     // → plan-shots
  'prompted',      // → generate-assets
  'assets_ready',  // → render
  'published',     // → open final
  'failed',        // → retry render
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
  const [autoRedirect, setAutoRedirect] = useAutoRedirectEnabled();

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

  const planShots = useMutation({
    mutationFn: () => api.planShots(projectId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  });

  const generateAssets = useMutation({
    mutationFn: () => api.generateAssets(projectId),
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
  const isActionable = !!status && ACTIONABLE.has(status);
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
    icon = <Play size={13} />;
    action = () => startRender.mutate();
    disabled = startRender.isPending;
    title = 'Build timeline, mix audio, composite, encode, publish';
  } else if (status === 'segmented') {
    // Phase 2 gate — user reviewed scenes, kick off classify + prompt
    label = 'Plan shots';
    icon = <ArrowRight size={13} />;
    action = () => planShots.mutate();
    disabled = planShots.isPending;
    title = 'Classify each scene into shots and build per-shot prompts';
  } else if (status === 'prompted') {
    // Phase 3 gate — user reviewed shot prompts, fan out asset generation
    label = 'Generate assets';
    icon = <Wand2 size={13} />;
    action = () => generateAssets.mutate();
    disabled = generateAssets.isPending;
    title = 'Generate AI images and video clips for every shot';
  } else if (status === 'generating_assets') {
    label = 'Generating assets…';
    icon = <Loader2 size={13} className="animate-spin" />;
    title = 'Waiting for per-shot AI generation to finish';
  } else if (status === 'ingested' || status === 'analyzed') {
    label = 'Analyzing transcript…';
    icon = <Loader2 size={13} className="animate-spin" />;
    title = `Pipeline at: ${status}`;
  } else if (status === 'classified') {
    label = 'Building prompts…';
    icon = <Loader2 size={13} className="animate-spin" />;
    title = `Pipeline at: ${status}`;
  } else {
    label = 'Working…';
    icon = <Loader2 size={13} className="animate-spin" />;
    title = `Pipeline at: ${status ?? 'unknown'}`;
  }

  const renderError =
    (startRender.error as Error | null)?.message ??
    (planShots.error as Error | null)?.message ??
    (generateAssets.error as Error | null)?.message;

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
        <button
          type="button"
          onClick={() => setAutoRedirect(!autoRedirect)}
          className={cn(
            'h-7 px-2 rounded text-[11px] flex items-center gap-1.5 border transition-colors',
            autoRedirect
              ? 'border-border bg-bg-elev text-text-dim hover:text-text'
              : 'border-ember-500 bg-ember-500/10 text-ember-500',
          )}
          title={
            autoRedirect
              ? 'Auto-redirect ON — UI follows the pipeline through phases. Click to pin the current page.'
              : 'Pinned — pipeline can advance but you stay on this page. Click to re-enable auto-redirect.'
          }
        >
          {autoRedirect ? <PinOff size={12} /> : <Pin size={12} />}
          {autoRedirect ? 'Auto' : 'Pinned'}
        </button>
        <Button
          variant={isActionable && !disabled ? 'primary' : 'secondary'}
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
