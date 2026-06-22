import os from 'node:os';
import path from 'node:path';
import { readdir, rm, stat } from 'node:fs/promises';

/**
 * Reusable scratch-cleanup for the render work dir.
 *
 * Every R2 key is prefixed with `<projectId>/` (see storage `r2Paths`), so the
 * render worker downloads sources to `WORK_DIR/<projectId>/...` and writes all of
 * its scratch (per-clip intermediates, batch masters, the composited master, the
 * audio mix, the final mp4) under that same `WORK_DIR/<projectId>/` tree. A
 * "project dir" here is therefore one top-level entry under WORK_DIR named by
 * project id, and cleaning up is just pruning those trees.
 *
 * Three tiers, cheapest-and-safest first:
 *   - {@link cleanupProjectIntermediates} — drop the regenerable per-clip / batch
 *     scratch the instant the master exists (keeps resume checkpoints).
 *   - {@link cleanupProject} — drop a whole project tree once its render is
 *     delivered to R2 (optionally keeping the final mp4).
 *   - {@link pruneScratch} — sweep every project tree (optionally only those
 *     older than N ms, optionally keeping an in-flight project).
 *
 * Pure node (fs + path + os) on purpose: no DB / queue / ffmpeg deps, so it runs
 * fast over `fly ssh` and can be imported by the worker without pulling weight.
 */

/** Default scratch root — matches the render worker's RENDER_WORK_DIR. */
export function defaultWorkDir(): string {
  return process.env.RENDER_WORK_DIR ?? path.join(os.tmpdir(), 'emberforge');
}

/**
 * Subdirectories under a project tree that are pure REGENERABLE scratch: the
 * per-clip / batch intermediates (`sleep`, with its `fxcache`, `batch_*`,
 * `clip_*`, `fxbatch_*`), the legacy mixer's `freezes`, and `sleep_segments`
 * (buildSleepMaster's default work dir when called without an explicit one).
 * Deleting these the moment `composited_master.mp4` exists is safe — the next
 * render rebuilds them. Deliberately EXCLUDES the resume checkpoints and the
 * deliverable (see {@link RESUME_FILES}, {@link DELIVERABLE_FILE}).
 */
export const INTERMEDIATE_DIR_NAMES: readonly string[] = ['sleep', 'sleep_segments', 'freezes'];

/** The composited video master + audio mix kept ONLY so a late-stage failure
 *  (e.g. the final encode) can resume in seconds instead of re-rendering hours. */
export const RESUME_FILES: readonly string[] = ['composited_master.mp4', 'mixed.wav'];

/** The local copy of the final render. Already uploaded to R2 by the time a
 *  project is eligible for whole-tree cleanup, so safe to drop. */
export const DELIVERABLE_FILE = 'final.mp4';

export interface CleanupResult {
  /** Absolute paths that were removed (or would be, when dryRun). */
  removed: string[];
  /** Total bytes reclaimed (measured before deletion). */
  freedBytes: number;
  /** True when nothing was actually deleted — the call only measured. */
  dryRun: boolean;
}

export interface CleanupOpts {
  /** Measure + report what would be freed without deleting anything. */
  dryRun?: boolean;
}

const EMPTY: CleanupResult = { removed: [], freedBytes: 0, dryRun: false };

/** Human-readable byte count (e.g. "12.4 GB"). */
export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

