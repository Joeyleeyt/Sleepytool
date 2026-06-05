'use client';
import { useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api, type ProjectEvent } from '@/lib/api';

/**
 * Mirrors worker-side 69labs failures into the operator's browser console.
 *
 * The labs-worker runs on Fly.io, so its failure logs never reach the browser.
 * On a failed 69labs request it emits a `labs/failed` project event carrying the
 * provider's error message; we poll `/events` here and re-log each new one with
 * console.error so the failure is visible in the browser dev console — exactly
 * once, live, on any project page.
 *
 * Renders nothing; mounted once in the project layout.
 */
export function LabsConsoleLogger() {
  const params = useParams() as { projectId?: string };
  const projectId = params.projectId ?? '';

  // High-water mark of the largest event id we've already handled, so each
  // failure logs once. We `fetch(since)` with it to ask the API for new events
  // only. Null until the first poll establishes a baseline.
  const sinceRef = useRef<number | null>(null);
  // First poll seeds the baseline WITHOUT logging, so loading a project page
  // doesn't replay its entire failure history into the console.
  const seeded = useRef(false);

  const { data } = useQuery({
    queryKey: ['labs-events', projectId],
    queryFn: () => api.getEvents(projectId, sinceRef.current ?? 0),
    enabled: !!projectId,
    refetchInterval: 3000,
  });

  // The project layout (and thus this component) is reused across project
  // switches, so the refs persist. Reset the baseline when projectId changes so
  // each project re-seeds against its own events rather than the previous
  // project's high-water mark.
  useEffect(() => {
    seeded.current = false;
    sinceRef.current = null;
  }, [projectId]);

  useEffect(() => {
    const events = data?.events;
    if (!events) return; // query not resolved yet

    // The API returns newest-first; replay oldest-first so console order is
    // chronological.
    const ordered = [...events].sort((a, b) => a.id - b.id);
    const maxId = ordered.length ? ordered[ordered.length - 1]!.id : 0;

    // The first resolved poll sets a high-water mark WITHOUT logging, so opening
    // a project page doesn't replay old failures. We MUST seed even when the
    // project has no events yet (maxId 0) — otherwise the project's very first
    // failure is silently consumed as the baseline instead of being logged.
    if (!seeded.current) {
      seeded.current = true;
      sinceRef.current = maxId;
      return;
    }

    if (ordered.length === 0) return;
    for (const ev of ordered) {
      if (sinceRef.current !== null && ev.id <= sinceRef.current) continue;
      if (isLabsFailure(ev)) logLabsFailure(ev);
    }
    sinceRef.current = Math.max(sinceRef.current ?? 0, maxId);
  }, [data]);

  return null;
}

function isLabsFailure(ev: ProjectEvent): boolean {
  // Case-insensitive so it also catches the webhook route's `webhook:FAILED`.
  return (
    (ev.stage === 'labs' || ev.stage === '69labs') &&
    ev.event.toLowerCase().includes('failed')
  );
}

function logLabsFailure(ev: ProjectEvent) {
  const p = (ev.payload ?? {}) as {
    shotId?: string;
    kind?: string;
    message?: string;
    providerJobId?: string;
  };
  const tags = [
    p.kind && `kind=${p.kind}`,
    p.shotId && `shot=${p.shotId}`,
    p.providerJobId && `job=${p.providerJobId}`,
  ]
    .filter(Boolean)
    .join(' ');
  // eslint-disable-next-line no-console
  console.error(
    `[69labs] generation failed${tags ? ` (${tags})` : ''}: ${p.message ?? 'unknown error'}`,
    ev.payload,
  );
}
