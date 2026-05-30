'use client';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import {
  Film,
  Image as ImageIcon,
  Sparkles,
  MoreHorizontal,
  Lock,
  AlertTriangle,
  CheckCircle2,
  Volume2,
  Play,
  Pause,
  RotateCcw,
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
  const SourceIcon = SOURCE_ICON[shot.visualType] ?? Film;
  const isReady = shot.status === 'ready';
  const isFailed = shot.status === 'pending' && false;
  const isGenerating = shot.status === 'pending' || shot.status === 'partial';
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
        'group text-left rounded-card overflow-hidden border bg-bg-elev hover:border-border-strong transition-all cursor-pointer focus:outline-none focus:ring-2 focus:ring-ember-500/50',
        selected ? 'border-ember-500 shadow-ember' : 'border-border',
      )}
    >
      <div className="relative aspect-video bg-bg-subtle grid place-items-center text-text-faint overflow-hidden">
        {isGenerating ? (
          <>
            <div className="absolute inset-0 shimmer" />
            <SourceIcon size={28} className="relative" />
          </>
        ) : isReady ? (
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
          <>
            <AlertTriangle size={28} className="text-bad" />
          </>
        )}
      </div>
      <div className="p-2.5">
        <div className="flex items-center justify-between gap-2 text-[11px] text-text-faint">
          <div className="flex items-center gap-1.5 font-mono">
            <span>S{sceneOrdinal + 1}·{shot.ordinal + 1}</span>
            <span>·</span>
            <span>{Number(shot.durationS).toFixed(1)}s</span>
          </div>
          <SourceIcon size={13} className="text-text-dim" />
        </div>
        <p className="mt-1.5 text-[13px] font-narration leading-snug text-text line-clamp-3">
          {shot.narrationText}
        </p>
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            {(shot.fxRecommendation as { embers?: string })?.embers && (shot.fxRecommendation as { embers?: string }).embers !== 'off' && (
              <Badge tone="ember" className="lowercase">embers</Badge>
            )}
            {isFailed && (
              <Badge tone="bad">
                <Lock size={9} className="mr-0.5" />
                failed
              </Badge>
            )}
          </div>
          <MoreHorizontal size={14} className="text-text-faint opacity-0 group-hover:opacity-100" />
        </div>
      </div>
    </div>
  );
}
