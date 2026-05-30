'use client';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Check, Loader2, CircleAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { ProjectStatus } from '@emberforge/core';

/**
 * 4-phase progress indicator at the top of every project page. Visualizes:
 *
 *   1. Analyze       — runs automatically on submit
 *   2. Plan shots    — user gate (click triggers POST /:id/plan-shots)
 *   3. Generate      — user gate (click triggers POST /:id/generate-assets)
 *   4. Render        — user gate (click triggers POST /:id/render)
 *
 * Each step shows: index, label, sub-label hint, and one of:
 *   ✓ done       — green check
 *   spinning     — pipeline currently working in this phase
 *   active gate  — pending user action; clicking jumps to the review page
 *   pending      — future phase
 *   failed       — the orange alert
 */

type Phase = {
  index: 1 | 2 | 3 | 4;
  key: 'analyze' | 'plan' | 'generate' | 'render';
  label: string;
  hint: string;
  reviewRoute: (projectId: string) => string;
};

const PHASES: Phase[] = [
  {
    index: 1,
    key: 'analyze',
    label: 'Analyze',
    hint: 'Transcript → scenes',
    reviewRoute: (id) => `/p/${id}/script`,
  },
  {
    index: 2,
    key: 'plan',
    label: 'Plan shots',
    hint: 'Scenes → shots + prompts',
    reviewRoute: (id) => `/p/${id}/script`,
  },
  {
    index: 3,
    key: 'generate',
    label: 'Generate',
    hint: 'AI images + video clips',
    reviewRoute: (id) => `/p/${id}/board`,
  },
  {
    index: 4,
    key: 'render',
    label: 'Render',
    hint: 'Final long-form MP4',
    reviewRoute: (id) => `/p/${id}/timeline`,
  },
];

type StepState = 'pending' | 'working' | 'gate' | 'done' | 'failed';

/**
 * Map project status → per-step state. The "working" state is for phases the
 * pipeline is currently churning through; "gate" means the user must click
 * the next-step button in the TopBar.
 */
function stateForPhase(phase: Phase['key'], status: ProjectStatus | undefined): StepState {
  if (!status) return 'pending';
  if (status === 'failed') {
    // Mark the most advanced as failed, earlier ones as done
    return phase === 'render' ? 'failed' : 'done';
  }
  switch (phase) {
    case 'analyze':
      if (status === 'ingested' || status === 'analyzed') return 'working';
      // segmented + everything beyond means analyze finished successfully
      return 'done';
    case 'plan':
      if (status === 'ingested' || status === 'analyzed') return 'pending';
      if (status === 'segmented') return 'gate';
      if (status === 'classified') return 'working';
      // prompted + beyond → done
      return 'done';
    case 'generate':
      if (
        status === 'ingested' ||
        status === 'analyzed' ||
        status === 'segmented' ||
        status === 'classified'
      ) return 'pending';
      if (status === 'prompted') return 'gate';
      if (status === 'generating_assets') return 'working';
      // assets_ready + beyond → done
      return 'done';
    case 'render':
      if (status === 'assets_ready') return 'gate';
      if (
        status === 'timeline_built' ||
        status === 'audio_mixed' ||
        status === 'composited' ||
        status === 'encoded'
      ) return 'working';
      if (status === 'published') return 'done';
      return 'pending';
  }
}

export function PhaseStepper() {
  const params = useParams() as { projectId?: string };
  const projectId = params.projectId ?? '';
  const router = useRouter();
  const path = usePathname();

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId),
    enabled: !!projectId,
    refetchInterval: 3000,
  });

  const status = project?.status as ProjectStatus | undefined;

  return (
    <div className="shrink-0 border-b border-border bg-bg-subtle/40">
      <div className="flex items-stretch px-6 py-3 gap-2">
        {PHASES.map((phase, i) => {
          const state = stateForPhase(phase.key, status);
          const isLast = i === PHASES.length - 1;
          const reviewActive = projectId && path === phase.reviewRoute(projectId);
          return (
            <div key={phase.key} className="flex items-stretch flex-1 min-w-0">
              <button
                type="button"
                onClick={() => projectId && router.push(phase.reviewRoute(projectId))}
                className={cn(
                  'group flex items-center gap-3 flex-1 min-w-0 px-3 py-2 rounded-md text-left transition-colors',
                  reviewActive ? 'bg-bg-elev border border-border' : 'border border-transparent hover:bg-bg-elev',
                )}
                title={`Jump to ${phase.label} review`}
              >
                <PhaseBadge index={phase.index} state={state} />
                <div className="min-w-0">
                  <div
                    className={cn(
                      'text-[13px] font-medium leading-tight',
                      state === 'pending' ? 'text-text-faint' : 'text-text',
                    )}
                  >
                    {phase.label}
                  </div>
                  <div className="text-[11px] text-text-faint truncate">{phase.hint}</div>
                </div>
              </button>
              {!isLast && (
                <div className="flex items-center px-1 text-text-faint" aria-hidden>
                  <div className="h-px w-4 bg-border" />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PhaseBadge({ index, state }: { index: number; state: StepState }) {
  const base = 'shrink-0 grid place-items-center w-7 h-7 rounded-full border text-[11px] font-semibold';
  switch (state) {
    case 'done':
      return (
        <div className={cn(base, 'bg-ok/15 border-ok text-ok')}>
          <Check size={13} />
        </div>
      );
    case 'working':
      return (
        <div className={cn(base, 'bg-ember-500/15 border-ember-500 text-ember-500')}>
          <Loader2 size={13} className="animate-spin" />
        </div>
      );
    case 'gate':
      return (
        <div className={cn(base, 'bg-ember-500/10 border-ember-500 text-ember-500 shadow-ember')}>
          {index}
        </div>
      );
    case 'failed':
      return (
        <div className={cn(base, 'bg-bad/15 border-bad text-bad')}>
          <CircleAlert size={13} />
        </div>
      );
    case 'pending':
    default:
      return (
        <div className={cn(base, 'bg-bg-elev border-border text-text-faint')}>
          {index}
        </div>
      );
  }
}
