'use client';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ThreePane } from '@/components/layout/ThreePane';
import { Badge } from '@/components/primitives/Badge';
import { PhaseBanner } from '@/components/layout/PhaseBanner';
import { api } from '@/lib/api';
import { STAGE_LABELS } from '@/lib/utils';

export default function ScriptPage() {
  const { projectId } = useParams() as { projectId: string };
  const { data: project } = useQuery({ queryKey: ['project', projectId], queryFn: () => api.getProject(projectId) });
  const { data: scenesData } = useQuery({
    queryKey: ['scenes', projectId],
    queryFn: () => api.getScenes(projectId),
    refetchInterval: 5000,
  });
  const scenes = scenesData?.scenes ?? [];
  const totalShots = scenes.reduce((n, s) => n + s.shots.length, 0);

  return (
    <ThreePane
      inspector={
        <div className="p-4 space-y-4">
          <h3 className="text-xs uppercase tracking-wider text-text-faint">Script analysis</h3>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <Stat label="Scenes" value={scenes.length} />
            <Stat label="Shots" value={totalShots} />
          </div>
          <div className="space-y-2">
            <h3 className="text-xs uppercase tracking-wider text-text-faint">Style</h3>
            <Badge tone="ember">{project?.stylePreset ?? '—'}</Badge>
          </div>
          <div className="space-y-2">
            <h3 className="text-xs uppercase tracking-wider text-text-faint">Pipeline</h3>
            <Badge tone="busy">{STAGE_LABELS[project?.status ?? 'ingested']}</Badge>
          </div>
        </div>
      }
    >
      <div className="h-full flex flex-col min-h-0">
        <PhaseBanner surface="script" />
        <div className="flex-1 overflow-y-auto"><div className="max-w-3xl mx-auto px-8 py-10">
          {scenes.length === 0 ? (
            <div className="text-text-dim">
              <h2 className="font-display text-xl mb-2">Analyzing transcript…</h2>
              <p className="text-sm">Scenes will appear here as soon as segmentation finishes.</p>
            </div>
          ) : (
            <div className="space-y-6">
              {scenes.map((scene) => (
                <article key={scene.id} className="border-l-2 border-border pl-4 group hover:border-ember-500/60 transition-colors">
                  <header className="flex items-center gap-2 mb-2 text-xs text-text-faint">
                    <span className="font-mono">S{scene.ordinal + 1}</span>
                    {scene.title && <span>{scene.title}</span>}
                    {scene.emotion && <Badge>{scene.emotion}</Badge>}
                    {scene.pacing && <Badge>{scene.pacing}</Badge>}
                    <span className="ml-auto tabular-nums">{scene.shots.length} shots</span>
                  </header>
                  <p className="text-[15px] leading-relaxed font-narration text-text">{scene.narrationChunk}</p>
                </article>
              ))}
            </div>
          )}
        </div></div>
      </div>
    </ThreePane>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-bg-elev border border-border rounded-md p-2">
      <div className="text-[11px] text-text-faint uppercase tracking-wider">{label}</div>
      <div className="text-base font-display font-semibold tabular-nums">{value}</div>
    </div>
  );
}

