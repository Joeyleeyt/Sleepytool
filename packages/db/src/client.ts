import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL not set');

// Pool sized for Supabase's PgBouncer transaction pooler. We run 7 long-lived
// processes (api + orchestrator + 4 workers + web SSR), each with its own
// client instance. Keep per-process small so total connections stay well under
// the free-tier pooler limit. `prepare: false` is mandatory on the transaction
// pooler (port 6543) — prepared statements aren't supported there.
const queryClient = postgres(connectionString, {
  max: Number(process.env.DB_POOL_MAX ?? 5),
  prepare: false,
  idle_timeout: 30,
  // Cold TCP+TLS to a distant Supabase region can take 5-10s; 15s left almost
  // no margin for jitter. Bump to 60s so workers don't fail under transient
  // network slowness.
  connect_timeout: Number(process.env.DB_CONNECT_TIMEOUT_S ?? 60),
  max_lifetime: 60 * 30, // recycle conns every 30min so pooler can rebalance
});

export const db = drizzle(queryClient, { schema });
export type DB = typeof db;
export { schema };
