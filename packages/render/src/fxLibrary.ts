import { existsSync } from 'node:fs';
import path from 'node:path';

const FX_DIR = process.env.FX_LIBRARY_DIR ?? path.resolve(process.cwd(), 'fx-cache');

export function fxPath(rel: string): string {
  return path.join(FX_DIR, rel);
}

/** Returns true if the FX file exists on disk. Used to gracefully skip overlays
 *  in safe-mode when the FX library hasn't been seeded yet. */
export function fxExists(rel: string): boolean {
  return existsSync(fxPath(rel));
}

export const FX = {
  embers: {
    subtle: 'embers/embers_subtle_4k_30s_alpha.mov',
    medium: 'embers/embers_medium_4k_30s_alpha.mov',
    heavy: 'embers/embers_heavy_4k_30s_alpha.mov',
  },
  smoke: {
    low: 'smoke/smoke_low.mov',
    high: 'smoke/smoke_high.mov',
  },
  grain: {
    standard: 'grain/grain_35mm_4k_60s.mov',
  },
} as const;

export type EmberLevel = 'off' | 'subtle' | 'medium' | 'heavy';
export type SmokeLevel = 'off' | 'low' | 'high';

export function embersAlpha(level: EmberLevel): number {
  return { off: 0, subtle: 0.15, medium: 0.35, heavy: 0.6 }[level];
}

export function smokeAlpha(level: SmokeLevel): number {
  return { off: 0, low: 0.12, high: 0.28 }[level];
}
