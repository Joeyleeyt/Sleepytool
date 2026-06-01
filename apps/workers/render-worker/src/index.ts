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
import { compositeShot, buildXfadeChain, finalEncode, mixAudio, type KenBurnsMode } from '@emberforge/render';
import { ffmpegXfade, transitionOverlapS } from '@emberforge/timeline-engine';

const log = pino({ name: 'render-worker' });

const WORK_DIR = process.env.RENDER_WORK_DIR ?? path.join(os.tmpdir(), 'emberforge');
const NVENC = (process.env.NVENC_ENABLED ?? 'true') === 'true';

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
    const shotOutputs: string[] = [];

    log.info(
      { projectId, shots: tl.clips.length, targetRes: project.targetRes, fps: project.targetFps, nvenc: NVENC },
      '[composite] compositing shots',
    );

    let shotIdx = 0;
    for (const clip of tl.clips) {
      const shot = shotById.get(clip.shotId)!;
      const video = assetById.get(clip.videoAssetId)!;
      const narration = assetById.get(clip.narrationAssetId)!;
      const shotStart = Date.now();

      const videoLocal = await localFor(video.r2Key);
      const narrationLocal = await localFor(narration.r2Key);
      const outPath = path.join(WORK_DIR, projectId, 'shots', `${shot.ordinal.toString().padStart(4, '0')}_${shot.id}.mp4`);
      await mkdir(path.dirname(outPath), { recursive: true });

      const fx = (shot.fxRecommendation ?? {}) as {
        embers?: 'off' | 'subtle' | 'medium' | 'heavy';
        smoke?: 'off' | 'low' | 'high';
        filmGrain?: number;
        vignette?: number;
      };

      await compositeShot({
        videoPath: videoLocal,
        narrationPath: narrationLocal,
        outPath,
        durationS: clip.endS - clip.startS,
        width: w,
        height: h,
        fps: project.targetFps,
        embers: fx.embers ?? 'medium',
        smoke: fx.smoke ?? 'off',
        grain: fx.filmGrain ?? 0.08,
        vignette: fx.vignette ?? 0.4,
        kenBurns: cameraToKenBurns(shot.cameraMovement ?? 'ken_burns_in'),
        nvenc: NVENC,
      });

      shotOutputs.push(outPath);
      shotIdx += 1;
      const tookMs = Date.now() - shotStart;
      log.info(
        { projectId, shot: `${shotIdx}/${tl.clips.length}`, durationS: clip.endS - clip.startS, tookMs },
        '[composite] shot done',
      );
      // Emit progress every 5 shots so the UI can show a live counter without
      // spamming the events table on long projects.
      if (shotIdx % 5 === 0 || shotIdx === tl.clips.length) {
        await eventsRepo.emit(projectId, 'composite', 'shot_progress', {
          done: shotIdx,
          total: tl.clips.length,
        });
      }
    }

    // xfade concat
    log.info({ projectId }, '[composite] xfade concat');
    const concatStart = Date.now();
    const masterPath = path.join(WORK_DIR, projectId, 'composited_master.mp4');
    await buildXfadeChain(
      tl.clips.map((c, i) => ({
        path: shotOutputs[i]!,
        durationS: c.endS - c.startS,
        xfade: ffmpegXfade(c.transitionIn),
        overlapS: transitionOverlapS(c.transitionIn),
      })),
      masterPath,
      { nvenc: NVENC },
    );
    log.info({ projectId, tookMs: Date.now() - concatStart }, '[composite] concat done');

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
