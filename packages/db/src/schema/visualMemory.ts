import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { shots } from './shots.js';

export const visualMemory = pgTable(
  'visual_memory',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    key: text('key').notNull(),
    descriptor: text('descriptor').notNull(),
    referenceImageR2: text('reference_image_r2'),
    firstSeenShot: uuid('first_seen_shot').references(() => shots.id),
    usageCount: integer('usage_count').notNull().default(0),
  },
  (t) => ({
    projKindKeyUq: uniqueIndex('vm_proj_kind_key_uq').on(t.projectId, t.kind, t.key),
    projKindIdx: index('vm_proj_kind_idx').on(t.projectId, t.kind),
  }),
);
