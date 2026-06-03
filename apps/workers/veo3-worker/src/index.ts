import os from 'node:os';
import path from 'node:path';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { Worker } from 'bullmq';
import pino from 'pino';
import { acquire, connection } from '@emberforge/queue';
import { assetsRepo, eventsRepo, generationsRepo, promptsRepo, shotsRepo } from '@emberforge/db';
import { generateVideo } from '@emberforge/ai-clients';
import { r2Paths, uploadFile } from '@emberforge/storage';

const log = pino({ name: 'veo3-worker' });

new Worker(
  'veo3',
  async (job) => {
    const { projectId, shotId } = job.data as { projectId: string; shotId: string };
    const shot = await shotsRepo.findById(shotId);
    if (!shot) throw new Error(`shot ${shotId} not found`);

    // Cache check
    const cached = await assetsRepo.findByShotKind(shotId, 'video_clip');
    if (cached) {
      await eventsRepo.emit(projectId, 'veo3', 'cached', { shotId });
      return { cached: true, assetId: cached.id };
    }

    const prompt = await promptsRepo.findForShot(shotId, 'veo3');
    if (!prompt) throw new Error(`no veo3 prompt for shot ${shotId}`);

    const generation = await generationsRepo.create({
      promptId: prompt.id,
      provider: 'veo3',
      status: 'queued',
    });

    try {
      await acquire('veo3');
      await generationsRepo.markStarted(generation.id);
      const t0 = Date.now();

      const result = await generateVideo({
        prompt: prompt.promptText,
        negative: prompt.negative ?? undefined,
        durationS: Number(shot.durationS),
        resolution: '1080p',
      });

      // Stream the video to disk then upload to R2
      const tmp = path.join(os.tmpdir(), `veo3_${shotId}.mp4`);
      await mkdir(path.dirname(tmp), { recursive: true });
      const r = await fetch(result.videoUrl);
      if (!r.ok) throw new Error(`download ${r.status} ${r.statusText}`);
      await writeFile(tmp, Buffer.from(await r.arrayBuffer()));

      const key = r2Paths.shotVideo(projectId, shotId, prompt.inputHash);
      const uploaded = await uploadFile(tmp, key, 'video/mp4');
      await unlink(tmp).catch(() => {});

      const asset = await assetsRepo.create({
        projectId,
        shotId,
        generationId: generation.id,
        kind: 'video_clip',
        r2Key: uploaded.key,
        bytes: uploaded.bytes,
        durationS: String(result.durationS),
        metadata: { providerJobId: result.providerJobId },
      });

      await generationsRepo.markSucceeded(generation.id, {
        providerJobId: result.providerJobId,
        latencyMs: Date.now() - t0,
      });
      await eventsRepo.emit(projectId, 'veo3', 'succeeded', { shotId });
      return { assetId: asset.id };
    } catch (err) {
      await generationsRepo.markFailed(generation.id, { message: (err as Error).message });
      log.error({ shotId, err }, 'veo3 failed');
      throw err;
    }
  },
  // Each job buffers a whole video download in memory, so concurrency caps the
  // peak memory on the shared 2gb `workers` machine — NOT throughput (the veo3
  // rate limiter at ~30/min is the real throughput gate, and phases run
  // sequentially so this fan-out is the only veo3 load at a time). 4 keeps peak
  // download buffers well under the memory budget alongside labs/tts/heap.
  { connection, concurrency: 4 },
);

log.info('veo3-worker started');
