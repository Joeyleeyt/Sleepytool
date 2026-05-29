import { db } from '../client.js';
import { projectEvents } from '../schema/index.js';

export const eventsRepo = {
  async emit(projectId: string, stage: string, event: string, payload?: unknown) {
    await db.insert(projectEvents).values({
      projectId,
      stage,
      event,
      payload: (payload as object | undefined) ?? null,
    });
  },
};
