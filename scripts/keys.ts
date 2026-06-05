/**
 * Manage 69labs API keys — add, list, disable, enable, remove. Keys live in the
 * api_keys table (encrypted); workers pick from them and rotate on failure, so
 * adding/removing a key takes effect on the next job with NO redeploy.
 *
 *   pnpm tsx scripts/keys.ts add vk_xxxxxxxx --label main
 *   pnpm tsx scripts/keys.ts list
 *   pnpm tsx scripts/keys.ts disable <id>
 *   pnpm tsx scripts/keys.ts enable  <id>
 *   pnpm tsx scripts/keys.ts rm      <id>
 *
 * Requires DATABASE_URL and API_KEY_ENCRYPTION_SECRET in .env.
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
    /* .env missing is fine; we error below if vars aren't set */
  }
}
await loadDotEnv();

// Imported AFTER env is loaded so the lazy db client sees DATABASE_URL.
const { apiKeysRepo } = await import('@emberforge/db');

/** Pull `--flag value` out of argv, returning the value (or undefined). */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const [cmd, ...rest] = process.argv.slice(2);

function usage(): never {
  console.log(
    [
      'Usage:',
      '  pnpm tsx scripts/keys.ts add <key> [--label <name>] [--provider 69labs]',
      '  pnpm tsx scripts/keys.ts list',
      '  pnpm tsx scripts/keys.ts disable <id>',
      '  pnpm tsx scripts/keys.ts enable  <id>',
      '  pnpm tsx scripts/keys.ts rm      <id>',
    ].join('\n'),
  );
  process.exit(1);
}

try {
  switch (cmd) {
    case 'add': {
      const key = rest.find((a) => !a.startsWith('--'));
      if (!key) usage();
      const row = await apiKeysRepo.add({
        apiKey: key,
        label: flag(rest, 'label'),
        provider: flag(rest, 'provider'),
      });
      console.log(`added key ${row.id} (${row.keyFingerprint}) provider=${row.provider} active=${row.isActive}`);
      break;
    }

    case 'list': {
      const rows = await apiKeysRepo.list();
      if (rows.length === 0) {
        console.log('no keys. add one: pnpm tsx scripts/keys.ts add <key>');
        break;
      }
      for (const r of rows) {
        const state = r.isActive ? 'active' : `disabled(${r.disabledReason ?? '?'})`;
        const used = r.lastUsedAt ? new Date(r.lastUsedAt).toISOString() : 'never';
        console.log(
          `${r.id}  ${r.provider}  ${(r.label ?? '-').padEnd(10)}  ${r.keyFingerprint}  ${state.padEnd(20)}  used=${used}`,
        );
      }
      break;
    }

    case 'disable': {
      const id = rest[0];
      if (!id) usage();
      await apiKeysRepo.disable(id, 'manual');
      console.log(`disabled ${id}`);
      break;
    }

    case 'enable': {
      const id = rest[0];
      if (!id) usage();
      await apiKeysRepo.enable(id);
      console.log(`enabled ${id}`);
      break;
    }

    case 'rm':
    case 'remove':
    case 'delete': {
      const id = rest[0];
      if (!id) usage();
      await apiKeysRepo.remove(id);
      console.log(`removed ${id}`);
      break;
    }

    default:
      usage();
  }
  process.exit(0);
} catch (err) {
  console.error('error:', (err as Error).message);
  process.exit(1);
}
