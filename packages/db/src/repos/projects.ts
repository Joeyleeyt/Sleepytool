import { desc, eq } from 'drizzle-orm';
import type { ProjectStatus } from '@emberforge/core';
import { db } from '../client.js';
import { projects, transcripts } from '../schema/index.js';

export const projectsRepo = {
  async create(input: {
    ownerId: string;
    title: string;
    stylePreset?: string;
    targetRes?: '1920x1080' | '3840x2160';
    targetFps?: 24 | 30 | 60;
  }) {
    const [row] = await db
      .insert(projects)
      .values({
        ownerId: input.ownerId,
        title: input.title,
        // Sleep-documentary product: default to the dark, low-saturation,
        // soft-contrast sleep palette so a project created without an explicit
        // preset is sleepy by default (the cinematic presets are now opt-in).
        stylePreset: input.stylePreset ?? 'nocturne_soft',
        // 1920×1080 is YouTube's standard upload — fits a 16:9 player at full
        // HD and renders 3-4× faster than 4K. Bump to '3840x2160' per project
        // (via PATCH /projects/:id) for 4K masters.
        targetRes: input.targetRes ?? '1920x1080',
        targetFps: input.targetFps ?? 30,
      })
      .returning();
    return row!;
  },

  async findById(id: string) {
    const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
    return row ?? null;
  },

  async listByOwner(ownerId: string, opts: { limit?: number } = {}) {
    return db
      .select()
      .from(projects)
      .where(eq(projects.ownerId, ownerId))
      .orderBy(desc(projects.updatedAt))
      .limit(opts.limit ?? 50);
  },

  async setStatus(id: string, status: ProjectStatus) {
    await db.update(projects).set({ status, updatedAt: new Date() }).where(eq(projects.id, id));
  },

  async update(
    id: string,
    patch: {
      title?: string;
      stylePreset?: string;
      targetRes?: '1920x1080' | '3840x2160';
      targetFps?: 24 | 30 | 60;
    },
  ) {
    const [row] = await db
      .update(projects)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(projects.id, id))
      .returning();
    return row ?? null;
  },
};

export const transcriptsRepo = {
  async create(input: { projectId: string; rawText: string }) {
    const wordCount = input.rawText.split(/\s+/).length;
    const estDurationS = Math.round((wordCount / 150) * 60); // 150 wpm baseline
    const [row] = await db
      .insert(transcripts)
      .values({ projectId: input.projectId, rawText: input.rawText, wordCount, estDurationS })
      .returning();      
    return row!;
  },

  async findByProject(projectId: string) {
    const [row] = await db
      .select()
      .from(transcripts)
      .where(eq(transcripts.projectId, projectId))
      .limit(1);
    return row ?? null;
  },

  async saveAnalysis(id: string, analysisJson: unknown) {
    await db.update(transcripts).set({ analysisJson: analysisJson as object }).where(eq(transcripts.id, id));
  },
};
