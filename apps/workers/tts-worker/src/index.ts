import os from 'node:os';
import path from 'node:path';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { Worker, type Job } from 'bullmq';
import pino from 'pino';
import { acquire, tryAcquireSlot, connection, allLaneQueues, NUM_LANES } from '@emberforge/queue';
import { assetsRepo, eventsRepo, generationsRepo, promptsRepo } from '@emberforge/db';
import { labs69, withKeySlot } from '@emberforge/ai-clients';
import { r2Paths, uploadFile } from '@emberforge/storage';

const log = pino({ name: 'tts-worker' });

// 69labs caps CONCURRENT in-flight jobs PER ACCOUNT/key (separate from the
// req/min rate limit). `withKeySlot` gives every active key its own pool of
// TTS_PER_KEY_MAX slots and spreads jobs across keys, so N keys run
// N×TTS_PER_KEY_MAX narrations at once instead of funnelling every TTS job
// through key #1 (what `withProviderKey` used to do). Mirrors labs-worker's
// image/video handling.
const TTS_PER_KEY_MAX = Math.max(1, Number(process.env.LABS69_TTS_PER_KEY_CONCURRENCY ?? 2));
// Expected active-key count — only sizes the BullMQ pull cap so enough jobs are
// in hand to fill every key's slots. Bump it (or add keys) and TTS scales; the
// real limiter is the per-key slot pool. Shared with labs-worker via the same
// LABS69_MAX_KEYS env so all 69labs workers agree on the key count.
const MAX_KEYS = Math.max(1, Number(process.env.LABS69_MAX_KEYS ?? 2));
const TTS_MAX = Math.max(1, Number(process.env.LABS69_TTS_MAX_CONCURRENCY ?? MAX_KEYS * TTS_PER_KEY_MAX));

// One shot's narration. Shared by every lane's tts{N} worker — the handler
// routes on job.data, not the queue name, so it's identical across lanes.
async function processTts(job: Job) {
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
      // Run the whole TTS generate→poll→download on whichever active key has a
      // free slot (one pool of TTS_PER_KEY_MAX per key), so N keys generate
      // narration in parallel instead of every job funnelling through key #1.
      // Blocks here until some key has a free slot; the lease is auto-reclaimed
      // if this worker crashes. On a key-attributable failure (bad key, 402
      // no-credits, 429) withKeySlot rotates to another key and re-runs the call
      // — a fresh job under the new account — instead of failing narration.
      // Content failures (CENSORED) are rethrown immediately so we don't burn
      // the pool on a doomed prompt. Falls back to the legacy LABS69_API_KEY env
      // value until the api_keys table is populated (safe incremental rollout).
      const result = await withKeySlot(
        '69labs',
        (apiKey, _keyId) =>
          labs69.tts({
            text: prompt.promptText,
            voiceId: params.voice,
            pace: params.pace,
            apiKey,
          }),
        {
          perKeyMax: TTS_PER_KEY_MAX,
          // TTS poll ceiling is 10min; the lease must exceed one job's full span.
          leaseMs: 12 * 60_000,
          // Redis-backed slot pools, one per key: `cc:69labs.tts:<keyId>`.
          tryAcquireSlot,
          slotKeyFor: (keyId) => `69labs.tts:${keyId}`,
          fallbackKey: process.env.LABS69_API_KEY,
        },
      );

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
}

// One worker group per lane (LABS_LANES). Each lane drains its own tts{N} queue
// so a second project's narration generates concurrently instead of queueing
// behind the first. The handler is identical across lanes, and every lane shares
// the SAME per-key TTS slot pools inside withKeySlot, so 69labs' caps still hold
// no matter how many lanes run. BullMQ concurrency is the PULL cap (≈ keys ×
// per-key slots) left full per lane, so one active project saturates every slot
// (100%) and two split them. Each job buffers only a small MP3, so memory isn't
// the constraint here.
for (const { tts } of allLaneQueues()) {
  new Worker(tts, processTts, { connection, concurrency: TTS_MAX });
}

log.info(
  { lanes: NUM_LANES, queues: allLaneQueues().map((l) => l.tts), perKeyMax: TTS_PER_KEY_MAX, pull: TTS_MAX },
  `tts-worker started — ${NUM_LANES} lane(s), per-key slot pools shared across lanes`,
);
