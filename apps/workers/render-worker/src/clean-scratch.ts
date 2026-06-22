/**
 * Reusable render-scratch cleanup CLI. Works on any project, now or later, and
 * is the thing to run over `fly ssh` when the render volume is filling up. The
 * actual logic lives in @emberforge/render (`cleanup.ts`) so the worker can call
 * the same functions inline; this is just the command-line front door.
 *
 *   # See what's eating the disk (largest project trees first), no deletes:
 *   pnpm --filter @emberforge/render-worker clean-scratch usage
 *
 *   # Drop regenerable per-clip / batch intermediates (keeps master+mix+final):
 *   pnpm --filter @emberforge/render-worker clean-scratch intermediates            # all projects
 *   pnpm --filter @emberforge/render-worker clean-scratch intermediates <projectId>
 *
 *   # Remove a whole project tree once it's delivered to R2:
 *   pnpm --filter @emberforge/render-worker clean-scratch project <projectId>
 *   pnpm --filter @emberforge/render-worker clean-scratch project <projectId> --keep-final
 *
 *   # Sweep every project tree (optionally only old ones / keeping one in-flight):
 *   pnpm --filter @emberforge/render-worker clean-scratch prune
 *   pnpm --filter @emberforge/render-worker clean-scratch prune --older-than 7d --keep <projectId>
 *
 * Add --dry-run to any command to MEASURE what would be freed without deleting.
 * Override the scratch root with RENDER_WORK_DIR (defaults to the worker's value).
 *
 * Over fly:
 *   fly ssh console -a sleepytool -C "pnpm --filter @emberforge/render-worker clean-scratch usage"
 */
import {
  cleanupProject,
  cleanupProjectIntermediates,
  defaultWorkDir,
  humanBytes,
  pruneScratch,
  workDirUsage,
  type CleanupResult,
} from '@emberforge/render';

const argv = process.argv.slice(2);
const cmd = argv[0];

function hasFlag(name: string): boolean {
  return argv.includes(`--${name}`);
}
function flagValue(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
/** First non-flag arg after the command (e.g. the projectId). */
function positional(): string | undefined {
  return argv.slice(1).find((a) => !a.startsWith('--'));
}

/** Parse a duration like "7d", "12h", "30m" (or a bare number = ms) into ms. */
function parseDuration(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(s.trim());
  if (!m) throw new Error(`bad --older-than value: ${s} (try 7d, 12h, 30m)`);
  const n = Number(m[1]);
  const unit = m[2] ?? 'ms';
  const mult = { ms: 1, s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[unit]!;
  return n * mult;
}

const dryRun = hasFlag('dry-run');
const workDir = defaultWorkDir();

function report(label: string, r: CleanupResult): void {
  const verb = r.dryRun ? 'would free' : 'freed';
  console.log(`${label}: ${verb} ${humanBytes(r.freedBytes)} across ${r.removed.length} path(s)`);
  for (const p of r.removed) console.log(`  ${r.dryRun ? '·' : '✓'} ${p}`);
}

function usageAndExit(): never {
  console.error(
    'usage: clean-scratch <usage|intermediates|project|prune> [projectId] [flags]\n' +
      '  flags: --dry-run  --keep-final  --older-than <7d|12h|30m>  --keep <projectId>',
  );
  process.exit(1);
}

console.log(`workDir: ${workDir}${dryRun ? '  (dry-run)' : ''}\n`);

switch (cmd) {
  case 'usage': {
    const usage = await workDirUsage(workDir);
    if (!usage.length) {
      console.log('(no project trees found)');
      break;
    }
    let total = 0;
    for (const u of usage) {
      total += u.bytes;
      const age = u.mtimeMs ? `${Math.round((Date.now() - u.mtimeMs) / 86400e3)}d` : '?';
      console.log(`  ${humanBytes(u.bytes).padStart(10)}  ${u.projectId}  (modified ${age} ago)`);
    }
    console.log(`\n  ${humanBytes(total).padStart(10)}  TOTAL across ${usage.length} project(s)`);
    break;
  }

  case 'intermediates': {
    const projectId = positional();
    if (projectId) {
      report(`intermediates ${projectId}`, await cleanupProjectIntermediates(workDir, projectId, { dryRun }));
    } else {
      // All projects.
      const usage = await workDirUsage(workDir);
      const agg: CleanupResult = { removed: [], freedBytes: 0, dryRun };
      for (const u of usage) {
        const r = await cleanupProjectIntermediates(workDir, u.projectId, { dryRun });
        agg.removed.push(...r.removed);
        agg.freedBytes += r.freedBytes;
      }
      report('intermediates (all projects)', agg);
    }
    break;
  }

  case 'project': {
    const projectId = positional();
    if (!projectId) usageAndExit();
    report(
      `project ${projectId}`,
      await cleanupProject(workDir, projectId, { dryRun, keepDeliverable: hasFlag('keep-final') }),
    );
    break;
  }

  case 'prune': {
    const olderThanMs = parseDuration(flagValue('older-than'));
    const keep = flagValue('keep');
    report(
      'prune',
      await pruneScratch(workDir, {
        dryRun,
        olderThanMs,
        keepDeliverable: hasFlag('keep-final'),
        keepProjectIds: keep ? [keep] : [],
      }),
    );
    break;
  }

  default:
    usageAndExit();
}

process.exit(0);
