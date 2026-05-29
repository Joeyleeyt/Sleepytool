'use client';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { X, Play, Sparkles, Film, Image as ImageIcon } from 'lucide-react';
import { Button } from '@/components/primitives/Button';
import { Badge } from '@/components/primitives/Badge';
import { api } from '@/lib/api';
import { formatUsd } from '@/lib/utils';

const COSTS: Record<string, number> = {
  cinematic_video: 1.2,
  atmospheric_broll: 0.8,
  image_with_motion: 0.04,
};

export default function StudioPage() {
  const router = useRouter();
  const { projectId, shotId } = useParams() as { projectId: string; shotId: string };

  const { data: scenesData } = useQuery({
    queryKey: ['scenes', projectId],
    queryFn: () => api.getScenes(projectId),
  });

  const scene = scenesData?.scenes.find((s) => s.shots.some((sh) => sh.id === shotId));
  const shot = scene?.shots.find((s) => s.id === shotId);

  return (
    <div className="fixed inset-0 z-50 bg-black/70 grid place-items-center p-6" onClick={() => router.back()}>
      <div className="w-full max-w-5xl bg-bg-elev border border-border rounded-card overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b border-border flex items-center justify-between">
          <div className="min-w-0">
            <h2 className="font-display text-sm font-semibold">
              Scene {scene?.ordinal !== undefined ? scene.ordinal + 1 : '?'} · Shot {shot?.ordinal !== undefined ? shot.ordinal + 1 : '?'}
            </h2>
            <p className="mt-0.5 text-xs text-text-dim truncate max-w-2xl">{shot?.narrationText ?? ''}</p>
          </div>
          <button onClick={() => router.back()} className="text-text-dim hover:text-text">
            <X size={18} />
          </button>
        </div>

        <div className="grid grid-cols-[1fr_320px]">
          <div className="p-4 border-r border-border space-y-4">
            <div className="aspect-video bg-black rounded grid place-items-center text-text-faint">
              <div className="text-center">
                <Play size={36} className="mx-auto opacity-50" />
                <div className="mt-2 text-xs">Preview</div>
              </div>
            </div>

            <section>
              <h3 className="text-xs uppercase tracking-wider text-text-faint mb-2">Variations</h3>
              <div className="grid grid-cols-4 gap-2">
                {[1, 2, 3, 4].map((n) => (
                  <button
                    key={n}
                    className={`aspect-video rounded border ${n === 1 ? 'border-ember-500' : 'border-border'} bg-bg-subtle grid place-items-center text-text-faint hover:border-border-strong transition-colors`}
                  >
                    <span className="text-xs">v{n}</span>
                  </button>
                ))}
              </div>
              <div className="mt-2 flex items-center justify-between text-xs text-text-faint">
                <span>v1 selected</span>
                <span className="font-mono">cost: $4.80</span>
              </div>
            </section>

            <section>
              <h3 className="text-xs uppercase tracking-wider text-text-faint mb-2">History</h3>
              <div className="space-y-1 text-xs">
                <Row time="today 14:22" provider="69labs" cost={0.04} selected />
                <Row time="today 13:51" provider="69labs" cost={0.04} />
              </div>
            </section>
          </div>

          <div className="p-4 space-y-4">
            <section>
              <h3 className="text-xs uppercase tracking-wider text-text-faint mb-2">Prompt</h3>
              <textarea
                rows={6}
                defaultValue={shot?.visualSummary ?? ''}
                className="w-full bg-bg border border-border rounded-md px-3 py-2 text-xs font-mono focus:outline-none focus:border-ember-500"
              />
            </section>

            <section>
              <h3 className="text-xs uppercase tracking-wider text-text-faint mb-2">Model</h3>
              <div className="space-y-1.5">
                <ModelOption icon={Film} label="Veo 3" cost={COSTS.cinematic_video!} eta="60s" selected={shot?.visualType === 'cinematic_video'} />
                <ModelOption icon={Sparkles} label="69labs video" cost={COSTS.atmospheric_broll!} eta="40s" selected={shot?.visualType === 'atmospheric_broll'} />
                <ModelOption icon={ImageIcon} label="69labs image" cost={COSTS.image_with_motion!} eta="6s" selected={shot?.visualType === 'image_with_motion'} />
              </div>
            </section>

            <section className="pt-2">
              <Button variant="primary" className="w-full">Generate</Button>
              <button className="mt-2 w-full text-xs text-text-dim hover:text-text">Generate 4 variations (≈$0.16)</button>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ time, provider, cost, selected }: { time: string; provider: string; cost: number; selected?: boolean }) {
  return (
    <div className={`flex items-center justify-between p-1.5 rounded ${selected ? 'bg-ember-500/10 border border-ember-500/30' : 'border border-transparent'}`}>
      <div className="flex items-center gap-2">
        <span className="text-text-dim">{time}</span>
        <Badge>{provider}</Badge>
      </div>
      <span className="font-mono text-text-dim">{formatUsd(cost)}</span>
    </div>
  );
}

function ModelOption({
  icon: Icon,
  label,
  cost,
  eta,
  selected,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  cost: number;
  eta: string;
  selected?: boolean;
}) {
  return (
    <label className={`flex items-center gap-2 p-2 rounded border cursor-pointer ${selected ? 'border-ember-500 bg-ember-500/5' : 'border-border hover:border-border-strong'}`}>
      <input type="radio" name="model" defaultChecked={selected} className="accent-ember-500" />
      <Icon size={14} className="text-text-dim" />
      <span className="text-xs flex-1">{label}</span>
      <span className="text-[11px] text-text-faint font-mono">~{formatUsd(cost)} · {eta}</span>
    </label>
  );
}
