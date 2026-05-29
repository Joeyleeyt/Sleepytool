import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uuid, integer } from 'drizzle-orm/pg-core';
import { projectStatusEnum } from './enums.js';

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  ownerId: uuid('owner_id').notNull(),
  title: text('title').notNull(),
  status: projectStatusEnum('status').notNull().default('ingested'),
  stylePreset: text('style_preset').notNull().default('cinematic_dark_ember'),
  targetRes: text('target_res').notNull().default('3840x2160'),
  targetFps: integer('target_fps').notNull().default(30),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});
