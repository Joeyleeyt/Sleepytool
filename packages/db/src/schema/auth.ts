import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Single shared operator password for the web console (see apps/web middleware).
 *
 * This is a ONE-ROW table — the `id` is pinned to the literal 'singleton' (a DB
 * CHECK + the primary key enforce that), so there is always exactly one password.
 * It's bootstrapped from the APP_PASSWORD env var on first login, after which the
 * stored value is authoritative and can be changed at runtime via /api/change-password.
 *
 * Only `password_hash` is persisted — a salted scrypt hash (see apps/web
 * lib/password.ts). The plaintext password never touches the DB.
 */
export const authCredential = pgTable('auth_credential', {
  id: text('id').primaryKey().default('singleton'),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AuthCredentialRow = typeof authCredential.$inferSelect;
export type AuthCredentialInsert = typeof authCredential.$inferInsert;
