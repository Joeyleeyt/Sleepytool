/**
 * Read-only: confirm the live system's behaviour for TWO long videos.
 *  - recent projects (status + timing)
 *  - renders table (durations + started/finished) → detect CONCURRENT renders
 *  - live Redis: render queue depth + lane assignments
 *   pnpm --filter @emberforge/db exec tsx inspect-two-videos.ts
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

const { db } = await import('./src/client.js');
const { projects, renders, projectEvents } = await import('./src/schema/index.js');
const { desc, inArray, and } = await import('drizzle-orm');

// --- Projects (most recent 12) ---------------------------------------------
const projRows = await db
  .select({
    id: projects.id,
    title: projects.title,
    status: projects.status,
    res: projects.targetRes,
    createdAt: projects.createdAt,
    updatedAt: projects.updatedAt,
  })
  .from(projects)
  .orderBy(desc(projects.updatedAt))
  .limit(12);

console.log(`\n=== RECENT PROJECTS (${projRows.length}) ===`);
for (const p of projRows) {
  console.log(
    `${p.id}  [${String(p.status).padEnd(12)}] ${p.res}  upd=${p.updatedAt?.toISOString?.() ?? p.updatedAt}  "${p.title?.slice(0, 40)}"`,
  );
}

// --- Renders (most recent 15) ----------------------------------------------
const rendRows = await db
  .select({
    id: renders.id,
    projectId: renders.projectId,
    status: renders.status,
    durationS: renders.durationS,
    startedAt: renders.startedAt,
    finishedAt: renders.finishedAt,
  })
  .from(renders)
  .orderBy(desc(renders.finishedAt))
  .limit(15);

console.log(`\n=== RECENT RENDERS (${rendRows.length}) ===`);
for (const r of rendRows) {
  const dur = r.durationS ? `${Math.round(Number(r.durationS))}s video` : '?';
  console.log(
    `${r.id}  proj=${r.projectId.slice(0, 8)}  [${String(r.status).padEnd(10)}]  ${dur.padEnd(12)}  fin=${r.finishedAt?.toISOString?.() ?? r.finishedAt}`,
  );
}

// --- TRUE render windows from events (renders table has no startedAt) -------
// Render window = first composite 'render_started' .. encode 'render_succeeded'.
const projIds = projRows.map((p) => p.id);
const evs = await db
  .select({ projectId: projectEvents.projectId, stage: projectEvents.stage, event: projectEvents.event, ts: projectEvents.ts })
  .from(projectEvents)
  .where(
    and(
      inArray(projectEvents.projectId, projIds),
      inArray(projectEvents.stage, ['composite', 'audio', 'encode']),
      inArray(projectEvents.event, ['render_started', 'render_succeeded']),
    ),
  );

const win = new Map<string, { start: number; end: number }>();
for (const e of evs) {
  const t = new Date(e.ts as unknown as string).getTime();
  const w = win.get(e.projectId) ?? { start: Infinity, end: -Infinity };
  if (e.event === 'render_started') w.start = Math.min(w.start, t);
  if (e.event === 'render_succeeded') w.end = Math.max(w.end, t);
  win.set(e.projectId, w);
}
const titleById = new Map(projRows.map((p) => [p.id, p.title]));
const durById = new Map(rendRows.map((r) => [r.projectId, r.durationS ? Math.round(Number(r.durationS)) : 0]));

const windows = [...win.entries()]
  .filter(([, w]) => Number.isFinite(w.start) && Number.isFinite(w.end))
  .map(([projectId, w]) => ({ projectId, start: w.start, end: w.end }))
  .sort((a, b) => a.start - b.start);

console.log(`\n=== TRUE RENDER WINDOWS (from events) ===`);
for (const w of windows) {
  const mins = Math.round((w.end - w.start) / 60000);
  const vid = durById.get(w.projectId) ?? 0;
  console.log(
    `proj=${w.projectId.slice(0, 8)}  render ${new Date(w.start).toISOString()} → ${new Date(w.end).toISOString()}  (${mins}min wall, ${vid}s video)  "${(titleById.get(w.projectId) ?? '').slice(0, 30)}"`,
  );
}

console.log(`\n=== CONCURRENT-RENDER CHECK (exact) ===`);
let overlaps = 0;
for (let i = 0; i < windows.length; i++) {
  for (let j = i + 1; j < windows.length; j++) {
    const a = windows[i]!;
    const b = windows[j]!;
    const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
    if (overlap > 0) {
      overlaps++;
      console.log(`OVERLAP: ${a.projectId.slice(0, 8)} & ${b.projectId.slice(0, 8)} ran together for ${Math.round(overlap / 60000)}min`);
    }
  }
}
if (!overlaps) console.log('NO two render windows overlapped — concurrent rendering has NEVER actually happened in prod.');

// --- Live Redis: render queue depth + lanes --------------------------------
const url = process.env.REDIS_URL ?? process.env.REDIS;
if (url) {
  const { createRequire } = await import('node:module');
  const req = createRequire(join(parse(dirname(fileURLToPath(import.meta.url))).root, 'D:/Work/Joey/AI VIDEO/packages/queue/package.json'));
  const IORedis = req('ioredis').default ?? req('ioredis');
  const r = new IORedis(url, { maxRetriesPerRequest: null, lazyConnect: true });
  await r.connect();
  console.log(`\n=== LIVE REDIS ===`);
  for (const state of ['wait', 'active', 'delayed', 'completed', 'failed'] as const) {
    const key = `bull:render:${state}`;
    const type = await r.type(key);
    const n = type === 'list' ? await r.llen(key) : type === 'zset' ? await r.zcard(key) : type === 'set' ? await r.scard(key) : 0;
    console.log(`  render.${state.padEnd(10)} = ${n}`);
  }
  const now = Date.now();
  for (const lane of [1, 2, 3]) {
    const k = `lane:${lane}:active`;
    const exists = await r.exists(k);
    if (!exists) continue;
    const members = await r.zrangebyscore(k, now, '+inf');
    console.log(`  lane:${lane}:active (unexpired) = ${members.length}  [${members.map((m) => m.slice(0, 8)).join(', ')}]`);
  }
  const leader = await r.get('render-autoscaler:leader');
  console.log(`  render-autoscaler:leader = ${leader ?? '(none)'}`);
  await r.quit();
} else {
  console.log('\n(no REDIS_URL in env — skipping live queue check)');
}

process.exit(0);
