import type { FastifyInstance } from 'fastify';
import { eventsRepo } from '@emberforge/db';

/**
 * Provider webhooks (Veo 3, 69labs). Used only when async providers report
 * completion out-of-band. The polling path inside each worker is the primary
 * mechanism; webhooks are an optimization to wake jobs faster.
 */
export async function webhooksRoutes(app: FastifyInstance) {
  app.post('/hooks/veo3', async (req) => {
    const body = req.body as { jobId?: string; projectId?: string; status?: string };
    if (body.projectId) {
      await eventsRepo.emit(body.projectId, 'veo3', `webhook:${body.status ?? 'unknown'}`, body);
    }
    // TODO: signal the in-flight BullMQ job via a pub/sub channel keyed by jobId
    return { ok: true };
  });

  app.post('/hooks/69labs', async (req) => {
    const body = req.body as { jobId?: string; projectId?: string; status?: string };
    if (body.projectId) {
      await eventsRepo.emit(body.projectId, '69labs', `webhook:${body.status ?? 'unknown'}`, body);
    }
    return { ok: true };
  });
}
