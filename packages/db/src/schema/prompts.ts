import { sql } from 'drizzle-orm';
import { bigint, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { shots } from './shots.js';

export const prompts = pgTable(
  'prompts',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    shotId: uuid('shot_id').notNull().references(() => shots.id, { onDelete: 'cascade' }),
    target: text('target').notNull(),
    promptText: text('prompt_text').notNull(),
    negative: text('negative'),
    seed: bigint('seed', { mode: 'number' }),
    params: jsonb('params'),
    inputHash: text('input_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    shotTargetHashUq: uniqueIndex('prompts_shot_target_hash_uq').on(t.shotId, t.target, t.inputHash),
  }),
);
