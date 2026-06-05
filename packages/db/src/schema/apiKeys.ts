import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Provider API keys (69labs). Add as many as you have; a worker tries them in
 * order and rotates to the next on failure (see ai-clients/keyManager.ts). Add
 * or remove keys anytime via `pnpm tsx scripts/keys.ts` — no redeploy needed.
 *
 * The key is stored ENCRYPTED in `encrypted_api_key` (see ../crypto.ts); the
 * plaintext and the master secret never touch the DB.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    provider: text('provider').notNull().default('69labs'),
    // Optional human label so you can tell keys apart ("main", "backup").
    label: text('label'),

    encryptedApiKey: text('encrypted_api_key').notNull(),
    // sha256(plaintext)[:12] — lets us dedupe (a key can't be added twice) and
    // refer to a key in the CLI/logs without printing the secret.
    keyFingerprint: text('key_fingerprint').notNull(),

    // The only health flag we need: rotation skips inactive keys. A key flips to
    // inactive automatically when it's clearly dead (bad key / no credits), or
    // when you disable it by hand.
    isActive: boolean('is_active').notNull().default(true),
    disabledReason: text('disabled_reason'),

    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    // Last failure payload, so you can see WHY a key was disabled.
    lastError: jsonb('last_error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    providerActiveIdx: index('api_keys_provider_active_idx').on(t.provider, t.isActive),
    providerFingerprintUnq: uniqueIndex('api_keys_provider_fingerprint_unq').on(
      t.provider,
      t.keyFingerprint,
    ),
  }),
);

export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type ApiKeyInsert = typeof apiKeys.$inferInsert;
