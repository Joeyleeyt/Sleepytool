/**
 * Cancel orphaned 69labs jobs that are stuck holding a concurrency slot.
 *
 * A job orphans when a worker dies mid-poll (e.g. the `--watch` dev restart):
 * the job keeps running on 69labs and counts against the per-tier concurrent
 * limit, so eventually every new submit gets `403 Concurrent ... limit reached`.
 * Since the worker now persists `providerJobId` at submit time, we can find
 * those rows (status='running' past a threshold) and cancel them.
 *
 *   pnpm tsx scripts/reap-69labs-orphans.ts            # cancel jobs running >15m
 *   pnpm tsx scripts/reap-69labs-orphans.ts --minutes 5
 *   pnpm tsx scripts/reap-69labs-orphans.ts --dry-run  # list, don't cancel
 *
 * NOTE: jobs orphaned BEFORE this id-at-submit change have no recorded id and
 * can't be reaped here — clear those via 69labs support or wait for their
 * server-side expiry.
 */
import { readFile } from 'node:fs/promises';

async function loadDotEnv(path = '.env') {
  try {
    const txt = await readFile(path, 'utf8');
    for (const line of txt.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const key = t.slice(0, eq).trim();
      let value = t.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    /* .env missing is fine */
  }
}
await loadDotEnv();

// Imported after .env is loaded so DB/API clients see the env vars.
const { generationsRepo } = await import('@emberforge/db');
const { labs69 } = await import('@emberforge/ai-clients');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const mIdx = args.indexOf('--minutes');
const minutes = mIdx >= 0 ? Number(args[mIdx + 1]) : 15;
if (!Number.isFinite(minutes) || minutes < 0) {
  console.error('--minutes must be a non-negative number');
  process.exit(2);
}

// '69labs.image' -> 'images', '69labs.video' -> 'videos', '69labs.motion' -> 'motion-graphics'
function kindOf(provider: string): 'images' | 'videos' | 'motion-graphics' | null {
  if (provider.includes('image')) return 'images';
  if (provider.includes('video')) return 'videos';
  if (provider.includes('motion')) return 'motion-graphics';
  return null;
}

const before = new Date(Date.now() - minutes * 60_000);
const stale = await generationsRepo.findStaleRunning(before);
console.log(`Found ${stale.length} job(s) running longer than ${minutes}m.`);

let cancelled = 0;
for (const g of stale) {
  const kind = kindOf(g.provider);
  if (!kind || !g.providerJobId) continue;
  const label = `${g.provider} job ${g.providerJobId} (gen ${g.id}, started ${g.startedAt?.toISOString()})`;
  if (dryRun) {
    console.log(`  [dry-run] would cancel ${label}`);
    continue;
  }
  await labs69.cancel(kind, g.providerJobId);
  await generationsRepo.markFailed(g.id, { message: `reaped: orphaned job cancelled after ${minutes}m` });
  console.log(`  cancelled ${label}`);
  cancelled++;
}

console.log(dryRun ? 'Dry run complete.' : `Cancelled ${cancelled} orphaned job(s).`);
process.exit(0);
