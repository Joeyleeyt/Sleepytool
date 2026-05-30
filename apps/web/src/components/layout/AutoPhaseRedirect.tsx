'use client';
import { useEffect, useRef } from 'react';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAutoRedirectEnabled } from '@/lib/autoRedirect';
import type { ProjectStatus } from '@emberforge/core';

/**
 * Watches project status and pushes the user to the right review page when
 * the pipeline crosses a phase boundary. Fires at most one redirect per
 * status transition, and never undoes an explicit manual navigation: each
 * status transition triggers exactly one push, and we remember the last
 * status we redirected for.
 *
 *   ingested / analyzed         → /script (analysis in progress)
 *   segmented                   → /script (review scenes)
 *   classified                  → /board  (prompts building)
 *   prompted                    → /board  (review shot prompts)
 *   generating_assets / assets_ready → /board (asset cards)
 *   timeline_built+ / published → /timeline (final render)
 */

const ROUTE_FOR_STATUS: Partial<Record<ProjectStatus, 'script' | 'board' | 'timeline'>> = {
  ingested: 'script',
  analyzed: 'script',
  segmented: 'script',
  classified: 'board',
  prompted: 'board',
  generating_assets: 'board',
  assets_ready: 'board',
  timeline_built: 'timeline',
  audio_mixed: 'timeline',
  composited: 'timeline',
  encoded: 'timeline',
  published: 'timeline',
};

export function AutoPhaseRedirect() {
  const params = useParams() as { projectId?: string };
  const projectId = params.projectId ?? '';
  const router = useRouter();
  const path = usePathname();
  const lastHandled = useRef<ProjectStatus | null>(null);
  const [enabled] = useAutoRedirectEnabled();

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId),
    enabled: !!projectId,
    refetchInterval: 3000,
  });

  const status = project?.status as ProjectStatus | undefined;

  useEffect(() => {
    if (!enabled) return;
    if (!projectId || !status) return;
    if (lastHandled.current === status) return;
    lastHandled.current = status;

    const target = ROUTE_FOR_STATUS[status];
    if (!target) return;

    const targetPath = `/p/${projectId}/${target}`;
    // Don't redirect if the user is already on the right page, or if they've
    // navigated to a sibling detail page (e.g. /studio/<shotId>) — we only
    // want to nudge from one top-level review surface to another.
    if (path === targetPath) return;
    const onSibling =
      path === `/p/${projectId}/script` ||
      path === `/p/${projectId}/board` ||
      path === `/p/${projectId}/timeline`;
    if (!onSibling) return;

    router.push(targetPath);
  }, [enabled, projectId, status, path, router]);

  return null;
}
