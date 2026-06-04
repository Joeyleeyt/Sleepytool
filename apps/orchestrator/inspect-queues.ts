/** Show BullMQ job counts per queue, so we can see if retry jobs are enqueued
 *  but never consumed (waiting piling up = no worker) vs not enqueued at all. */
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

const names = ['veo3', 'labsImage', 'labsVideo', 'tts', 'orchestrator', 'render'];
const conn = getConnection();
for (const name of names) {
  const q = new Queue(name, { connection: conn });
  const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed', 'paused');
  const paused = await q.isPaused();
  console.log(`${name.padEnd(13)} ${JSON.stringify(counts)}  paused=${paused}`);
  // Show the most recent waiting/failed job ids so we can correlate with a retry click.
  const waiting = await q.getJobs(['waiting'], 0, 4);
  if (waiting.length) {
    for (const j of waiting) console.log(`   waiting: id=${j.id} name=${j.name} data=${JSON.stringify(j.data)}`);
  }
  await q.close();
}
process.exit(0);
