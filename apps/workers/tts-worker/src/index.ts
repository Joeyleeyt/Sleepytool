import os from 'node:os';
import path from 'node:path';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { Worker } from 'bullmq';
import pino from 'pino';
import { acquire, connection } from '@emberforge/queue';
import { assetsRepo, eventsRepo, generationsRepo, promptsRepo } from '@emberforge/db';
import { labs69 } from '@emberforge/ai-clients';
import { r2Paths, uploadFile } from '@emberforge/storage';

const log = pino({ name: 'tts-worker' });

new Worker(
  'tts',
  async (job) => {
    const { projectId, shotId } = job.data as { projectId: string; shotId: string };

    const cached = await assetsRepo.findByShotKind(shotId, 'audio_narration');
    if (cached) {
      await eventsRepo.emit(projectId, 'tts', 'cached', { shotId });
      return { cached: true, assetId: cached.id };
    }

    const prompt = await promptsRepo.findForShot(shotId, '69labs.tts');
    if (!prompt) throw new Error(`no tts prompt for shot ${shotId}`);

    const generation = await generationsRepo.create({
      promptId: prompt.id,
      provider: '69labs.tts',
      status: 'queued',
    });

    try {
      await acquire('69labs.tts');
      await generationsRepo.markStarted(generation.id);
      const t0 = Date.now();

      const params = (prompt.params ?? {}) as { voice?: string; pace?: 'slow' | 'medium' | 'fast' };
      const result = await labs69.tts({
        text: prompt.promptText,
        voiceId: params.voice,
        pace: params.pace,
      });

      // 69labs TTS returns MP3 (presigned R2 URL). Download with plain fetch
      // since the URL is already a public signed link.
      const ext = ((result.metadata as { format?: string } | undefined)?.format ?? 'mp3').toLowerCase();
      const tmp = path.join(os.tmpdir(), `tts_${shotId}.${ext}`);
      await mkdir(path.dirname(tmp), { recursive: true });
      const r = await fetch(result.url);
      if (!r.ok) throw new Error(`download ${r.status} ${r.statusText}`);
      await writeFile(tmp, Buffer.from(await r.arrayBuffer()));

      const key = r2Paths.shotNarration(projectId, shotId, prompt.inputHash).replace(/\.wav$/, `.${ext}`);
      const uploaded = await uploadFile(tmp, key, ext === 'mp3' ? 'audio/mpeg' : 'audio/wav');
      await unlink(tmp).catch(() => {});

      const asset = await assetsRepo.create({
        projectId,
        shotId,
        generationId: generation.id,
        kind: 'audio_narration',
        r2Key: uploaded.key,
        bytes: uploaded.bytes,
        durationS: String(result.durationS),
        metadata: { providerJobId: result.providerJobId, voice: params.voice },
      });

      await generationsRepo.markSucceeded(generation.id, {
        providerJobId: result.providerJobId,
        latencyMs: Date.now() - t0,
      });
      await eventsRepo.emit(projectId, 'tts', 'succeeded', { shotId, durationS: result.durationS });
      return { assetId: asset.id };
    } catch (err) {
      await generationsRepo.markFailed(generation.id, { message: (err as Error).message });
      log.error({ shotId, err }, 'tts failed');
      throw err;
    }
  },
  // 69labs TTS limit is 20 req/min — keep concurrency at 4 since each job
  // takes ~10s and we already have rate limiter token bucket as a backstop.
  { connection, concurrency: 4 },
);

log.info('tts-worker started');
