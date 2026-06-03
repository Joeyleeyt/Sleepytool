import os from 'node:os';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { Worker } from 'bullmq';
import pino from 'pino';
import { connection } from '@emberforge/queue';
import {
  assetsRepo,
  db,
  eventsRepo,
  projectsRepo,
  schema,
  shotsRepo,
  timelinesRepo,
} from '@emberforge/db';
import { downloadToFile, r2Paths, uploadFile } from '@emberforge/storage';
import { buildAssSubtitles } from '@emberforge/timeline-engine';
import type { Timeline, TimelineClip } from '@emberforge/core';
import { mixClips, finalEncode, mixAudio, type KenBurnsMode, type MixSegment } from '@emberforge/render';

const log = pino({ name: 'render-worker' });

const WORK_DIR = process.env.RENDER_WORK_DIR ?? path.join(os.tmpdir(), 'emberforge');
const NVENC = (process.env.NVENC_ENABLED ?? 'true') === 'true';

const CPU_COUNT = Math.max(1, os.cpus()?.length ?? 4);
// Per-shot composites are independent, so we run several FFmpeg processes at
// once. Each libx264 process is itself multi-threaded, so we don't want one
// process per core (that oversubscribes); ~half the cores fills the pipeline
// (overlapping I/O + filter setup + encode) without thrashing. Overridable.
const SHOT_CONCURRENCY = Math.max(
  1,
  Number(process.env.RENDER_SHOT_CONCURRENCY ?? Math.min(8, Math.max(2, Math.ceil(CPU_COUNT / 2)))),
);
// How many mix segments to prepare at once (image Ken Burns encodes + video
// stream-copies). Same oversubscription reasoning as SHOT_CONCURRENCY — each
// ffmpeg is multi-threaded, so ~half the cores fills the pipeline. Separate
// knob so the mixer can be tuned independently; defaults to SHOT_CONCURRENCY.
const MIX_CONCURRENCY = Math.max(
  1,
  Number(process.env.RENDER_MIX_CONCURRENCY ?? SHOT_CONCURRENCY),
);
// Asset downloads are I/O-bound, so we can fan out wider than the encode pool.
const DOWNLOAD_CONCURRENCY = Math.max(1, Number(process.env.RENDER_DOWNLOAD_CONCURRENCY ?? 8));

