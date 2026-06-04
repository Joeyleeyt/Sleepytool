/**
 * Stop an in-progress asset generation for a project: remove its queued jobs,
 * cancel its in-flight 69labs jobs (so they release provider slots), and reset
 * the project status so it isn't wedged in `generating_assets`.
 *
 *   pnpm --filter @emberforge/orchestrator exec tsx apps/orchestrator/stop-generation.ts <projectId>
 *   ... <projectId> --no-reset      # leave project status as-is
 *   ... --all                       # every project (obliterate the gen queues)
 *
 * RECOMMENDED: stop the workers first (Ctrl+C on `workers:dev`) so active jobs
 * aren't locked — this script can't remove a job a running worker holds. The
 * worker's SIGINT handler also cancels in-flight 69labs jobs on the way out.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, parse } from 'node:path';

function findDotEnv(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  const root = parse(dir).root;
  while (dir !== root) {
    const c = join(dir, '.env');
    if (existsSync(c)) return c;
    dir = dirname(dir);
  }
  return '.env';
}
async function loadDotEnv(path = findDotEnv()) {
  try {
    const txt = await readFile(path, 'utf8');
    for (const line of txt.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const key = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(key in process.env)) process.env[key] = v;
    }
  } catch {}
}
await loadDotEnv();

const { Queue } = await import('bullmq');
const { getConnection } = await import('@emberforge/queue');
const { generationsRepo, projectsRepo } = await import('@emberforge/db');
const { labs69 } = await import('@emberforge/ai-clients');

const args = process.argv.slice(2);
const all = args.includes('--all');
const noReset = args.includes('--no-reset');
const projectId = args.find((a) => !a.startsWith('--'));

if (!all && !projectId) {
  console.error('Usage: stop-generation.ts <projectId> [--no-reset] | --all');
  process.exit(2);
}

const GEN_QUEUES = ['veo3', 'labsImage', 'labsVideo', 'tts'];
const ALL_QUEUES = [...GEN_QUEUES, 'orchestrator'];
const conn = getConnection();

// Job states that still represent pending/running work (everything but
// completed/failed, which are just history).
const ACTIVE_STATES = ['waiting', 'delayed', 'prioritized', 'waiting-children', 'active', 'paused'] as const;

let removed = 0;
let lockedSkipped = 0;
for (const name of ALL_QUEUES) {
  const q = new Queue(name, { connection: conn });
  const jobs = await q.getJobs(ACTIVE_STATES as unknown as string[]);
  for (const job of jobs) {
    const pid = (job.data as { projectId?: string })?.projectId;
    if (!all && pid !== projectId) continue;
    try {
      await job.remove();
      removed++;
    } catch {
      // Active jobs held by a running worker can't be removed — they'll fail
      // out once their provider job is cancelled below / the worker stops.
      lockedSkipped++;
    }
  }
  await q.close();
}
console.log(`Removed ${removed} queued job(s)${lockedSkipped ? `, skipped ${lockedSkipped} locked/active` : ''}.`);

// Cancel in-flight 69labs jobs so they free their provider concurrency slots.
const stale = await generationsRepo.findStaleRunning(new Date()); // before=now → all 'running'
let cancelled = 0;
for (const g of stale) {
  const kind = g.provider.includes('image') ? 'images' : g.provider.includes('video') ? 'videos' : null;
  if (!kind || !g.providerJobId) continue;
  await labs69.cancel(kind, g.providerJobId);
  await generationsRepo.markFailed(g.id, { message: 'generation stopped by operator' });
  cancelled++;
}
console.log(`Cancelled ${cancelled} in-flight 69labs job(s).`);

// Reset status so the project isn't stuck in generating_assets. 'prompted' is
// the gate right before generate, so the user can re-trigger cleanly.
if (projectId && !noReset) {
  await projectsRepo.setStatus(projectId, 'prompted');
  console.log(`Reset project ${projectId} → status 'prompted' (re-run "Generate assets" when ready).`);
}

process.exit(0);
