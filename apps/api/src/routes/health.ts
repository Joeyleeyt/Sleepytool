import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({ ok: true, ts: Date.now() }));
  app.get('/ready', async () => ({ ok: true }));
}
