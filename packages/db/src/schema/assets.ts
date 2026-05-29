import { sql } from 'drizzle-orm';
import { bigint, index, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { shots } from './shots.js';
import { generations } from './generations.js';
import { assetKindEnum } from './enums.js';

export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    shotId: uuid('shot_id').references(() => shots.id, { onDelete: 'set null' }),
    generationId: uuid('generation_id').references(() => generations.id),
    kind: assetKindEnum('kind').notNull(),
    r2Key: text('r2_key').notNull(),
    bytes: bigint('bytes', { mode: 'number' }),
    durationS: numeric('duration_s', { precision: 8, scale: 3 }),
    width: integer('width'),
    height: integer('height'),
    metadata: jsonb('metadata'),
    checksum: text('checksum'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    projKindIdx: index('assets_project_kind_idx').on(t.projectId, t.kind),
  }),
);
