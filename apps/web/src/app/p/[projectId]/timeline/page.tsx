'use client';
import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { ThreePane } from '@/components/layout/ThreePane';
import { Badge } from '@/components/primitives/Badge';
import { Button } from '@/components/primitives/Button';
import { api } from '@/lib/api';
import { formatDuration } from '@/lib/utils';

const PX_PER_SECOND_OPTIONS = [2, 8, 24]; // ~ zoom levels

export default function TimelinePage() {
  const { projectId } = useParams() as { projectId: string };
  const [pxPerSec, setPxPerSec] = useState<number>(8);
  const [selectedShot, setSelectedShot] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ['scenes', projectId],
    queryFn: () => api.getScenes(projectId),
    refetchInterval: 5000,
  });

  const clips = useMemo(() => {
    if (!data) return [];
    let cursor = 0;
    const result: { id: string; startS: number; durationS: number; visualType: string; label: string; sceneOrdinal: number }[] = [];
    for (const scene of data.scenes) {
      for (const shot of scene.shots) {
        const d = Number(shot.assets.narration?.durationS ?? shot.durationS);
        result.push({
          id: shot.id,
          startS: cursor,
          durationS: d,
          visualType: shot.visualType,
          label: shot.narrationText.slice(0, 40),
          sceneOrdinal: scene.ordinal,
        });
        cursor += d;
      }
    }
    return result;
  }, [data]);

  const totalDur = clips.length ? clips[clips.length - 1]!.startS + clips[clips.length - 1]!.durationS : 0;

  const selectedClip = clips.find((c) => c.id === selectedShot) ?? null;

  return (
    <ThreePane
      inspector={
        selectedClip ? (
          <ClipInspector clip={selectedClip} />
        ) : (
          <div className="p-4 space-y-3 text-sm text-text-dim">
            <h3 className="text-xs uppercase tracking-wider text-text-faint">Timeline</h3>
            <p>Click any clip to inspect.</p>
            <div className="text-text">Total runtime: <span className="font-mono">{formatDuration(totalDur)}</span></div>
            <div>Clips: <span className="font-mono">{clips.length}</span></div>
          </div>
        )
      }
    >
      <div className="h-full flex flex-col">
        <PreviewMonitor totalDur={totalDur} />

        <div className="border-t border-border p-2 flex items-center gap-3 bg-bg-subtle">
          <span className="text-xs text-text-faint">Zoom</span>
          {PX_PER_SECOND_OPTIONS.map((p) => (
            <button
              key={p}
              onClick={() => setPxPerSec(p)}
              className={`text-xs px-2 h-6 rounded border ${
                pxPerSec === p ? 'border-ember-500 text-ember-400' : 'border-border text-text-dim hover:text-text'
              }`}
            >
              {p === 2 ? 'Project' : p === 8 ? 'Scene' : 'Frame'}
            </button>
          ))}
          <div className="ml-auto text-xs text-text-faint font-mono">{formatDuration(totalDur)}</div>
        </div>

        <div className="flex-1 overflow-auto bg-bg-subtle">
          <Tracks clips={clips} pxPerSec={pxPerSec} selectedId={selectedShot} onSelect={setSelectedShot} />
        </div>

        <Minimap clips={clips} totalDur={totalDur} />
      </div>
    </ThreePane>
  );
}

function PreviewMonitor({ totalDur }: { totalDur: number }) {
  return (
    <div className="aspect-video max-h-[40vh] mx-auto mt-4 w-[min(100%-2rem,1200px)] bg-black rounded-card border border-border grid place-items-center text-text-faint">
      <div className="text-center">
        <Play size={42} className="mx-auto opacity-50" />
        <div className="mt-2 text-xs font-mono">00:00 / {formatDuration(totalDur)}</div>
        <div className="mt-1 text-[11px] text-text-faint">Preview will appear after render</div>
      </div>
    </div>
  );
}

