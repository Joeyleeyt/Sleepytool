/**
 * Print recent failed/stuck generations with their error reason, provider and
 * shot, so we can see WHY some shot assets didn't generate.
 *
 *   pnpm --filter @emberforge/orchestrator exec tsx apps/orchestrator/inspect-failed-generations.ts
 *   ... --hours 6
 *   ... --project <projectId>
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, parse } from 'node:path';

function findDotEnv(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  const root = parse(dir).root;
  while (dir !== root) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
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

const { generationsRepo } = await import('@emberforge/db');

const args = process.argv.slice(2);
const hIdx = args.indexOf('--hours');
const hours = hIdx >= 0 ? Number(args[hIdx + 1]) : 24;
const pIdx = args.indexOf('--project');
const projectId = pIdx >= 0 ? args[pIdx + 1] : undefined;

const rows = await generationsRepo.findRecentUnsuccessful({ sinceMs: hours * 60 * 60_000, projectId });

if (rows.length === 0) {
  console.log(`No failed/stuck generations in the last ${hours}h${projectId ? ` for project ${projectId}` : ''}.`);
  process.exit(0);
}

console.log(`Found ${rows.length} non-succeeded generation(s) in the last ${hours}h:\n`);
for (const r of rows) {
  const err = r.error ? JSON.stringify(r.error) : '(no error recorded)';
  console.log(`• shot=${r.shotId} [${r.visualType}]`);
  console.log(`  provider=${r.provider}  status=${r.status}  jobId=${r.providerJobId ?? '-'}`);
  console.log(`  project=${r.projectId}  gen=${r.genId}`);
  console.log(`  startedAt=${r.startedAt?.toISOString() ?? '-'}  finishedAt=${r.finishedAt?.toISOString() ?? '-'}`);
  console.log(`  error: ${err}\n`);
}
process.exit(0);
