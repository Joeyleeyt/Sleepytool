import { sql } from 'drizzle-orm';
import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';

export const transcripts = pgTable('transcripts', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  rawText: text('raw_text').notNull(),
  wordCount: integer('word_count'),
  estDurationS: integer('est_duration_s'),
  analysisJson: jsonb('analysis_json'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  // NOTE: the columns `narration_text` and `narration_est_duration_s` were
  // added by 0001_init.sql for a now-removed feature. They are intentionally
  // not mapped here — leaving them as orphaned nullable DB columns rather
  // than running a destructive DROP migration. Safe to remove later.
});
