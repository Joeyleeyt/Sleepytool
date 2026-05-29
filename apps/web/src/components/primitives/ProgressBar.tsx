import { cn } from '@/lib/utils';

export function ProgressBar({
  value,
  tone = 'ember',
  className,
}: {
  value: number; // 0..1
  tone?: 'ember' | 'busy' | 'ok';
  className?: string;
}) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const fillClass =
    tone === 'ok' ? 'bg-ok' : tone === 'busy' ? 'bg-busy' : 'bg-ember-500';
  return (
    <div className={cn('h-1.5 w-full rounded-full bg-bg-elev overflow-hidden', className)}>
      <div className={cn('h-full transition-all duration-500 ease-out', fillClass)} style={{ width: `${pct}%` }} />
    </div>
  );
}