function Tracks({
  clips,
  pxPerSec,
  selectedId,
  onSelect,
}: {
  clips: { id: string; startS: number; durationS: number; visualType: string; label: string }[];
  pxPerSec: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const trackWidth = clips.length ? (clips[clips.length - 1]!.startS + clips[clips.length - 1]!.durationS) * pxPerSec : 0;

  const TRACK_LABEL = 'w-16 shrink-0 h-full grid place-items-center text-[11px] text-text-faint border-r border-border bg-bg';

  return (
    <div className="min-w-full" style={{ width: trackWidth + 64 }}>
      {/* V2: overlay ribbon */}
      <div className="h-8 flex border-b border-border">
        <div className={TRACK_LABEL}>V2</div>
        <div className="relative flex-1 bg-ember-500/10">
          <div className="absolute inset-0 bg-[linear-gradient(90deg,transparent_0,rgba(251,146,60,0.2)_50%,transparent_100%)] bg-[length:40px_100%]" />
        </div>
      </div>

      {/* V1: video clips */}
      <div className="h-16 flex border-b border-border">
        <div className={TRACK_LABEL}>V1</div>
        <div className="relative flex-1">
          {clips.map((c) => (
            <button
              key={c.id}
              onClick={() => onSelect(c.id)}
              className={`absolute top-1 bottom-1 rounded border text-left px-2 py-1 overflow-hidden transition-colors ${
                selectedId === c.id
                  ? 'bg-ember-500/20 border-ember-500'
                  : 'bg-bg-elev border-border hover:border-border-strong'
              }`}
              style={{ left: c.startS * pxPerSec, width: Math.max(20, c.durationS * pxPerSec - 2) }}
              title={c.label}
            >
              <div className="text-[10px] text-text-faint truncate">{c.visualType}</div>
              <div className="text-[11px] text-text truncate">{c.label}</div>
            </button>
          ))}
        </div>
      </div>

      {/* A1: narration */}
      <div className="h-12 flex border-b border-border">
        <div className={TRACK_LABEL}>A1</div>
        <div className="relative flex-1 bg-bg">
          {clips.map((c) => (
            <div
              key={c.id}
              className="absolute top-1 bottom-1 bg-slate-700/60 border border-slate-600 rounded flex items-center px-1.5"
              style={{ left: c.startS * pxPerSec, width: Math.max(10, c.durationS * pxPerSec - 2) }}
            >
              <div className="h-2 flex-1 bg-[repeating-linear-gradient(90deg,#94a3b8_0,#94a3b8_1px,transparent_1px,transparent_3px)] opacity-50" />
            </div>
          ))}
        </div>
      </div>

      {/* A2: music */}
      <div className="h-10 flex border-b border-border">
        <div className={TRACK_LABEL}>A2</div>
        <div className="relative flex-1 bg-indigo-950/30">
          <div className="absolute inset-0 flex items-center justify-center text-[10px] text-indigo-300/40">music — disabled in safe mode</div>
        </div>
      </div>

      {/* S1: subtitles */}
      <div className="h-7 flex">
        <div className={TRACK_LABEL}>S1</div>
        <div className="relative flex-1 bg-black/40">
          {clips.map((c) => (
            <div
              key={c.id}
              className="absolute top-1 bottom-1 text-[10px] text-white/80 truncate px-1.5 bg-black/30 rounded"
              style={{ left: c.startS * pxPerSec, width: Math.max(20, c.durationS * pxPerSec - 2) }}
            >
              {c.label}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Minimap({ clips, totalDur }: { clips: { id: string; startS: number; durationS: number }[]; totalDur: number }) {
  return (
    <div className="h-8 shrink-0 border-t border-border bg-bg-subtle px-3 flex items-center">
      <div className="relative flex-1 h-3 bg-bg-elev rounded overflow-hidden">
        {clips.map((c) => (
          <div
            key={c.id}
            className="absolute top-0 bottom-0 bg-ember-500/50"
            style={{ left: `${(c.startS / Math.max(1, totalDur)) * 100}%`, width: `${(c.durationS / Math.max(1, totalDur)) * 100}%` }}
          />
        ))}
      </div>
    </div>
  );
}

function ClipInspector({ clip }: { clip: { id: string; durationS: number; visualType: string; label: string; sceneOrdinal: number } }) {
  return (
    <div className="p-4 space-y-4">
      <div>
        <h3 className="text-xs uppercase tracking-wider text-text-faint">Clip</h3>
        <p className="mt-1 text-sm font-narration italic text-text">{clip.label}</p>
      </div>
      <div className="grid grid-cols-2 gap-2 text-sm">
        <Stat label="Scene" value={`S${clip.sceneOrdinal + 1}`} />
        <Stat label="Duration" value={`${clip.durationS.toFixed(1)}s`} />
      </div>
      <div className="space-y-1">
        <div className="text-xs text-text-faint uppercase tracking-wider">Visual type</div>
        <Badge tone="ember">{clip.visualType}</Badge>
      </div>
      <div className="space-y-2">
        <Button className="w-full justify-start">Regenerate this clip</Button>
        <Button className="w-full justify-start">Generate 4 variations</Button>
        <Button className="w-full justify-start">Replace from library…</Button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-bg-elev border border-border rounded-md p-2">
      <div className="text-[11px] text-text-faint uppercase tracking-wider">{label}</div>
      <div className="text-base font-display font-semibold tabular-nums">{value}</div>
    </div>
  );
}
