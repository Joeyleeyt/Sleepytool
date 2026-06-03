import os from 'node:os';
import path from 'node:path';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { Worker } from 'bullmq';
import pino from 'pino';
import { acquire, connection } from '@emberforge/queue';
import { assetsRepo, eventsRepo, generationsRepo, promptsRepo, shotsRepo } from '@emberforge/db';
import { labs69 } from '@emberforge/ai-clients';
import { r2Paths, uploadFile } from '@emberforge/storage';

const log = pino({ name: 'labs-worker' });

async function downloadToTmp(url: string, fileName: string): Promise<string> {
  const tmp = path.join(os.tmpdir(), fileName);
  await mkdir(path.dirname(tmp), { recursive: true });
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status} ${r.statusText}`);
  await writeFile(tmp, Buffer.from(await r.arrayBuffer()));
  return tmp;
}

new Worker(
  'labs',
  async (job) => {
    const { projectId, shotId, kind } = job.data as { projectId: string; shotId: string; kind: 'image' | 'video' };
    const shot = await shotsRepo.findById(shotId);
    if (!shot) throw new Error(`shot ${shotId} not found`);

    const assetKind = kind === 'image' ? 'image' : 'video_clip';
    const cached = await assetsRepo.findByShotKind(shotId, assetKind);
    if (cached) {
      await eventsRepo.emit(projectId, 'labs', 'cached', { shotId, kind });
      return { cached: true, assetId: cached.id };
    }

    const target = kind === 'image' ? '69labs.image' : '69labs.video';
    const prompt = await promptsRepo.findForShot(shotId, target);
    if (!prompt) throw new Error(`no ${target} prompt for shot ${shotId}`);

    const generation = await generationsRepo.create({
      promptId: prompt.id,
      provider: target,
      status: 'queued',
    });

    try {
      await acquire(kind === 'image' ? '69labs.image' : '69labs.video');
      await generationsRepo.markStarted(generation.id);
      const t0 = Date.now();

      const result =
        kind === 'image'
          ? await labs69.image({
              prompt: prompt.promptText,
              negative: prompt.negative ?? undefined,
              // Full HD target: 2k (~2048×1152) is the smallest 69labs tier that
              // fully covers a 1920×1080 frame, so it downscales to crisp Full HD
              // (1k is sub-1080p and would be upscaled). nano-banana models
              // accept 1k|2k|4k; override via LABS69_IMAGE_RESOLUTION.
              aspectRatio: '16:9',
              resolution: process.env.LABS69_IMAGE_RESOLUTION ?? '2k',
            })
          : await labs69.video({
              prompt: prompt.promptText,
              negative: prompt.negative ?? undefined,
              durationS: Number(shot.durationS),
              // Intentionally NOT passing aspectRatio / resolution — the
              // default 69labs video model (Veo 3.1 Lite) rejects both with
              // 400. Output is native 16:9 at the model's chosen size and
              // gets scaled to the project's targetRes in the final encode.
            });

      const ext = kind === 'image' ? 'png' : 'mp4';
      const tmp = await downloadToTmp(result.url, `labs_${shotId}.${ext}`);
      const key =
        kind === 'image'
          ? r2Paths.shotImage(projectId, shotId, prompt.inputHash)
          : r2Paths.shotVideo(projectId, shotId, prompt.inputHash);
      const uploaded = await uploadFile(tmp, key, kind === 'image' ? 'image/png' : 'video/mp4');
      await unlink(tmp).catch(() => {});

      const asset = await assetsRepo.create({
        projectId,
        shotId,
        generationId: generation.id,
        kind: assetKind,
        r2Key: uploaded.key,
        bytes: uploaded.bytes,
        durationS: kind === 'video' ? String(Number(shot.durationS)) : null,
        metadata: { providerJobId: result.providerJobId },
      });

      await generationsRepo.markSucceeded(generation.id, {
        providerJobId: result.providerJobId,
        latencyMs: Date.now() - t0,
      });
      await eventsRepo.emit(projectId, 'labs', 'succeeded', { shotId, kind });
      return { assetId: asset.id };
    } catch (err) {
      await generationsRepo.markFailed(generation.id, { message: (err as Error).message });
      log.error({ shotId, err }, '69labs failed');
      throw err;
    }
  },
  // 69labs limits (~10/min image, ~5/min video) gate throughput; the rate
  // limiter is the real backstop. Each job buffers a video/image download in
  // memory, so concurrency sets peak memory on the `workers` machine — size the
  // VM RAM accordingly (8 ⇒ 6gb). Default 8; LABS_CONCURRENCY overrides.
  // See infra/fly/sleepytool.fly.toml.
  { connection, concurrency: Math.max(1, Number(process.env.LABS_CONCURRENCY ?? 8)) },
);

log.info('labs-worker started');
