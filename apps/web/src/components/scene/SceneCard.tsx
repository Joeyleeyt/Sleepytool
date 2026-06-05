'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import {
  Film,
  Image as ImageIcon,
  Sparkles,
  MoreHorizontal,
  CheckCircle2,
  Volume2,
  Play,
  Pause,
  RotateCcw,
  RefreshCw,
  Loader2,
  Cloud,
  AlertTriangle,
  Pencil,
} from 'lucide-react';
import { Badge } from '@/components/primitives/Badge';
import { cn } from '@/lib/utils';
import { api, type ShotWithAssets } from '@/lib/api';

const SOURCE_ICON: Record<string, React.ElementType> = {
  cinematic_video: Film,
  image_with_motion: ImageIcon,
  atmospheric_broll: Sparkles,
  infographic: Sparkles,
  animated_diagram: Sparkles,
  motion_typography: Sparkles,
};

export function SceneCard({
  shot,
  sceneOrdinal,
  selected = false,
  onSelect,
  onOpenStudio,
}: {
  shot: ShotWithAssets;
  sceneOrdinal: number;
  selected?: boolean;
  onSelect?: (id: string, multi?: boolean) => void;
  onOpenStudio?: (id: string) => void;
}) {
  const qc = useQueryClient();
  const SourceIcon = SOURCE_ICON[shot.visualType] ?? Film;
  const isReady = shot.status === 'ready';
  const isFailed = shot.status === 'failed';

  // Combined generation phase for the still-working legs: if any leg has been
  // handed to 69labs it reads as "On 69Labs", otherwise it's still waiting in
  // the worker queue. Drives the small status pill on the generating card.
  const legs = [shot.progress.visual, shot.progress.narration];
  const genPhase = legs.includes('in_labs')
    ? ('in_labs' as const)
    : legs.includes('queued')
      ? ('queued' as const)
      : null;

  // Which legs to retry — both by default, narrowed to whatever failed.
  const failedLegs = [
    shot.failures.visual ? ('visual' as const) : null,
    shot.failures.narration ? ('narration' as const) : null,
  ].filter((x): x is 'visual' | 'narration' => x !== null);

  // Human-readable failure reason(s), prefixed by the leg that failed so a
  // mixed failure ("visual: … / narration: …") is unambiguous. Used both as a
  // short on-card label and the full tooltip on the retry control.
  const failureReason = [
    shot.failures.visual ? `visual: ${shot.failures.visual.message}` : null,
    shot.failures.narration ? `narration: ${shot.failures.narration.message}` : null,
  ]
    .filter(Boolean)
    .join('  /  ');

  const retry = useMutation({
    mutationFn: () => api.retryShot(shot.id, failedLegs.length ? failedLegs : undefined),
    onSuccess: () => {
      // Force /scenes to refetch so the failure pill disappears and the
      // card flips back to the generating shimmer.
      qc.invalidateQueries({ queryKey: ['scenes'] });
    },
  });
  const [hovered, setHovered] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Fetch signed visual URL only when the asset is ready and the card is mounted
  const visualAssetId = shot.assets.visual?.id;
  const { data: visualUrl } = useQuery({
    queryKey: ['asset-url', visualAssetId],
    queryFn: () => api.getAssetUrl(visualAssetId!),
    enabled: !!visualAssetId,
    staleTime: 50 * 60_000, // signed URLs valid 1 hr — refresh just under that
  });
  const narrationAssetId = shot.assets.narration?.id;
  // Once the user has clicked play (or hover preview triggered), keep the
  // narration URL fetched so subsequent replays don't refetch.
  const wantNarration = hovered || playing || ended;
  const { data: narrationUrl } = useQuery({
    queryKey: ['asset-url', narrationAssetId],
    queryFn: () => api.getAssetUrl(narrationAssetId!),
    enabled: !!narrationAssetId && wantNarration,
    staleTime: 50 * 60_000,
  });

  const hasVideo = visualUrl?.kind === 'video_clip' && !!visualUrl.url;
  const hasImage = visualUrl?.kind === 'image' && !!visualUrl.url;
  const hasNarration = !!narrationUrl?.url;
  const isPlayable = isReady && (hasVideo || hasNarration);

  // Pause everything if the card unmounts (e.g. filter switch)
  useEffect(() => {
    return () => {
      videoRef.current?.pause();
      audioRef.current?.pause();
    };
  }, []);

  const startPlayback = (e: MouseEvent) => {
    e.stopPropagation();
    setEnded(false);
    setPlaying(true);
    const v = videoRef.current;
    const a = audioRef.current;
    if (v) {
      v.currentTime = 0;
      v.muted = false;
      v.play().catch(() => v.play().catch(() => {}));
    }
    if (a) {
      a.currentTime = 0;
      a.play().catch(() => {});
    }
  };

  const pausePlayback = (e: MouseEvent) => {
    e.stopPropagation();
    setPlaying(false);
    videoRef.current?.pause();
    audioRef.current?.pause();
  };

  // When video clip ends, mark for replay. (Image-with-audio shots end when
  // the narration audio finishes.)
  const handleEnded = () => {
    setPlaying(false);
    setEnded(true);
  };

  const handleCardClick = (e: MouseEvent) => {
    // Selection click; multi with cmd/ctrl
    onSelect?.(shot.id, e.metaKey || e.ctrlKey);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onSelect?.(shot.id, e.metaKey || e.ctrlKey);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={handleCardClick}
      onKeyDown={handleKeyDown}
      onDoubleClick={() => onOpenStudio?.(shot.id)}
      className={cn(
        'group h-full flex flex-col text-left rounded-card overflow-hidden border bg-bg-elev hover:border-border-strong transition-all cursor-pointer focus:outline-none focus:ring-2 focus:ring-ember-500/50',
        selected ? 'border-ember-500 shadow-ember' : 'border-border',
      )}
    >
      <div className="relative shrink-0 aspect-video bg-bg-subtle grid place-items-center text-text-faint overflow-hidden">
        {isReady ? (
          <>
            {hasImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={visualUrl!.url} alt="" className="absolute inset-0 w-full h-full object-cover" />
            ) : hasVideo ? (
              <video
                ref={videoRef}
                src={visualUrl!.url}
                muted={!playing}
                loop={!playing}
                playsInline
                autoPlay={hovered && !playing}
                onEnded={handleEnded}
                className="absolute inset-0 w-full h-full object-cover"
              />
            ) : (
              <SourceIcon size={28} />
            )}

            {/* Click-to-play / pause / replay control */}
            {isPlayable && (
              <button
                type="button"
                aria-label={playing ? 'Pause' : ended ? 'Replay' : 'Play'}
                onClick={playing ? pausePlayback : startPlayback}
                className={cn(
                  'absolute inset-0 grid place-items-center transition-opacity z-10',
                  playing ? 'opacity-0 hover:opacity-100' : 'opacity-90 hover:opacity-100',
                )}
              >
                <span className="grid place-items-center w-11 h-11 rounded-full bg-black/55 backdrop-blur-sm text-white shadow-lg transition-transform group-hover:scale-105">
                  {playing ? (
                    <Pause size={20} />
                  ) : ended ? (
                    <RotateCcw size={20} />
                  ) : (
                    <Play size={20} className="translate-x-[1px]" />
                  )}
                </span>
              </button>
            )}

            {/* Narration audio — single element, controlled by both hover
                preview and the explicit play button via the ref. */}
            {hasNarration && (
              <audio
                ref={audioRef}
                src={narrationUrl!.url}
                autoPlay={hovered && !playing}
                onEnded={hasVideo ? undefined : handleEnded}
              />
            )}

            <CheckCircle2 size={14} className="absolute top-2 right-2 text-ok drop-shadow" />
            {(hovered || playing) && (
              <Volume2 size={12} className="absolute top-2 left-2 text-white/80 drop-shadow" />
            )}
          </>
        ) : (
          // Both generating and failed shots use the active "generating"
          // animation — an ember beam + breathing glow + pulsing icon — so it
          // reads as work-in-progress, not a neutral loading skeleton. A
          // failure should not look like an error/warning card.
          <>
            {/* <div className="absolute inset-0 generating-glow" /> */}
            {/* <div className="absolute inset-0 generating-sweep" /> */}
            {/* <SourceIcon size={28} className="relative text-ember-400 generating-icon" /> */}

            {/* Status pill — tells the operator exactly where a still-working
                shot is: waiting in the labs-worker queue vs already rendering on
                69labs. Hidden for failed shots (the retry control covers that). */}
            {!isFailed && genPhase && (
              <span
                className={cn(
                  'absolute top-2 left-2 z-10 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium backdrop-blur-sm',
                  genPhase === 'in_labs'
                    ? 'bg-ember-500/20 text-ember-300'
                    : 'bg-black/45 text-white/70',
                )}
              >
                {genPhase === 'in_labs' ? (
                  <>
                    <Cloud size={11} />
                    On 69Labs
                  </>
                ) : (
                  <>
                    <Loader2 size={11} className="animate-spin" />
                    Queued
                  </>
                )}
              </span>
            )}

            {/* Failed shots stay visually identical to generating ones; a
                subtle, neutral retry control surfaces only on hover so the
                shot can still be re-run. The reason the generation failed is
                shown as a small pill (top-left) plus the full message on the
                retry control's tooltip, so the operator knows WHY before
                re-running. */}
            {isFailed && (
              <>
                {failureReason && (
                  // Purely visual — pointer-events-none so clicks/hover fall
                  // through to the full-card retry button beneath (which carries
                  // the full untruncated message in its tooltip).
                  <span className="pointer-events-none absolute top-2 left-2 z-20 max-w-[calc(100%-2.5rem)] inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium bg-bad/20 text-bad backdrop-blur-sm">
                    <AlertTriangle size={11} className="shrink-0" />
                    <span className="truncate">{failureReason}</span>
                  </span>
                )}
                {/* Edit-prompt entry — opens Studio so the operator can rework
                    the prompt and re-send to 69labs, distinct from the quick
                    same-prompt retry (full-card button below). z-30 + real
                    pointer events so it isn't swallowed by the retry overlay. */}
                <button
                  type="button"
                  aria-label="Edit prompt"
                  title="Edit prompt & re-send to 69labs"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenStudio?.(shot.id);
                  }}
                  className={cn(
                    'absolute top-2 right-2 z-30 grid place-items-center w-7 h-7 rounded-full bg-black/55 backdrop-blur-sm text-white/90 shadow transition-opacity hover:bg-black/75',
                    hovered ? 'opacity-100' : 'opacity-0',
                  )}
                >
                  <Pencil size={13} />
                </button>
                <button
                  type="button"
                  aria-label="Retry"
                  title={
                    retry.error
                      ? (retry.error as Error).message
                      : failureReason
                        ? `${failureReason}\n\nClick to retry`
                        : 'Retry generation'
                  }
                  disabled={retry.isPending}
                  onClick={(e) => {
                    e.stopPropagation();
                    retry.mutate();
                  }}
                  className={cn(
                    'absolute inset-0 grid place-items-center transition-opacity z-10 disabled:cursor-wait',
                    retry.isPending || hovered ? 'opacity-100' : 'opacity-0',
                  )}
                >
                  <span className="grid place-items-center w-11 h-11 rounded-full bg-black/55 backdrop-blur-sm text-white shadow-lg transition-transform group-hover:scale-105">
                    <RefreshCw size={18} className={retry.isPending ? 'animate-spin' : ''} />
                  </span>
                </button>
              </>
            )}
          </>
        )}
      </div>
      <div className="p-2.5 flex-1 flex flex-col">
        <div className="flex items-center justify-between gap-2 text-[11px] text-text-faint">
          <div className="flex items-center gap-1.5 font-mono">
            <span>S{sceneOrdinal + 1}·{shot.ordinal + 1}</span>
            <span>·</span>
            <span>{Number(shot.durationS).toFixed(1)}s</span>
          </div>
          <SourceIcon size={13} className="text-text-dim" />
        </div>
        <p className="mt-1.5 text-[13px] font-narration leading-snug text-text line-clamp-2">
          {shot.narrationText}
        </p>
        {/* Tag + prompt group — pinned to the bottom (mt-auto) so the tag sits
            next to the prompt rather than under the media, with a guaranteed
            top margin (pt-3) above the tag. */}
        <div className="mt-auto pt-3">
          {/* Tag row — fixed height so cards stay the same height whether or
              not the shot has a tag like "embers". */}
          <div className="flex items-center justify-between gap-2 min-h-5">
            <div className="flex items-center gap-1">
              {(shot.fxRecommendation as { embers?: string })?.embers && (shot.fxRecommendation as { embers?: string }).embers !== 'off' && (
                <Badge tone="ember" className="lowercase">embers</Badge>
              )}
            </div>
            <MoreHorizontal size={14} className="text-text-faint opacity-0 group-hover:opacity-100" />
          </div>
          {/* Visual prompt preview — shown in every state (generating, failed,
              and ready) so the user can scan all prompts on /board without
              opening Studio. */}
          {shot.visualPrompt && (
            <div className="pt-2">
              <div className="rounded border border-border bg-bg-subtle/60 p-2">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <Badge tone="neutral" className="font-mono lowercase">
                    {shot.visualPrompt.target}
                  </Badge>
                  <span className="text-[10px] text-text-faint">prompt</span>
                </div>
                <p className="text-[11px] text-text-dim leading-snug line-clamp-2 font-mono">
                  {shot.visualPrompt.promptText}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
