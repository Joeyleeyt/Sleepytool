import { sql } from 'drizzle-orm';
import { integer, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { timelines } from './timelines.js';
import { genStatusEnum } from './enums.js';

export const renders = pgTable('renders', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  timelineId: uuid('timeline_id').notNull().references(() => timelines.id),
  status: genStatusEnum('status').notNull().default('queued'),
  r2Key: text('r2_key'),
  durationS: numeric('duration_s', { precision: 8, scale: 2 }),
  bitrateKbps: integer('bitrate_kbps'),
  log: text('log'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});
