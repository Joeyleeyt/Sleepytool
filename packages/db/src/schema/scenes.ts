import { sql } from 'drizzle-orm';
import { integer, jsonb, numeric, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';

export const scenes = pgTable(
  'scenes',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    title: text('title'),
    narrationChunk: text('narration_chunk').notNull(),
    emotion: text('emotion'),
    pacing: text('pacing'),
    atmosphere: text('atmosphere'),
    topic: text('topic'),
    analysis: jsonb('analysis'),
    startWordIdx: integer('start_word_idx'),
    endWordIdx: integer('end_word_idx'),
    estimatedDurS: numeric('estimated_dur_s', { precision: 6, scale: 2 }),
  },
  (t) => ({
    projOrdinalUq: uniqueIndex('scenes_project_ordinal_uq').on(t.projectId, t.ordinal),
  }),
);
