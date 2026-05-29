import { sql } from 'drizzle-orm';
import { integer, jsonb, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { jobs } from './jobs.js';

export const retries = pgTable('retries', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  jobId: uuid('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
  attempt: integer('attempt').notNull(),
  error: jsonb('error'),
  nextAt: timestamp('next_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
