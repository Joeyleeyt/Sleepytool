import os from 'node:os';
import path from 'node:path';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { Worker, type Job } from 'bullmq';
import pino from 'pino';
import { acquire, acquireSlot, connection, allLaneQueues, NUM_LANES, type Slot } from '@emberforge/queue';
import { assetsRepo, eventsRepo, generationsRepo, promptsRepo, shotsRepo } from '@emberforge/db';
import { generateVideo } from '@emberforge/ai-clients';
import { r2Paths, uploadFile } from '@emberforge/storage';

const log = pino({ name: 'veo3-worker' });

// Global veo3 concurrency cap, shared across ALL lanes via one Redis slot pool
// (cc:veo3). veo3 has no per-key pool like 69labs, so without this a second lane
// would double the in-flight video downloads (peak memory on the shared workers
// box) and the concurrent veo3 submissions. Work-conserving: one active project
// fills all VEO3_MAX slots (100%), two split them. Default matches the old
// single-group concurrency of 4.
const VEO3_MAX = Math.max(1, Number(process.env.VEO3_MAX_CONCURRENCY ?? 4));

// One shot's veo3 video. Shared by every lane's veo3{N} worker — routes on
// job.data, not the queue name, so it's identical across lanes.
async function processVeo3(job: Job) {
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

    let slot: Slot | undefined;
    try {
      await acquire('veo3');
      // Hold a global veo3 slot for the whole job (generate + download) so total
      // in-flight stays capped at VEO3_MAX across every lane — the in-memory
      // download buffer is the constraint. Released in finally.
      slot = await acquireSlot('veo3', VEO3_MAX);
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
    } finally {
      await slot?.release();
    }
}

// One worker group per lane (LABS_LANES). Each lane drains its own veo3{N} queue
// so a second project's clips generate concurrently instead of queueing behind
// the first. Each job buffers a whole video download in memory, so the shared
// cc:veo3 slot pool (VEO3_MAX) — not BullMQ concurrency — is what caps peak
// memory across all lanes. BullMQ concurrency is just the pull cap, left at
// VEO3_MAX so a single lane can fill every slot.
for (const { veo3 } of allLaneQueues()) {
  new Worker(veo3, processVeo3, { connection, concurrency: VEO3_MAX });
}

log.info(
  { lanes: NUM_LANES, queues: allLaneQueues().map((l) => l.veo3), max: VEO3_MAX },
  `veo3-worker started — ${NUM_LANES} lane(s), shared cc:veo3 slot pool`,
);
