import pino from 'pino';
import { Worker } from 'bullmq';
import { workerOpts, connection } from '@emberforge/queue';
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
import { startRenderAutoscaler } from './renderAutoscaler.js';

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
    workerOpts({ concurrency: 2 }),
  ),

  // Phases are user-gated and sequential — prompt then narrationTiming run one
  // after another per project, never as a wide fan-out. concurrency 2 covers a
  // couple of concurrent projects; more just idles.
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
    workerOpts({ concurrency: 2 }),
  ),

  new Worker(
    'orchestrator',
    async (job) => {
      // 'assetsReady' is a parent-with-children placeholder; its body is empty
      // — it only succeeds when all its child generation jobs succeed. New
      // flows route the parent to the dedicated 'assetsGate' queue (below);
      // this branch stays only for in-flight parents enqueued before that
      // change, so they still complete after a deploy.
      if (job.data.stage === 'assetsReady') return { ok: true };
      if (job.data.stage === 'generateAssets') return generateAssetsStage(job.data.projectId);
      return null;
    },
    // Each generateAssets job BLOCKS (awaits waitUntilFinished) for the full
    // duration of its project's asset generation, holding a slot the whole time.
    // That wait is pure I/O idle — no CPU — so a high concurrency is cheap and
    // just bounds how many projects can be in the asset phase at once. The old
    // value of 3 meant a few stuck projects pinned every slot and no further
    // generateAssets job could start (the "Generate assets button does nothing"
    // symptom). Override with ORCH_CONCURRENCY if needed.
    workerOpts({ concurrency: Math.max(3, Number(process.env.ORCH_CONCURRENCY ?? 25)) }),
  ),

  // Dedicated worker for the asset-generation completion gate. Kept OFF the
  // 'orchestrator' pool on purpose: the gate must be free to run the instant a
  // project's children finish, even while every orchestrator slot is occupied by
  // blocked generateAssets jobs. The body is a no-op — BullMQ only marks the job
  // completed once all its flow children have, which is the signal generateAssets
  // is awaiting. High concurrency because each run is instant.
  new Worker('assetsGate', async () => ({ ok: true }), workerOpts({ concurrency: 50 })),

  new Worker('timeline', async (job) => buildTimelineStage(job.data.projectId), workerOpts({ concurrency: 1 })),

  // 'audio' is a placeholder stage — the render-worker does the actual
  // audio mix inside its `encode` job. We still need a consumer here so
  // BullMQ marks the flow node complete and unblocks the next stage.
  new Worker('audio', async (job) => mixAudioStage(job.data.projectId), workerOpts({ concurrency: 1 })),

  // IMPORTANT: NO 'render' queue worker here. The render-worker
  // (apps/workers/render-worker) is the sole consumer of `render` jobs —
  // it owns ffmpeg + the heavy work. Adding one here would race with the
  // render-worker for jobs and the no-op version would win.

  new Worker('publish', async (job) => publishStage(job.data.projectId), { connection, concurrency: 1 }),
];

for (const w of workers) {
  w.on('completed', (job) => log.info({ queue: w.name, id: job.id }, 'job completed'));
  w.on('failed', (job, err) => log.error({ queue: w.name, id: job?.id, err: err.message }, 'job failed'));
}

log.info({ queues: workers.map((w) => w.name) }, 'orchestrator started');

// Hands-free render scaling: starts/stops a 2nd render machine off render queue
// depth so two long videos render at once, then scales back to one when idle.
// No-op unless RENDER_AUTOSCALE_ENABLED=true. Leader-locked so only one of the
// (possibly several) workers instances drives the Fly Machines API.
startRenderAutoscaler(log);
