import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

export function formatRelative(date: Date | string | null | undefined): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export const STAGE_LABELS: Record<string, string> = {
  ingested: 'Draft',
  analyzed: 'Analyzed',
  segmented: 'Segmented',
  classified: 'Shot list ready',
  prompted: 'Prompts built',
  generating_assets: 'Generating assets',
  assets_ready: 'Assets ready',
  timeline_built: 'Timeline built',
  audio_mixed: 'Audio mixed',
  composited: 'Composited',
  encoded: 'Encoded',
  published: 'Done',
  failed: 'Failed',
};

export const TERMINAL_STATUSES = new Set(['published', 'failed']);
