import os from 'node:os';
import path from 'node:path';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { Worker, type Job } from 'bullmq';
import pino from 'pino';
import { acquire, tryAcquireSlot, connection } from '@emberforge/queue';
import { assetsRepo, eventsRepo, generationsRepo, promptsRepo, shotsRepo } from '@emberforge/db';
import { labs69, withKeySlot } from '@emberforge/ai-clients';
import { r2Paths, uploadFile } from '@emberforge/storage';

const log = pino({ name: 'labs-worker' });

// 69labs caps CONCURRENT in-flight jobs PER ACCOUNT/key (separate from the
// req/min rate limit). Exceeding it returns `403 Concurrent ... limit reached`.
// `withKeySlot` gives every active key its own pool of PER_KEY_MAX slots and
// spreads jobs across keys, so two keys run 2×PER_KEY_MAX jobs per feature at
// once (e.g. 2 keys × 2 = 4) instead of funnelling everything through key #1.
const PER_KEY_MAX = Math.max(1, Number(process.env.LABS69_PER_KEY_CONCURRENCY ?? 2));
// Expected active-key count — only sizes each worker's BullMQ pull cap so
// enough jobs are in hand to fill every key's slots. The real limiter is the
// per-key slot pool; bump this when you add more keys. Per-kind env still wins.
const MAX_KEYS = Math.max(1, Number(process.env.LABS69_MAX_KEYS ?? 2));
const IMAGE_MAX = Math.max(1, Number(process.env.LABS69_IMAGE_MAX_CONCURRENCY ?? MAX_KEYS * PER_KEY_MAX));
const VIDEO_MAX = Math.max(1, Number(process.env.LABS69_VIDEO_MAX_CONCURRENCY ?? MAX_KEYS * PER_KEY_MAX));

// Provider job ids currently in flight (id -> URL segment), so we can cancel
// them on shutdown instead of orphaning them — orphaned jobs keep occupying a
// concurrency slot on 69labs and eventually exhaust the cap. The `--watch` dev
// restart was the main culprit.
const inflight = new Map<string, 'images' | 'videos'>();

