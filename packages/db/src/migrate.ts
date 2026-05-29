/**
 * Safe-mode migrator. Applies the one-shot bootstrap SQL
 * (infra/supabase/migrations/0001_init.sql) against DATABASE_URL.
 *
 * Idempotent: every statement uses IF NOT EXISTS / EXCEPTION-WHEN-duplicate_object,
 * so running this against an already-migrated DB is a no-op.
 *
 * Targets Supabase Postgres. Always run against the **direct connection**
 * (port 5432, host `db.<ref>.supabase.co`) — the transaction pooler (port 6543)
 * rejects multi-statement DDL transactions. Set DATABASE_URL inline for the
 * migrate command and leave the pooler URL in .env for app runtime.
 *
 * For ongoing schema changes, switch to Drizzle migrations:
 *   pnpm db:generate   (writes packages/db/migrations/*)
 *   pnpm db:migrate    (apply via drizzle-orm/postgres-js/migrator)
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_SQL = path.resolve(here, '../../../infra/supabase/migrations/0001_init.sql');

function looksLikePoolerUrl(url: string): boolean {
  return /:6543\//.test(url) || /pooler\.supabase\.com/.test(url);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  if (looksLikePoolerUrl(url)) {
    console.warn(
      '[migrate] WARNING: DATABASE_URL points at the Supabase transaction pooler ' +
        '(port 6543 / pooler.supabase.com). DDL may fail. Re-run with a direct ' +
        'connection string (port 5432, host db.<ref>.supabase.co).',
    );
  }

  const sql = postgres(url, { max: 1, prepare: false });
  try {
    const bootstrap = await readFile(BOOTSTRAP_SQL, 'utf8');
    console.log(`[migrate] applying ${BOOTSTRAP_SQL}`);
    await sql.unsafe(bootstrap);
    console.log('[migrate] ok');
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
