'use client';
import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X, Play, Sparkles, Film, Image as ImageIcon, Save, Loader2 } from 'lucide-react';
import { Button } from '@/components/primitives/Button';
import { Badge } from '@/components/primitives/Badge';
import { api, type ShotPrompt } from '@/lib/api';

const TTS_TARGET = '69labs.tts';

export default function StudioPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { projectId, shotId } = useParams() as { projectId: string; shotId: string };

  const { data: scenesData } = useQuery({
    queryKey: ['scenes', projectId],
    queryFn: () => api.getScenes(projectId),
  });

  const scene = scenesData?.scenes.find((s) => s.shots.some((sh) => sh.id === shotId));
  const shot = scene?.shots.find((s) => s.id === shotId);

  // Load real prompts so the operator can review + override what the worker
  // will actually send to 69labs / Veo 3.
  const { data: promptsData, isLoading: promptsLoading } = useQuery({
    queryKey: ['shot-prompts', shotId],
    queryFn: () => api.getShotPrompts(shotId),
    enabled: !!shotId,
  });

  // The "visual" prompt is whichever target matches the shot's visualType.
  // We deliberately ignore the TTS prompt here — the narration text is owned
  // by the transcript, not the prompt row.
  const visualPrompt: ShotPrompt | undefined = useMemo(
    () => promptsData?.prompts.find((p) => p.target !== TTS_TARGET),
    [promptsData],
  );

  const [draft, setDraft] = useState('');
  const [negative, setNegative] = useState('');
  useEffect(() => {
    setDraft(visualPrompt?.promptText ?? '');
    setNegative(visualPrompt?.negative ?? '');
  }, [visualPrompt?.id, visualPrompt?.promptText, visualPrompt?.negative]);

  const dirty = !!visualPrompt && (
    draft !== (visualPrompt.promptText ?? '') ||
    negative !== (visualPrompt.negative ?? '')
  );

  const save = useMutation({
    mutationFn: () => {
      if (!visualPrompt) throw new Error('no visual prompt loaded');
      return api.updatePrompt(visualPrompt.id, {
        promptText: draft,
        negative: negative.length > 0 ? negative : null,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shot-prompts', shotId] });
    },
  });

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

        <div className="grid grid-cols-[1fr_360px]">
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
              </div>
            </section>
          </div>

          <div className="p-4 space-y-4 max-h-[calc(100vh-200px)] overflow-y-auto">
            <section>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs uppercase tracking-wider text-text-faint">Prompt</h3>
                {visualPrompt && (
                  <span className="text-[10px] text-text-faint font-mono">
                    {visualPrompt.target}
                  </span>
                )}
              </div>
              {promptsLoading ? (
                <div className="h-32 grid place-items-center text-text-faint text-xs">
                  <Loader2 size={14} className="animate-spin" />
                </div>
              ) : !visualPrompt ? (
                <div className="text-xs text-text-dim p-3 rounded border border-border bg-bg">
                  No prompt has been built for this shot yet — finish Phase 2 (Plan shots) first.
                </div>
              ) : (
                <>
                  <textarea
                    rows={8}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    className="w-full bg-bg border border-border rounded-md px-3 py-2 text-xs font-mono focus:outline-none focus:border-ember-500 resize-none"
                  />
                  <h4 className="text-[11px] uppercase tracking-wider text-text-faint mt-3 mb-1">Negative</h4>
                  <textarea
                    rows={2}
                    value={negative}
                    onChange={(e) => setNegative(e.target.value)}
                    placeholder="things to avoid (optional)"
                    className="w-full bg-bg border border-border rounded-md px-3 py-2 text-xs font-mono focus:outline-none focus:border-ember-500 resize-none"
                  />
                  <Button
                    variant={dirty ? 'primary' : 'secondary'}
                    size="sm"
                    className="w-full mt-3"
                    disabled={!dirty || save.isPending}
                    onClick={() => save.mutate()}
                  >
                    {save.isPending ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                    {save.isPending ? 'Saving…' : dirty ? 'Save prompt' : 'Saved'}
                  </Button>
                  {save.error && (
                    <div className="text-[11px] text-bad mt-2">{(save.error as Error).message}</div>
                  )}
                  <p className="text-[11px] text-text-faint mt-2 leading-snug">
                    Saving updates the prompt only. To regenerate this shot's image / video with the new prompt, delete its asset row and replay the asset stage — otherwise the worker will reuse the cached R2 object.
                  </p>
                </>
              )}
            </section>

            <section>
              <h3 className="text-xs uppercase tracking-wider text-text-faint mb-2">Model</h3>
              <div className="space-y-1.5">
                <ModelOption icon={Film} label="Veo 3" eta="60s" selected={shot?.visualType === 'cinematic_video'} />
                <ModelOption icon={Sparkles} label="69labs video" eta="40s" selected={shot?.visualType === 'atmospheric_broll'} />
                <ModelOption icon={ImageIcon} label="69labs image" eta="6s" selected={shot?.visualType === 'image_with_motion'} />
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

function ModelOption({
  icon: Icon,
  label,
  eta,
  selected,
}: {
  icon: React.ElementType;
  label: string;
  eta: string;
  selected?: boolean;
}) {
  return (
    <label className={`flex items-center gap-2 p-2 rounded border cursor-pointer ${selected ? 'border-ember-500 bg-ember-500/5' : 'border-border hover:border-border-strong'}`}>
      <input type="radio" name="model" defaultChecked={selected} disabled className="accent-ember-500" />
      <Icon size={14} className="text-text-dim" />
      <span className="text-xs flex-1">{label}</span>
      <span className="text-[11px] text-text-faint font-mono">{eta}</span>
    </label>
  );
}