async function statSafe(p: string): Promise<import('node:fs').Stats | null> {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

/** Recursive byte size of a file or directory; 0 if it doesn't exist. */
async function pathSize(p: string): Promise<number> {
  const st = await statSafe(p);
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(p, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) total += await pathSize(path.join(p, e.name));
  return total;
}

/** Measure each path, then delete it (unless dryRun). Missing paths are skipped. */
async function removeAll(paths: string[], dryRun: boolean): Promise<CleanupResult> {
  const result: CleanupResult = { removed: [], freedBytes: 0, dryRun };
  for (const p of paths) {
    const size = await pathSize(p);
    if (size === 0 && !(await statSafe(p))) continue; // nothing there
    result.freedBytes += size;
    result.removed.push(p);
    if (!dryRun) await rm(p, { recursive: true, force: true });
  }
  return result;
}

function projectDir(workDir: string, projectId: string): string {
  return path.join(workDir, projectId);
}

/**
 * Drop the regenerable per-clip / batch intermediates for one project, keeping
 * the resume checkpoints (master + mix) and the deliverable. This is the change
 * that lowers PEAK disk during a single big render — call it as soon as the
 * master has been written.
 */
export async function cleanupProjectIntermediates(
  workDir: string,
  projectId: string,
  opts: CleanupOpts = {},
): Promise<CleanupResult> {
  const base = projectDir(workDir, projectId);
  const targets = INTERMEDIATE_DIR_NAMES.map((d) => path.join(base, d));
  return removeAll(targets, opts.dryRun ?? false);
}

export interface CleanupProjectOpts extends CleanupOpts {
  /** Keep the local final.mp4 (everything else in the tree is removed). */
  keepDeliverable?: boolean;
}

/**
 * Remove a whole project tree (downloaded sources + all scratch + checkpoints).
 * Safe once the final render is uploaded to R2 — every input is re-downloadable
 * and every output re-derivable. With `keepDeliverable`, the local final.mp4 is
 * preserved and everything else under the tree is removed.
 */
export async function cleanupProject(
  workDir: string,
  projectId: string,
  opts: CleanupProjectOpts = {},
): Promise<CleanupResult> {
  const base = projectDir(workDir, projectId);
  if (!(await statSafe(base))) return { ...EMPTY, dryRun: opts.dryRun ?? false };

  if (!opts.keepDeliverable) {
    return removeAll([base], opts.dryRun ?? false);
  }

  // Keep final.mp4: remove every top-level entry except it.
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return { ...EMPTY, dryRun: opts.dryRun ?? false };
  }
  const targets = entries
    .filter((e) => e.name !== DELIVERABLE_FILE)
    .map((e) => path.join(base, e.name));
  return removeAll(targets, opts.dryRun ?? false);
}

/** One top-level project tree under the work dir, with its size and mtime. */
export interface ProjectUsage {
  projectId: string;
  path: string;
  bytes: number;
  /** Last-modified time (ms epoch) of the tree's top dir — a cheap "age" proxy. */
  mtimeMs: number;
}

/**
 * List every project tree under the work dir, largest first. Handy for a "what's
 * eating the disk" report before deciding what to prune.
 */
export async function workDirUsage(workDir: string): Promise<ProjectUsage[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(workDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = entries.filter((e) => e.isDirectory());
  const usage = await Promise.all(
    dirs.map(async (e) => {
      const p = path.join(workDir, e.name);
      const st = await statSafe(p);
      return { projectId: e.name, path: p, bytes: await pathSize(p), mtimeMs: st?.mtimeMs ?? 0 };
    }),
  );
  return usage.sort((a, b) => b.bytes - a.bytes);
}

export interface PruneOpts extends CleanupProjectOpts {
  /** Only prune trees whose top dir hasn't been modified within this many ms. */
  olderThanMs?: number;
  /** Project ids to leave untouched (e.g. the currently-rendering project). */
  keepProjectIds?: Iterable<string>;
  /** Clock reference (ms epoch) for the age test. Defaults to Date.now(). Pass
   *  explicitly from callers that must stay deterministic. */
  now?: number;
}

/**
 * Sweep every project tree under the work dir, removing those that are eligible.
 * Eligibility = not in `keepProjectIds` and (if `olderThanMs` is set) older than
 * that. Aggregates one {@link CleanupResult} across all removed trees.
 */
export async function pruneScratch(workDir: string, opts: PruneOpts = {}): Promise<CleanupResult> {
  const keep = new Set(opts.keepProjectIds ?? []);
  const now = opts.now ?? Date.now();
  const usage = await workDirUsage(workDir);

  const result: CleanupResult = { removed: [], freedBytes: 0, dryRun: opts.dryRun ?? false };
  for (const u of usage) {
    if (keep.has(u.projectId)) continue;
    if (opts.olderThanMs != null && now - u.mtimeMs < opts.olderThanMs) continue;
    const r = await cleanupProject(workDir, u.projectId, {
      dryRun: opts.dryRun,
      keepDeliverable: opts.keepDeliverable,
    });
    result.removed.push(...r.removed);
    result.freedBytes += r.freedBytes;
  }
  return result;
}