/** Run `fn` over `items` with a bounded worker pool; results keep input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  };
  const pool = Math.min(Math.max(1, limit), items.length || 1);
  await Promise.all(Array.from({ length: pool }, () => worker()));
  return results;
}

async function localFor(key: string): Promise<string> {
  const out = path.join(WORK_DIR, key);
  await mkdir(path.dirname(out), { recursive: true });
  await downloadToFile(key, out);
  return out;
}

function cameraToKenBurns(camera: string): KenBurnsMode {
  switch (camera) {
    case 'ken_burns_in':
    case 'dolly_in':
    case 'macro_push':
    case 'aerial_descend':
      return 'in';
    case 'ken_burns_out':
    case 'dolly_out':
    case 'crane_up':
      return 'out';
    case 'orbit_left':
    case 'whip_pan':
      return 'left';
    case 'orbit_right':
      return 'right';
    case 'static':
    case 'handheld_drift':
    default:
      return 'in'; // gentle default
  }
}

async function runComposite(projectId: string) {
  const t0 = Date.now();
  log.info({ projectId }, '[composite] start');
  await eventsRepo.emit(projectId, 'composite', 'render_started');
  try {
    const project = await projectsRepo.findById(projectId);
    if (!project) throw new Error('project not found');
    const tlRow = await timelinesRepo.findByProject(projectId);
    if (!tlRow) throw new Error('timeline not built');
    const tl = (tlRow.edlJson as { clips: TimelineClip[]; musicBeds: Timeline['musicBeds'] }) as Timeline;
    tl.projectId = projectId;
    tl.totalDurationS = Number(tlRow.totalDurS);

    const shots = await shotsRepo.findByProject(projectId);
    const shotById = new Map(shots.map((s) => [s.id, s]));
    const assets = await assetsRepo.findByProject(projectId);
    const assetById = new Map(assets.map((a) => [a.id, a]));

    const [w, h] = project.targetRes.split('x').map(Number) as [number, number];

    log.info(
      {
        projectId,
        shots: tl.clips.length,
        targetRes: project.targetRes,
        fps: project.targetFps,
        nvenc: NVENC,
        shotConcurrency: SHOT_CONCURRENCY,
      },
      '[composite] compositing shots',
    );

    // Resolve each clip's shot/asset rows up front so the workers below only do
    // I/O + FFmpeg, not map lookups.
    const work = tl.clips.map((clip) => ({
      clip,
      shot: shotById.get(clip.shotId)!,
      video: assetById.get(clip.videoAssetId)!,
    }));

    // Prefetch every video/image asset in parallel BEFORE mixing, deduped by R2
    // key, so network latency overlaps instead of stalling each segment in-loop.
    // (Narration is fetched separately by the audio-mix stage.)
    const dlStart = Date.now();
    const uniqueKeys = Array.from(new Set(work.map((it) => it.video.r2Key)));
    const localByKey = new Map<string, string>();
    await mapLimit(uniqueKeys, DOWNLOAD_CONCURRENCY, async (key) => {
      localByKey.set(key, await localFor(key));
    });
    log.info(
      { projectId, assets: uniqueKeys.length, tookMs: Date.now() - dlStart },
      '[composite] assets prefetched',
    );

    // Build the ordered segment list. Inputs are already 1K/HD, so the mixer
    // only fits each clip/image to the target frame — no upscaling. Images get
    // Ken Burns motion; video clips are stream-copied with their own audio.
    const segments: MixSegment[] = work.map((it) => ({
      path: localByKey.get(it.video.r2Key)!,
      durationS: it.clip.endS - it.clip.startS,
      kenBurns: cameraToKenBurns(it.shot.cameraMovement ?? 'ken_burns_in'),
    }));

    // Mix video clips + images into one HD master in a single fast pass.
    log.info({ projectId, segments: segments.length }, '[composite] mixing clips');
    const mixStart = Date.now();
    const masterPath = path.join(WORK_DIR, projectId, 'composited_master.mp4');
    await mkdir(path.dirname(masterPath), { recursive: true });
    await mixClips({
      segments,
      outPath: masterPath,
      width: w,
      height: h,
      fps: project.targetFps,
      nvenc: NVENC,
      concurrency: MIX_CONCURRENCY,
    });
    await eventsRepo.emit(projectId, 'composite', 'shot_progress', {
      done: segments.length,
      total: segments.length,
    });
    log.info({ projectId, tookMs: Date.now() - mixStart }, '[composite] mix done');

    await projectsRepo.setStatus(projectId, 'composited');
    await eventsRepo.emit(projectId, 'composite', 'render_succeeded', {
      masterPath,
      totalMs: Date.now() - t0,
      shots: tl.clips.length,
    });
    log.info({ projectId, totalMs: Date.now() - t0 }, '[composite] done');
    return masterPath;
  } catch (err) {
    const e = err as { message?: string };
    log.error({ projectId, err: e.message }, '[composite] FAILED');
    await eventsRepo.emit(projectId, 'composite', 'render_failed', { message: e.message ?? String(err) });
    throw err;
  }
}

async function runAudioMix(projectId: string): Promise<string> {
  const t0 = Date.now();
  log.info({ projectId }, '[audioMix] start');
  await eventsRepo.emit(projectId, 'audio', 'render_started');
  try {
    const tlRow = await timelinesRepo.findByProject(projectId);
    if (!tlRow) throw new Error('timeline not built');
    const tl = tlRow.edlJson as { clips: TimelineClip[]; musicBeds: Timeline['musicBeds'] };
    const assets = await assetsRepo.findByProject(projectId);
    const assetById = new Map(assets.map((a) => [a.id, a]));

    log.info({ projectId, clips: tl.clips.length }, '[audioMix] downloading narration');
    const narration = await Promise.all(
      tl.clips.map(async (c) => ({
        path: await localFor(assetById.get(c.narrationAssetId)!.r2Key),
        startS: c.startS,
        durationS: c.endS - c.startS,
        gainDb: 0,
      })),
    );

    // Music beds — if the asset id is a `music:mood` placeholder, skip (real
    // implementation looks up a curated R2 bucket of mood beds).
    const music = [] as Awaited<ReturnType<typeof Promise.all<typeof narration>>>;

    const out = path.join(WORK_DIR, projectId, 'mixed.wav');
    await mkdir(path.dirname(out), { recursive: true });
    log.info({ projectId, narrationTracks: narration.length }, '[audioMix] mixing');
    await mixAudio({
      narration,
      music,
      totalDurS: Number(tlRow.totalDurS),
      outPath: out,
    });
    await eventsRepo.emit(projectId, 'audio', 'render_succeeded', {
      out,
      totalMs: Date.now() - t0,
      narrationTracks: narration.length,
    });
    log.info({ projectId, totalMs: Date.now() - t0 }, '[audioMix] done');
    return out;
  } catch (err) {
    const e = err as { message?: string };
    log.error({ projectId, err: e.message }, '[audioMix] FAILED');
    await eventsRepo.emit(projectId, 'audio', 'render_failed', { message: e.message ?? String(err) });
    throw err;
  }
}

async function runFinalEncode(projectId: string, masterVideo: string, masterAudio: string) {
  const t0 = Date.now();
  log.info({ projectId }, '[encode] start');
  await eventsRepo.emit(projectId, 'encode', 'render_started');
  try {
    const project = await projectsRepo.findById(projectId);
    if (!project) throw new Error('project not found');
    const tlRow = await timelinesRepo.findByProject(projectId);
    if (!tlRow) throw new Error('no timeline');
    const tl = tlRow.edlJson as { clips: TimelineClip[] };

    // Build subtitles
    const shots = await shotsRepo.findByProject(projectId);
    const narrationByClip = new Map<string, string>();
    for (const s of shots) narrationByClip.set(s.id, s.narrationText);
    const ass = buildAssSubtitles(
      { ...(tl as unknown as Timeline), projectId, totalDurationS: Number(tlRow.totalDurS) },
      narrationByClip,
    );

    const assPath = path.join(WORK_DIR, projectId, 'subs.ass');
    await writeFile(assPath, ass);

    // Upload the .ass subtitles as a sidecar — users can attach them in any
    // player. Burn-in is disabled by default (BURN_SUBTITLES=true to re-enable),
    // because ffmpeg's `subtitles=` filter fails on some Windows path setups.
    const burnSubs = (process.env.BURN_SUBTITLES ?? 'false') === 'true';
    try {
      const subKey = `${projectId}/renders/subs_v1.ass`;
      await uploadFile(assPath, subKey, 'text/x-ssa');
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'subtitle sidecar upload failed (non-fatal)');
    }

    const outPath = path.join(WORK_DIR, projectId, 'final.mp4');
    log.info(
      { projectId, res: project.targetRes, fps: project.targetFps, nvenc: NVENC, burnSubs },
      '[encode] ffmpeg final encode',
    );
    const encodeStart = Date.now();
    await finalEncode({
      videoPath: masterVideo,
      audioPath: masterAudio,
      subtitlesPath: burnSubs ? assPath : undefined,
      outPath,
      res: project.targetRes as '1920x1080' | '3840x2160',
      fps: project.targetFps as 24 | 30 | 60,
      nvenc: NVENC,
    });
    log.info({ projectId, tookMs: Date.now() - encodeStart }, '[encode] ffmpeg done; uploading');

    const key = r2Paths.finalRender(projectId, 1);
    const uploaded = await uploadFile(outPath, key, 'video/mp4');
    log.info({ projectId, r2Key: uploaded.key, bytes: uploaded.bytes }, '[encode] uploaded to R2');

    const [render] = await db
      .insert(schema.renders)
      .values({
        projectId,
        timelineId: tlRow.id,
        status: 'succeeded',
        r2Key: uploaded.key,
        durationS: tlRow.totalDurS,
        finishedAt: new Date(),
      })
      .returning();

    await projectsRepo.setStatus(projectId, 'encoded');
    await eventsRepo.emit(projectId, 'encode', 'render_succeeded', {
      renderId: render!.id,
      r2Key: uploaded.key,
      bytes: uploaded.bytes,
      totalMs: Date.now() - t0,
    });
    log.info({ projectId, totalMs: Date.now() - t0 }, '[encode] done');
    return render!;
  } catch (err) {
    const e = err as { message?: string };
    log.error({ projectId, err: e.message }, '[encode] FAILED');
    await eventsRepo.emit(projectId, 'encode', 'render_failed', { message: e.message ?? String(err) });
    throw err;
  }
}

const worker = new Worker(
  'render',
  async (job) => {
    const { projectId, stage } = job.data as { projectId: string; stage: 'composite' | 'encode' | 'audio' };
    log.info({ jobId: job.id, projectId, stage }, '[render] picked up job');
    switch (stage) {
      case 'composite': {
        return runComposite(projectId);
      }
      case 'audio': {
        return runAudioMix(projectId);
      }
      case 'encode': {
        // Both composite and audio mix should already be on disk; redo if
        // someone replays only the encode stage.
        const master = await runComposite(projectId);
        const audio = await runAudioMix(projectId);
        return runFinalEncode(projectId, master, audio);
      }
    }
  },
  { connection, concurrency: 1 },
);

worker.on('completed', (job) => {
  log.info({ jobId: job.id, stage: job.data?.stage }, '[render] job completed');
});
worker.on('failed', (job, err) => {
  log.error(
    { jobId: job?.id, stage: job?.data?.stage, err: err.message },
    '[render] job failed',
  );
});
worker.on('error', (err) => {
  log.error({ err: err.message }, '[render] worker error (connection / queue)');
});
worker.on('ready', () => {
  log.info('[render] worker connected to Redis and ready');
});

log.info({ workDir: WORK_DIR, nvenc: NVENC }, 'render-worker started');
