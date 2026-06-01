import pino from 'pino';
import { Worker } from 'bullmq';
import { connection } from '@emberforge/queue';
import { analyzeStage } from './stages/analyze.js';
import { segmentStage } from './stages/segment.js';
import { classifyStage } from './stages/classify.js';
import { deterministicSegmentStage } from './stages/deterministicSegment.js';
import { narrationTimingStage } from './stages/narrationTiming.js';
import { promptStage } from './stages/prompt.js';
import { generateAssetsStage } from './stages/generateAssets.js';
import { buildTimelineStage } from './stages/buildTimeline.js';
import { mixAudioStage } from './stages/mixAudio.js';
import { publishStage } from './stages/publish.js';
import { eventsRepo, projectsRepo } from '@emberforge/db';

const log = pino({ name: 'orchestrator' });

// LLM_PROVIDER=none → labs-only mode: skip analyze + segment + classify
// (all driven by Claude) and run a single deterministic segment-and-classify
// pass instead. Everything downstream is identical.
const LLM_PROVIDER = process.env.LLM_PROVIDER ?? 'claude';
const NO_LLM = LLM_PROVIDER === 'none';

log.info({ LLM_PROVIDER }, NO_LLM ? 'orchestrator booting in LABS-ONLY mode (no LLM)' : 'orchestrator booting in LLM mode');

const workers = [
  new Worker(
    'analysis',
    async (job) => {
      const { projectId, stage } = job.data as { projectId: string; stage: string };
      if (NO_LLM) {
        // In labs-only mode, run deterministic segmentation once (on the
        // 'analyze' job) and no-op the other two.
        switch (stage) {
          case 'analyze':
            await eventsRepo.emit(projectId, 'analyze', 'skipped_no_llm');
            await projectsRepo.setStatus(projectId, 'analyzed');
            return { skipped: true };
          case 'segment':
            return deterministicSegmentStage(projectId);
          case 'classify':
            // already done by deterministicSegmentStage
            await projectsRepo.setStatus(projectId, 'classified');
            return { skipped: true };
          default:
            throw new Error(`unknown analysis stage ${stage}`);
        }
      }
      switch (stage) {
        case 'analyze':
          return analyzeStage(projectId);
        case 'segment':
          return segmentStage(projectId);
        case 'classify':
          return classifyStage(projectId);
        default:
          throw new Error(`unknown analysis stage ${stage}`);
      }
    },
    { connection, concurrency: 2 },
  ),

  new Worker(
    'prompt',
    async (job) => {
      const { projectId, stage } = job.data as { projectId: string; stage?: string };
      // Default to 'prompt' so existing single-stage jobs (replay endpoint,
      // any in-flight items from before the schema change) keep working.
      switch (stage ?? 'prompt') {
        case 'narrationTiming':
          return narrationTimingStage(projectId);
        case 'prompt':
          return promptStage(projectId);
        default:
          throw new Error(`unknown prompt stage ${stage}`);
      }
    },
    { connection, concurrency: 4 },
  ),

  new Worker(
    'orchestrator',
    async (job) => {
      // 'assetsReady' is a parent-with-children placeholder; its body is empty
      // — it only succeeds when all its child generation jobs succeed.
      if (job.data.stage === 'assetsReady') return { ok: true };
      if (job.data.stage === 'generateAssets') return generateAssetsStage(job.data.projectId);
      return null;
    },
    // Concurrency must be ≥ max concurrent projects, because generateAssets
    // blocks for the full duration of asset generation.
    { connection, concurrency: 8 },
  ),

  new Worker('timeline', async (job) => buildTimelineStage(job.data.projectId), { connection, concurrency: 2 }),

  // 'audio' is a placeholder stage — the render-worker does the actual
  // audio mix inside its `encode` job. We still need a consumer here so
  // BullMQ marks the flow node complete and unblocks the next stage.
  new Worker('audio', async (job) => mixAudioStage(job.data.projectId), { connection, concurrency: 1 }),

  // IMPORTANT: NO 'render' queue worker here. The render-worker
  // (apps/workers/render-worker) is the sole consumer of `render` jobs —
  // it owns ffmpeg + the heavy work. Adding one here would race with the
  // render-worker for jobs and the no-op version would win.

  new Worker('publish', async (job) => publishStage(job.data.projectId), { connection, concurrency: 2 }),
];

for (const w of workers) {
  w.on('completed', (job) => log.info({ queue: w.name, id: job.id }, 'job completed'));
  w.on('failed', (job, err) => log.error({ queue: w.name, id: job?.id, err: err.message }, 'job failed'));
}

log.info({ queues: workers.map((w) => w.name) }, 'orchestrator started');
