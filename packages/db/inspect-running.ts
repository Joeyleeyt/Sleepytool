/**
 * Read-only: list ALL currently-running generations joined to shot + project,
 * so we know the blast radius before cancelling anything.
 *   pnpm --filter @emberforge/db exec tsx inspect-running.ts
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
const { generations, prompts, shots } = await import('./src/schema/index.js');
const { eq, and, isNotNull } = await import('drizzle-orm');

const rows = await db
  .select({
    genId: generations.id,
    provider: generations.provider,
    providerJobId: generations.providerJobId,
    startedAt: generations.startedAt,
    shotId: prompts.shotId,
    projectId: shots.projectId,
  })
  .from(generations)
  .innerJoin(prompts, eq(generations.promptId, prompts.id))
  .innerJoin(shots, eq(prompts.shotId, shots.id))
  .where(and(eq(generations.status, 'running' as never), isNotNull(generations.providerJobId)));

console.log(`Running generations: ${rows.length}\n`);
for (const r of rows) {
  console.log(`gen=${r.genId} provider=${r.provider} job=${r.providerJobId}`);
  console.log(`  shot=${r.shotId}  project=${r.projectId}  startedAt=${r.startedAt?.toISOString?.() ?? r.startedAt}`);
}
const byProject = new Map<string, number>();
for (const r of rows) byProject.set(r.projectId, (byProject.get(r.projectId) ?? 0) + 1);
console.log('\nby project:');
for (const [pid, n] of byProject) console.log(`  ${pid}: ${n}`);
process.exit(0);
