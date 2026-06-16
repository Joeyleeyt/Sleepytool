-- ============================================================================
-- auth_credential — the single shared operator password for the web console
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL editor, OR let `pnpm db:migrate` apply it (it's
-- also in infra/supabase/migrations/0001_init.sql). Idempotent (IF NOT EXISTS).
--
-- One row only: `id` is pinned to 'singleton' by a CHECK + the primary key, so
-- there is always exactly one shared password. Bootstrapped from the APP_PASSWORD
-- env var on first login; thereafter the stored value wins and is changeable at
-- runtime via /api/change-password.
--
-- SECURITY: password_hash holds a salted scrypt hash (see apps/web lib/password.ts);
-- the plaintext password NEVER touches this table.
-- ============================================================================

create extension if not exists "pgcrypto";

create table if not exists auth_credential (
  id            text primary key default 'singleton' check (id = 'singleton'),
  password_hash text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- RLS on, no policies: the app reaches Postgres via a direct connection (which
-- bypasses RLS), so this only blocks the anon Supabase REST API from reading the
-- password hash. Belt-and-suspenders.
alter table auth_credential enable row level security;
