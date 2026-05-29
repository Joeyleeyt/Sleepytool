import { sql } from 'drizzle-orm';
import { integer, jsonb, numeric, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { scenes } from './scenes.js';
import { visualTypeEnum } from './enums.js';

export const shots = pgTable(
  'shots',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    sceneId: uuid('scene_id').notNull().references(() => scenes.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    narrationText: text('narration_text').notNull(),
    durationS: numeric('duration_s', { precision: 5, scale: 2 }).notNull(),
    visualType: visualTypeEnum('visual_type').notNull(),
    visualSummary: text('visual_summary'),
    cameraMovement: text('camera_movement'),
    lens: text('lens'),
    fxRecommendation: jsonb('fx_recommendation'),
    transitionIn: text('transition_in'),
    transitionOut: text('transition_out'),
    soundtrackMood: text('soundtrack_mood'),
  },
  (t) => ({
    sceneOrdinalUq: uniqueIndex('shots_scene_ordinal_uq').on(t.sceneId, t.ordinal),
  }),
);
