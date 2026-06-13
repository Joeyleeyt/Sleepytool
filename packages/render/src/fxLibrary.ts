import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Two places an FX asset can live, checked in priority order:
//   1. FX_LIBRARY_DIR (or ./fx-cache) — a machine-local / mounted library, used
//      to override or add higher-res plates without touching the repo.
//   2. the assets bundled INSIDE this package (packages/render/assets) — these
//      are committed and ship in the Docker image, so the global overlay works
//      out of the box on any machine with no env config or seeding required.
const ENV_DIR = process.env.FX_LIBRARY_DIR ?? path.resolve(process.cwd(), 'fx-cache');
const BUNDLED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets');

/** First location (env library, then bundled assets) that actually holds `rel`,
 *  or null if neither does. */
function resolveFx(rel: string): string | null {
  for (const dir of [ENV_DIR, BUNDLED_DIR]) {
    const p = path.join(dir, rel);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Absolute path to an FX asset — the env library copy if present, else the
 *  bundled copy, else the env-library path (so error messages point at the
 *  expected location even when nothing exists). */
export function fxPath(rel: string): string {
  return resolveFx(rel) ?? path.join(ENV_DIR, rel);
}

/** True if the FX asset exists in either the env library or the bundled assets.
 *  Used to gracefully fall back (e.g. to synthetic particles) when a plate is
 *  missing. */
export function fxExists(rel: string): boolean {
  return resolveFx(rel) !== null;
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
