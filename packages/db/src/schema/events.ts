import { bigserial, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';

export const projectEvents = pgTable('project_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  stage: text('stage').notNull(),
  event: text('event').notNull(),
  payload: jsonb('payload'),
  ts: timestamp('ts', { withTimezone: true }).defaultNow(),
});
