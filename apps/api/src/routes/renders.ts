import type { FastifyInstance } from 'fastify';
import { signGet } from '@emberforge/storage';
import { db, schema } from '@emberforge/db';
import { eq } from 'drizzle-orm';

export async function rendersRoutes(app: FastifyInstance) {
  // Signed URL for a finished render's master MP4
  app.get('/renders/:id/url', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [r] = await db.select().from(schema.renders).where(eq(schema.renders.id, id)).limit(1);
    if (!r || !r.r2Key) {
      reply.code(404);
      return { error: 'not found' };
    }
    return { url: await signGet(r.r2Key, 3600), durationS: r.durationS };
  });

  // Signed URL for ANY asset (per-shot image / narration / video clip)
  // Used by the web UI to play individual clips and audio previews.
  app.get('/assets/:id/url', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [a] = await db.select().from(schema.assets).where(eq(schema.assets.id, id)).limit(1);
    if (!a) {
      reply.code(404);
      return { error: 'asset not found' };
    }
    return {
      url: await signGet(a.r2Key, 3600),
      kind: a.kind,
      durationS: a.durationS,
      bytes: a.bytes,
    };
  });
}
