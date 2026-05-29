import { eq } from 'drizzle-orm';
import type { Timeline } from '@emberforge/core';
import { db } from '../client.js';
import { timelines } from '../schema/index.js';

export const timelinesRepo = {
  async upsert(tl: Timeline) {
    const [row] = await db
      .insert(timelines)
      .values({
        projectId: tl.projectId,
        edlJson: { clips: tl.clips, musicBeds: tl.musicBeds },
        totalDurS: String(tl.totalDurationS),
        version: tl.version,
      })
      .onConflictDoUpdate({
        target: timelines.projectId,
        set: {
          edlJson: { clips: tl.clips, musicBeds: tl.musicBeds },
          totalDurS: String(tl.totalDurationS),
          version: tl.version,
        },
      })
      .returning();
    return row!;
  },

  async findByProject(projectId: string) {
    const [row] = await db.select().from(timelines).where(eq(timelines.projectId, projectId)).limit(1);
    return row ?? null;
  },
};
