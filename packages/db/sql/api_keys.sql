-- ============================================================================
-- api_keys — 69labs API keys (encrypted) that workers rotate through on failure
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL editor, OR let Drizzle own it: after adding
-- packages/db/src/schema/apiKeys.ts run `pnpm db:generate` then `pnpm db:migrate`.
-- Idempotent (IF NOT EXISTS).
--
-- SECURITY: encrypted_api_key holds an AES-256-GCM envelope (see crypto.ts);
-- the plaintext key and the master secret (API_KEY_ENCRYPTION_SECRET) NEVER
-- touch this table. A dump of this table is useless without the env secret.
-- ============================================================================

create extension if not exists "pgcrypto"; -- for gen_random_uuid()

create table if not exists api_keys (
  id                uuid primary key default gen_random_uuid(),
  provider          text        not null default '69labs',
  label             text,

  encrypted_api_key text        not null,          -- v1:iv:tag:ciphertext
  key_fingerprint   text        not null,          -- sha256(plaintext)[:12]

  is_active         boolean     not null default true,
  disabled_reason   text,                           -- invalid_key | no_credits | manual

  last_used_at      timestamptz,
  last_error        jsonb,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists api_keys_provider_active_idx
  on api_keys (provider, is_active);

-- Stop the same physical key being registered twice.
create unique index if not exists api_keys_provider_fingerprint_unq
  on api_keys (provider, key_fingerprint);

-- RLS on, no policies: the app reaches Postgres via a direct connection (which
-- bypasses RLS), so this only blocks the anon Supabase REST API from ever
-- reading the encrypted keys. Belt-and-suspenders.
alter table api_keys enable row level security;
