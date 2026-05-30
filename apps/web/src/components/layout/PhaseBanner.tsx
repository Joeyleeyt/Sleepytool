'use client';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowUp, CheckCircle2, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { ProjectStatus } from '@emberforge/core';

/**
 * Page-local banner explaining what the user should do RIGHT NOW. Distinct
 * from the top stepper (which is global progress) — this is an inline call
 * to action inside the page content. Pass `surface="script"` or `"board"` to
 * scope the messaging to what's relevant on that page.
 */
type Surface = 'script' | 'board';

const MESSAGES: Record<Surface, Partial<Record<ProjectStatus, { tone: 'busy' | 'gate' | 'done'; title: string; body: string }>>> = {
  script: {
    ingested: { tone: 'busy', title: 'Analyzing transcript…', body: 'The LLM is extracting the topic, narrative arc, and recurring entities. Typical wait: 15–90 seconds depending on transcript length.' },
    analyzed: { tone: 'busy', title: 'Segmenting into scenes…', body: 'Each scene will cover 60–180s of narration with its own emotion and atmosphere.' },
    segmented: {
      tone: 'gate',
      title: 'Step 2 — review the scene breakdown',
      body: 'Scan the scenes below. Tweak the style preset in the right panel if you want a different look, then click "Plan shots" in the top bar to break each scene into 3–5s shots.',
    },
  },
  board: {
    classified: { tone: 'busy', title: 'Building per-shot prompts…', body: 'Prompts are assembled deterministically from each shot\'s visual type, camera, lens, and style preset.' },
    prompted: {
      tone: 'gate',
      title: 'Step 3 — review the shot list',
      body: 'Each card shows a shot with its visual type and narration text. Open a shot in Studio to inspect or edit its prompt. When you\'re happy, click "Generate assets" in the top bar — that\'s the first step that actually spends on AI generation.',
    },
    generating_assets: {
      tone: 'busy',
      title: 'Generating AI images and video clips…',
      body: 'Each shot fans out to 69labs / Veo 3 / TTS in parallel. Cards fill in as assets complete.',
    },
    assets_ready: {
      tone: 'gate',
      title: 'Step 4 — review the generated assets',
      body: 'Hover any card to play its video clip or narration. If a shot needs to be regenerated, do it now. When everything looks right, click "Render final video" in the top bar.',
    },
  },
};

export function PhaseBanner({ surface }: { surface: Surface }) {
  const params = useParams() as { projectId?: string };
  const projectId = params.projectId ?? '';

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId),
    enabled: !!projectId,
    refetchInterval: 3000,
  });

  const status = project?.status as ProjectStatus | undefined;
  const msg = status ? MESSAGES[surface][status] : undefined;
  if (!msg) return null;

  return (
    <div
      className={cn(
        'shrink-0 border-b border-border px-6 py-3 flex items-start gap-3',
        msg.tone === 'gate' && 'bg-ember-500/5',
        msg.tone === 'busy' && 'bg-bg-subtle/50',
        msg.tone === 'done' && 'bg-ok/5',
      )}
    >
      <div className="mt-0.5 shrink-0">
        {msg.tone === 'gate' ? (
          <ArrowUp size={16} className="text-ember-500" />
        ) : msg.tone === 'busy' ? (
          <Loader2 size={16} className="text-ember-500 animate-spin" />
        ) : (
          <CheckCircle2 size={16} className="text-ok" />
        )}
      </div>
      <div className="min-w-0">
        <div className="text-sm font-medium text-text">{msg.title}</div>
        <div className="text-xs text-text-dim mt-0.5 leading-snug">{msg.body}</div>
      </div>
    </div>
  );
}
