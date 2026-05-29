/**
 * Browser Supabase client (anon key, RLS enforced).
 *
 * Use this from React components / hooks for:
 *   - Realtime row-change subscriptions (e.g. live shot status without polling)
 *   - Auth flows (signInWithPassword, signInWithOAuth)
 *   - Direct Storage downloads with the user's JWT
 *
 * NOT for writing app data — those go through /api/ef/* so RLS + server-side
 * validation stay authoritative.
 */
'use client';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL not set');
  if (!anonKey) throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY not set');

  cached = createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return cached;
}
