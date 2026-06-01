import { sql } from 'drizzle-orm';
import { integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { prompts } from './prompts.js';
import { genStatusEnum } from './enums.js';

export const generations = pgTable('generations', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  promptId: uuid('prompt_id').notNull().references(() => prompts.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  providerJobId: text('provider_job_id'),
  status: genStatusEnum('status').notNull().default('queued'),
  attempt: integer('attempt').notNull().default(1),
  latencyMs: integer('latency_ms'),
  error: jsonb('error'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});
