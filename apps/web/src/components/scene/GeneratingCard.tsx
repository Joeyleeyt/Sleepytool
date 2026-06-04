import Link from 'next/link';
import { Sparkles, Loader2, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Reusable "project is generating" card. Mirrors the mockup — a violet
 * progress ring with a breathing glow, the in-progress caption, a live shot
 * counter, the project title, a "Generating" pill, and a "View progress"
 * link — but intentionally WITHOUT the phase-step row and the percentage
 * readout.
 *
 * Purely presentational: all numbers come from props (real data only). When
 * `ready`/`total` aren't known the ring falls back to an indeterminate spin
 * and the counter is hidden, so nothing is ever fabricated.
 */
export interface GeneratingCardProps {
  /** Headline shown under the ring (e.g. the project title). */
  title: string;
  /** Where "View progress" links to. */
  href: string;
  /** Completed unit count (e.g. ready shots). Omit if unknown. */
  ready?: number;
  /** Total unit count (e.g. total shots). Omit if unknown. */
  total?: number;
  /** Status pill text. */
  label?: string;
  /** Caption inside the ring. */
  caption?: string;
  className?: string;
}

// Ring geometry — kept here so the dash math stays in one place.
const VIEWBOX = 148;
const RADIUS = 62;
const STROKE = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function GeneratingCard({
  title,
  href,
  ready,
  total,
  label = 'Generating',
  caption = 'Creating scenes…',
  className,
}: GeneratingCardProps) {
  const hasCount = typeof ready === 'number' && typeof total === 'number' && total > 0;
  const progress = hasCount ? Math.min(1, Math.max(0, ready! / total!)) : 0;
  // Determinate: arc length = progress. Indeterminate: a fixed quarter arc
  // that spins (the whole <svg> gets `animate-spin`).
  const dashOffset = hasCount ? CIRCUMFERENCE * (1 - progress) : CIRCUMFERENCE * 0.75;

  return (
    <div className={cn('rounded-card border border-border bg-bg-elev overflow-hidden', className)}>
      {/* Ring area */}
      <div className="relative grid place-items-center aspect-[4/3] bg-bg-subtle overflow-hidden">
        {/* Breathing violet glow behind the ring. */}
        <div
          aria-hidden
          className="absolute inset-0 animate-pulse bg-[radial-gradient(circle_at_50%_45%,rgba(196,181,253,0.22),transparent_70%)]"
        />

        {/* AI chip */}
        <div className="absolute top-3 right-3 inline-flex items-center gap-1 rounded-full border border-border bg-bg-elev/80 px-2 h-6 text-[11px] text-text-dim backdrop-blur">
          <Sparkles size={12} className="text-busy" />
          AI
        </div>

        {/* Progress ring */}
        <div className="relative w-[148px] h-[148px] grid place-items-center">
          <svg
            viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
            className={cn('absolute inset-0 -rotate-90', !hasCount && 'animate-spin')}
            aria-hidden
          >
            <defs>
              <linearGradient id="generating-arc" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#7C3AED" />
                <stop offset="100%" stopColor="#C4B5FD" />
              </linearGradient>
            </defs>
            <circle
              cx={VIEWBOX / 2}
              cy={VIEWBOX / 2}
              r={RADIUS}
              fill="none"
              strokeWidth={STROKE}
              className="stroke-border"
            />
            <circle
              cx={VIEWBOX / 2}
              cy={VIEWBOX / 2}
              r={RADIUS}
              fill="none"
              strokeWidth={STROKE}
              strokeLinecap="round"
              stroke="url(#generating-arc)"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={dashOffset}
              className="transition-[stroke-dashoffset] duration-700 ease-out"
            />
          </svg>

          {/* Center: caption + live counter (no percentage). */}
          <div className="relative px-6 text-center">
            <div className="inline-flex items-center gap-1 text-[11px] font-medium text-busy">
              <Sparkles size={12} className="text-busy" />
              {caption}
            </div>
            {hasCount && (
              <div className="mt-1 text-lg font-semibold tabular-nums text-text">
                {ready} <span className="text-text-faint">/</span> {total}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="p-4">
        <p className="font-narration text-[15px] leading-snug text-text line-clamp-2">{title}</p>

        <div className="mt-3 flex items-center">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-busy/30 bg-busy/10 px-2.5 h-6 text-xs font-medium text-busy">
            <Loader2 size={12} className="animate-spin" />
            {label}
          </span>
        </div>

        <Link
          href={href}
          className={cn(
            'mt-4 w-full inline-flex items-center justify-center gap-2 rounded-md h-10',
            'border border-border bg-bg-subtle text-text text-sm font-medium transition-colors',
            'hover:bg-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-busy/60',
          )}
        >
          View progress
          <ExternalLink size={14} />
        </Link>
      </div>
    </div>
  );
}
