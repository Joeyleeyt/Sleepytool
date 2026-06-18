/**
 * Poll the live queues and exit 0 the moment all 69labs/veo3 asset-generation
 * work has drained (no provider jobs in flight) — i.e. the `workers` machine is
 * safe to redeploy without interrupting a generation. Exit 2 on a 3h timeout.
 *
 * "Busy" = wait + active + delayed across every asset queue (all lanes). We
 * deliberately do NOT gate on the orchestrator queue: the stuck zombie
 * generateAssets job sits there 'active' forever and would never drain.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, parse } from 'node:path';
import { createRequire } from 'node:module';

let dir = dirname(fileURLToPath(import.meta.url));
const root = parse(dir).root;
let envPath = '.env';
while (dir !== root) { const c = join(dir, '.env'); if (existsSync(c)) { envPath = c; break; } dir = dirname(dir); }
try {
  const txt = await readFile(envPath, 'utf8');
  for (const line of txt.split('\n')) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('='); if (eq < 0) continue;
    const k = t.slice(0, eq).trim(); let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
} catch {}

const { appendFileSync } = await import('node:fs');
const LOG = 'D:/tmp/asset-watch.log';
function out(line: string): void {
  console.log(line);
  try { appendFileSync(LOG, line + '\n'); } catch {}
}

const req = createRequire('D:/Work/Joey/AI VIDEO/packages/queue/package.json');
const IORedis = req('ioredis').default ?? req('ioredis');
const r = new IORedis(process.env.REDIS_URL ?? process.env.REDIS, { maxRetriesPerRequest: null, lazyConnect: true });
// Swallow transient connection errors (ECONNRESET on the TLS upstash link) so a
// blip can't crash the long-running watcher; ioredis auto-reconnects.
r.on('error', (e: Error) => out(`[redis] ${e.message} (reconnecting)`));
await r.connect();

const ASSET_QUEUES = ['labsImage', 'labsImage2', 'labsVideo', 'labsVideo2', 'tts', 'tts2', 'veo3', 'veo32'];
async function depth(q: string, state: string): Promise<number> {
  const key = `bull:${q}:${state}`;
  const type = await r.type(key);
  if (type === 'list') return r.llen(key);
  if (type === 'zset') return r.zcard(key);
  if (type === 'set') return r.scard(key);
  return 0;
}
function stamp(): string { const d = new Date(Number(process.env.__T ?? 0) || undefined); return d.toISOString().slice(11, 19); }

const POLL_MS = 60_000;
const MAX_POLLS = 180; // ~3h
let clearStreak = 0;
for (let i = 0; i < MAX_POLLS; i++) {
  let busy = 0;
  const per: string[] = [];
  try {
    for (const q of ASSET_QUEUES) {
      const [w, a, d] = await Promise.all([depth(q, 'wait'), depth(q, 'active'), depth(q, 'delayed')]);
      const n = w + a + d;
      busy += n;
      if (n > 0) per.push(`${q}=${w}/${a}/${d}`);
    }
  } catch (e) {
    out(`poll ${i}: redis error ${(e as Error).message} — retrying`);
    await new Promise((res) => setTimeout(res, POLL_MS));
    continue;
  }
  out(`poll ${i}: asset jobs in flight (wait/active/delayed) total=${busy}  ${per.join('  ') || '(all clear)'}`);
  if (busy === 0) {
    clearStreak++;
    // Require two consecutive clear polls so a brief lull between a retry's
    // delayed→active transition isn't mistaken for completion.
    if (clearStreak >= 2) {
      out('ASSET_GENERATION_DONE — all asset queues drained. Safe to deploy the workers process group.');
      await r.quit();
      process.exit(0);
    }
  } else {
    clearStreak = 0;
  }
  await new Promise((res) => setTimeout(res, POLL_MS));
}
out('TIMEOUT — still busy after ~3h; not declaring done.');
await r.quit();
process.exit(2);
