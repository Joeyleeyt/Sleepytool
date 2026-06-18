/** READ-ONLY probe of the per-shot resend path. No mutations, no enqueues.
 *  Reproduces every READ the retry route performs + a Redis PING + a dry queue
 *  read, to isolate which step throws the 500. */
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

const step = async <T>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
  try {
    const r = await fn();
    console.log(`OK   ${label}: ${(JSON.stringify(r) ?? 'undefined').slice(0, 400)}`);
    return r;
  } catch (e) {
    console.log(`FAIL ${label}: ${(e as Error).name}: ${(e as Error).message}`);
    return undefined;
  }
};

const { shotsRepo, promptsRepo, projectsRepo, generationsRepo } = (await import('@emberforge/db')) as any;
const { getConnection } = (await import('@emberforge/queue')) as any;

// 1) Redis connectivity — the retry route enqueues here; prime 500 suspect.
await step('redis.ping', async () => {
  const conn = getConnection();
  return await conn.ping();
});

// 2) Find a failed shot across the dev owner's projects.
const owner = process.env.DEV_OWNER_ID ?? '';
const projects: any[] = (await step('projectsRepo.listByOwner', () =>
  projectsRepo.listByOwner(owner, { limit: 50 }),
)) ?? [];

let shotId: string | undefined;
for (const p of projects) {
  const failed: any[] = (await generationsRepo.findFailedByProject(p.id).catch(() => [])) ?? [];
  if (failed.length) {
    shotId = failed[0].shotId;
    console.log(`\nfound failed gen in project ${p.id}: shot=${shotId} provider=${failed[0].provider} err=${JSON.stringify(failed[0].error)?.slice(0,200)}`);
    break;
  }
}
if (!shotId) {
  console.log('\nno failed shot found in dev owner projects — exercising reads on first shot instead');
  for (const p of projects) {
    const shots = await shotsRepo.findByProject(p.id).catch(() => []);
    if (shots?.length) { shotId = shots[0].id; break; }
  }
}
if (!shotId) { console.log('no shots at all'); process.exit(0); }

console.log(`\n--- retry-route reads for shotId=${shotId} ---`);
await step('shotsRepo.findById', () => shotsRepo.findById(shotId));
await step('promptsRepo.findLatestVisualForShot', () => promptsRepo.findLatestVisualForShot(shotId));

// 3) Dry queue read (no .add) — confirms BullMQ Queue works against this Redis.
await step('queue getJobCounts(labsVideo)', async () => {
  const { Queue } = await import('bullmq');
  const q = new Queue('labsVideo', { connection: getConnection() });
  const counts = await q.getJobCounts('waiting', 'active', 'failed');
  await q.close();
  return counts;
});

process.exit(0);
