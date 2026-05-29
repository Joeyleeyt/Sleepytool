import { sql } from 'drizzle-orm';
import { integer, jsonb, numeric, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';

export const timelines = pgTable(
  'timelines',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    edlJson: jsonb('edl_json').notNull(),
    totalDurS: numeric('total_dur_s', { precision: 8, scale: 2 }).notNull(),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    projectUq: uniqueIndex('timelines_project_uq').on(t.projectId),
  }),
);
