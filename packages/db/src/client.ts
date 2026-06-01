/**
 * Lazy Drizzle/Postgres client. Module load NEVER opens a connection or
 * throws on missing env — both happen on first property access on `db`.
 *
 * Why: Vercel's build step imports route handlers to collect page metadata,
 * but env vars (DATABASE_URL et al.) aren't set during the build container —
 * they're injected at deploy/runtime. An eager throw at module load would
 * kill the build before Next.js can finish "collecting page data". Same
 * pattern as packages/queue/src/connection.ts.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

type DrizzleDb = PostgresJsDatabase<typeof schema>;

let cached: DrizzleDb | null = null;

function getDb(): DrizzleDb {
  if (cached) return cached;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL not set');

  // Pool sized for Supabase's PgBouncer transaction pooler. We run several
  // long-lived processes (orchestrator + 4 workers + web SSR), each with its
  // own client instance. Keep per-process small so total connections stay
  // well under the free-tier pooler limit. `prepare: false` is mandatory on
  // the transaction pooler (port 6543) — prepared statements aren't supported.
  const queryClient = postgres(connectionString, {
    max: Number(process.env.DB_POOL_MAX ?? 5),
    prepare: false,
    idle_timeout: 30,
    // Cold TCP+TLS to a distant Supabase region can take 5-10s; 15s left
    // almost no margin for jitter. Bump to 60s so workers don't fail under
    // transient network slowness.
    connect_timeout: Number(process.env.DB_CONNECT_TIMEOUT_S ?? 60),
    max_lifetime: 60 * 30, // recycle conns every 30min so pooler can rebalance
  });
  cached = drizzle(queryClient, { schema });
  return cached;
}

// Back-compat: transparent proxy that defers to the real Drizzle instance on
// every property access. Allows existing `db.select(...)` / `db.insert(...)`
// callers to keep working with zero changes.
//
// Functions returned by the proxy are bound to the real Drizzle instance —
// otherwise `this` inside Drizzle's chainable methods would be the proxy and
// internal state reads would break.
export const db: DrizzleDb = new Proxy({} as DrizzleDb, {
  get(_target, prop) {
    const real = getDb() as unknown as Record<string | symbol, unknown>;
    const value = real[prop as string];
    return typeof value === 'function' ? (value as Function).bind(real) : value;
  },
  set(_target, prop, value) {
    (getDb() as unknown as Record<string | symbol, unknown>)[prop as string] = value;
    return true;
  },
  has(_target, prop) {
    return prop in (getDb() as unknown as Record<string | symbol, unknown>);
  },
});

export type DB = DrizzleDb;
export { schema };
