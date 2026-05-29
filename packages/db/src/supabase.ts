/**
 * Server-side Supabase client (service-role key, RLS bypassed).
 *
 * This lives alongside the Drizzle data layer in [client.ts](./client.ts) —
 * Drizzle still handles structured queries via direct Postgres. Use this
 * client for Supabase platform features that don't have a Drizzle equivalent:
 *
 *   - Auth admin (createUser, deleteUser, listUsers, etc.)
 *   - Storage uploads / signed URLs
 *   - Realtime broadcasts
 *   - Edge-function invocation
 *
 * Lazy-initialized: env vars are read on first access, not at import, so
 * processes that never touch Supabase platform features don't crash if the
 * env isn't set (handy in test / migration runs).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('SUPABASE_URL not set');
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set');

  cached = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
