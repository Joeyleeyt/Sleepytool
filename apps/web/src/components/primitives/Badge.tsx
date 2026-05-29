import { type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'busy' | 'ember';

const TONES: Record<Tone, string> = {
  neutral: 'bg-bg-elev text-text-dim border-border',
  ok: 'bg-ok/15 text-ok border-ok/30',
  warn: 'bg-warn/15 text-warn border-warn/30',
  bad: 'bg-bad/15 text-bad border-bad/30',
  busy: 'bg-busy/15 text-busy border-busy/30',
  ember: 'bg-ember-500/15 text-ember-400 border-ember-500/30',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
}

export function Badge({ tone = 'neutral', className, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center h-5 px-1.5 rounded text-[11px] font-medium border tabular-nums',
        TONES[tone],
        className,
      )}
      {...rest}
    />
  );
}
