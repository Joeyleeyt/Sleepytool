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
});
