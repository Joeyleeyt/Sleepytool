import Fastify from 'fastify';
import cors from '@fastify/cors';
import { projectsRoutes } from './routes/projects.js';
import { rendersRoutes } from './routes/renders.js';
import { webhooksRoutes } from './routes/webhooks.js';
import { healthRoutes } from './routes/health.js';

export async function buildServer() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  await app.register(cors, { origin: true });

  await app.register(healthRoutes);
  await app.register(projectsRoutes, { prefix: '/v1' });
  await app.register(rendersRoutes, { prefix: '/v1' });
  await app.register(webhooksRoutes, { prefix: '/v1' });

  return app;
}
