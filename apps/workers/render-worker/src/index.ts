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
  await eventsRepo.emit(projectId, 'composite', 'render_started');
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

  for (const clip of tl.clips) {
    const shot = shotById.get(clip.shotId)!;
    const video = assetById.get(clip.videoAssetId)!;
    const narration = assetById.get(clip.narrationAssetId)!;

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
  }

  // xfade concat
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

  await eventsRepo.emit(projectId, 'composite', 'render_succeeded', { masterPath });
  return masterPath;
}

async function runAudioMix(projectId: string): Promise<string> {
  const tlRow = await timelinesRepo.findByProject(projectId);
  if (!tlRow) throw new Error('timeline not built');
  const tl = tlRow.edlJson as { clips: TimelineClip[]; musicBeds: Timeline['musicBeds'] };
  const assets = await assetsRepo.findByProject(projectId);
  const assetById = new Map(assets.map((a) => [a.id, a]));

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
  await mixAudio({
    narration,
    music,
    totalDurS: Number(tlRow.totalDurS),
    outPath: out,
  });
  return out;
}

async function runFinalEncode(projectId: string, masterVideo: string, masterAudio: string) {
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
  await finalEncode({
    videoPath: masterVideo,
    audioPath: masterAudio,
    subtitlesPath: burnSubs ? assPath : undefined,
    outPath,
    res: project.targetRes as '1920x1080' | '3840x2160',
    fps: project.targetFps as 24 | 30 | 60,
    nvenc: NVENC,
  });

  const key = r2Paths.finalRender(projectId, 1);
  const uploaded = await uploadFile(outPath, key, 'video/mp4');

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

  await eventsRepo.emit(projectId, 'encode', 'render_succeeded', { renderId: render!.id, r2Key: uploaded.key });
  return render!;
}

new Worker(
  'render',
  async (job) => {
    const { projectId, stage } = job.data as { projectId: string; stage: 'composite' | 'encode' | 'audio' };
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

log.info({ workDir: WORK_DIR, nvenc: NVENC }, 'render-worker started');
