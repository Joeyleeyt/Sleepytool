/**
 * Print the current video/visual prompt for a single shot, with length stats,
 * so we can see whether an over-long/heavy prompt is making 69labs' upstream
 * provider time out.
 *
 *   pnpm --filter @emberforge/orchestrator exec tsx apps/orchestrator/inspect-shot-prompt.ts <shotId>
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

const shotId = process.argv[2];
if (!shotId) {
  console.error('usage: inspect-shot-prompt.ts <shotId>');
  process.exit(1);
}

const { promptsRepo, shotsRepo } = await import('@emberforge/db');

const shot = await shotsRepo.findById(shotId);
console.log('=== SHOT ===');
console.log(`id=${shotId}`);
console.log(`durationS=${shot?.durationS ?? '-'}  visualType=${(shot as Record<string, unknown> | null)?.visualType ?? '-'}`);
console.log('');

for (const target of ['69labs.video', '69labs.image', 'veo3']) {
  const p = await promptsRepo.findForShot(shotId, target);
  if (!p) continue;
  const text = p.promptText ?? '';
  console.log(`=== PROMPT target=${target} ===`);
  console.log(`promptId=${p.id}  createdAt=${p.createdAt?.toISOString?.() ?? p.createdAt}`);
  console.log(`chars=${text.length}  words=${text.trim().split(/\s+/).filter(Boolean).length}`);
  console.log(`negative=${p.negative ?? '(none)'}`);
  console.log(`params=${p.params ? JSON.stringify(p.params) : '(none)'}`);
  console.log('--- promptText ---');
  console.log(text);
  console.log('');
}
process.exit(0);