async function downloadToTmp(url: string, fileName: string): Promise<string> {
  const tmp = path.join(os.tmpdir(), fileName);
  await mkdir(path.dirname(tmp), { recursive: true });
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status} ${r.statusText}`);
  await writeFile(tmp, Buffer.from(await r.arrayBuffer()));
  return tmp;
}

// One shot's image OR video generation. Shared by both the labsImage and
// labsVideo workers — `job.data.kind` selects the branch. 69labs image and
// video are independent features (separate rate limits and concurrency caps),
// so each runs on its own queue/worker; this handler is the common body.
async function processShot(job: Job) {
  const { projectId, shotId, kind } = job.data as { projectId: string; shotId: string; kind: 'image' | 'video' };

  // Where is this shot right now? `loc` is WORKER while we do local work
  // (cache/prompt/slot/download/upload) and 69LABS once it's submitted and we
  // are only polling the provider. Printed to the console so all shots' states
  // are visible at a glance.
  const tag = `labs:${kind}`;
  const phase = (loc: 'WORKER' | '69LABS', phase: string, extra = '') =>
    console.log(`[${tag}] shot=${shotId} loc=${loc.padEnd(6)} phase=${phase}${extra}`);

  phase('WORKER', 'picked_up');
  const shot = await shotsRepo.findById(shotId);
  if (!shot) throw new Error(`shot ${shotId} not found`);

  const assetKind = kind === 'image' ? 'image' : 'video_clip';
  const cached = await assetsRepo.findByShotKind(shotId, assetKind);
  if (cached) {
    phase('WORKER', 'cached', ` asset=${cached.id}`);
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

  // The per-key concurrency slot is acquired INSIDE withKeySlot below (one pool
  // per key, so we can run a job on whichever key has a free slot) and released
  // the moment the provider job completes — download/upload happen off-slot.
  // Persist the provider job id the instant it's known so a mid-poll crash
  // leaves a reapable record, and track it for shutdown cancellation. 69labs
  // can re-queue a generation under a NEW id mid-poll; we track every id this
  // shot has lived under so shutdown/cleanup cancels the live one, not just the
  // original (cancelling a stale id leaks a provider concurrency slot).
  const seg = kind === 'image' ? ('images' as const) : ('videos' as const);
  const myJobIds = new Set<string>();
  let providerJobId: string | undefined;
  const trackJob = (id: string) => {
    providerJobId = id;
    myJobIds.add(id);
    inflight.set(id, seg);
  };
  const onSubmit = async (id: string) => {
    trackJob(id);
    // The job now lives at 69labs; everything until COMPLETED is loc=69LABS.
    phase('69LABS', 'submitted', ` job=${id}`);
    await generationsRepo.markStarted(generation.id, id);
  };
  // 69labs swapped in a new underlying job id (it re-queued the generation).
  const onJobId = (id: string) => {
    if (myJobIds.has(id)) return;
    trackJob(id);
    phase('69LABS', 'restarted', ` job=${id}`);
    // Point the generation row at the live job so the orphan reaper cancels it.
    void generationsRepo.markStarted(generation.id, id).catch(() => {});
  };
  // Each 69labs status transition (PENDING→PROCESSING→FINALIZING→…), tagged with
  // the live job id so a mid-poll restart is visible in the console.
  const onStatus = (status: string, id?: string) => {
    const jid = id ?? providerJobId;
    phase('69LABS', status, jid ? ` job=${jid}` : '');
  };
  try {
    await acquire(kind === 'image' ? '69labs.image' : '69labs.video');
    await generationsRepo.markStarted(generation.id);
    const t0 = Date.now();

    phase('WORKER', 'waiting_slot');
    // Run the whole submit→poll→download on whichever active key has a free slot
    // (one pool of PER_KEY_MAX per key), so two keys generate in parallel. Blocks
    // here until some key has a free slot; the lease is auto-reclaimed if this
    // worker crashes, and it's released the moment the provider job completes so
    // the download/upload below happen off-slot. On a key-attributable failure
    // (bad key, 402 no-credits, 429) withKeySlot rotates to another key and
    // re-runs this whole function — a fresh job under the new account — instead
    // of failing the shot. Content failures (CENSORED) are rethrown immediately
    // so we don't burn the pool on a doomed prompt. The provider job id changes
    // on a rotation; onSubmit/onJobId keep our tracking pointed at the live job.
    phase('WORKER', 'submitting');
    const result = await withKeySlot(
      '69labs',
      async (apiKey, keyId) => {
        // Per-key hourly quota: 69labs allows 100 images / 40 videos per hour
        // PER KEY, and with concurrency=2 that's the BINDING cap (sustained
        // generation would otherwise exceed it). Charge one token to THIS key's
        // hourly bucket before submitting; blocks here if the key has spent its
        // hour. Bucketed per key, so two keys give 200/80 an hour and a disabled
        // key only drops its own share. (Held under the key's concurrency slot —
        // fine: other jobs on a spent key would be hour-blocked too.)
        await acquire(`${target}.hourly`, 1, `${target}.hourly:${keyId}`);
        return kind === 'image'
          ? labs69.image({
            prompt: prompt.promptText,
            negative: prompt.negative ?? undefined,
            onStatus,
            // Full HD target: 2k (~2048×1152) is the smallest 69labs tier that
            // fully covers a 1920×1080 frame, so it downscales to crisp Full HD
            // (1k is sub-1080p and would be upscaled). nano-banana models
            // accept 1k|2k|4k; override via LABS69_IMAGE_RESOLUTION.
            aspectRatio: '16:9',
            resolution: process.env.LABS69_IMAGE_RESOLUTION ?? '2k',
            onSubmit,
            onJobId,
            apiKey,
          })
          : labs69.video({
            prompt: prompt.promptText,
            negative: prompt.negative ?? undefined,
            durationS: Number(shot.durationS),
            // Intentionally NOT passing aspectRatio / resolution — the
            // default 69labs video model (Veo 3.1 Lite) rejects both with
            // 400. Output is native 16:9 at the model's chosen size and
            // gets scaled to the project's targetRes in the final encode.
            onSubmit,
            onJobId,
            onStatus,
            apiKey,
          });
      },
      {
        perKeyMax: PER_KEY_MAX,
        leaseMs: kind === 'image' ? 12 * 60_000 : 15 * 60_000,
        // Redis-backed slot pools, one per key: `cc:69labs.image:<keyId>`.
        tryAcquireSlot,
        slotKeyFor: (keyId) => `${target}:${keyId}`,
        // Until the api_keys table is populated, fall back to the legacy env key
        // so labs jobs keep working exactly as before (safe incremental rollout).
        fallbackKey: process.env.LABS69_API_KEY,
      },
    );

    // Back in the worker: COMPLETED at 69labs, now pulling + storing the bytes.
    phase('WORKER', 'downloading');
    const ext = kind === 'image' ? 'png' : 'mp4';
    const tmp = await downloadToTmp(result.url, `labs_${shotId}.${ext}`);
    phase('WORKER', 'uploading');
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
    phase('WORKER', 'done', ` asset=${asset.id}`);
    await eventsRepo.emit(projectId, 'labs', 'succeeded', { shotId, kind });
    return { assetId: asset.id };
  } catch (err) {
    const message = (err as Error).message;
    phase('WORKER', 'failed', ` err=${message}`);
    await generationsRepo.markFailed(generation.id, { message });
    log.error({ shotId, err }, '69labs failed');
    // Surface the 69labs failure to the browser: this worker runs on Fly.io so
    // its logs never reach the operator's console. Emit a project event the web
    // app polls (/events) and re-logs in the browser console. Best-effort — a
    // failed emit must not mask the original generation error.
    await eventsRepo
      .emit(projectId, 'labs', 'failed', { shotId, kind, message, providerJobId })
      .catch((e) => log.warn({ shotId, e }, 'failed to emit labs/failed event'));
    throw err;
  } finally {
    // labs69.image/video already cancels the provider job(s) on failure, so by
    // here they're either done or cancelled — drop every id this shot lived
    // under from the in-flight set. The per-key concurrency slot was already
    // released inside withKeySlot when the provider job completed.
    for (const id of myJobIds) inflight.delete(id);
  }
}

// Two independent workers, one per 69labs feature, so image and video generate
// on separate tracks: a backlog of slow video jobs can never head-of-line block
// image jobs (or vice versa). BullMQ concurrency is just the PULL cap (≈ keys ×
// per-key slots) so enough jobs are in hand to fill every key's pool — the real
// cross-process limit is the per-key slot pools inside withKeySlot. Jobs pulled
// beyond free slots park in withKeySlot's wait loop holding only a BullMQ lock
// (no download buffer until a slot opens), so peak RAM ~= IMAGE_MAX + VIDEO_MAX.
new Worker('labsImage', processShot, { connection, concurrency: IMAGE_MAX });
new Worker('labsVideo', processShot, { connection, concurrency: VIDEO_MAX });

// On shutdown (incl. the `--watch` dev restart), cancel any in-flight 69labs
// jobs so they release their concurrency slots instead of orphaning and
// exhausting the cap. Best-effort, time-boxed so we don't hang the exit.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  const jobs = [...inflight.entries()];
  if (jobs.length) {
    log.warn({ signal, count: jobs.length }, 'cancelling in-flight 69labs jobs before exit');
    await Promise.race([
      Promise.allSettled(jobs.map(([id, kind]) => labs69.cancel(kind, id))),
      new Promise((r) => setTimeout(r, 5_000)),
    ]);
  }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

log.info(
  { perKeyMax: PER_KEY_MAX, maxKeys: MAX_KEYS, imagePull: IMAGE_MAX, videoPull: VIDEO_MAX },
  'labs-worker started (labsImage + labsVideo) — per-key slot pools',
);
