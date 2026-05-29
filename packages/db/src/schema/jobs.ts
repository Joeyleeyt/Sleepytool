import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    queue: text('queue').notNull(),
    bullId: text('bull_id').notNull(),
    state: text('state').notNull(),
    attempts: integer('attempts').notNull().default(0),
    inputHash: text('input_hash').notNull(),
    payload: jsonb('payload'),
    result: jsonb('result'),
    error: jsonb('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    stateIdx: index('jobs_state_idx').on(t.state),
    projectIdx: index('jobs_project_idx').on(t.projectId),
  }),
);
