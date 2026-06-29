import { FlowProducer } from 'bullmq';
import { getConnection } from './connection.js';
import { jobOptionsFor } from './queues.js';

// Lazy FlowProducer — opens its Redis connection on first use, not at
// module-load. See queues.ts for the same pattern + rationale.
let _flowProducer: FlowProducer | null = null;
function flow(): FlowProducer {
  if (!_flowProducer) _flowProducer = new FlowProducer({ connection: getConnection() });
  return _flowProducer;
}

// Back-compat export — transparent proxy so callers can keep writing
// `flowProducer.add(...)` without paying the connection cost at import.
export const flowProducer: FlowProducer = new Proxy({} as FlowProducer, {
  get(_target, prop, receiver) {
    return Reflect.get(flow(), prop, receiver);
  },
});

/**
 * The pipeline runs in four user-gated phases so the operator can review
 * intermediate state, tweak prompts/style, and avoid wasting AI spend on a
 * misclassified transcript.
 *
 *   Phase 1  POST /projects             startAnalysisFlow      → segmented
 *   Phase 2  POST /:id/plan-shots       startShotPlanningFlow  → prompted
 *   Phase 3  POST /:id/generate-assets  startGenerateAssetsFlow→ assets_ready
 *   Phase 4  POST /:id/render           startRenderFlow        → published
 */

/**
 * Phase 1 — runs automatically on project creation.
 *   segment
 *     └── analyze
 */
export async function startAnalysisFlow(projectId: string) {
  return flowProducer.add({
    name: 'segment',
    queueName: 'analysis',
    data: { projectId, stage: 'segment' },
    children: [
      {
        name: 'analyze',
        queueName: 'analysis',
        data: { projectId, stage: 'analyze' },
      },
    ],
  });
}

/**
 * Phase 2 — user-triggered after reviewing scenes.
 *   prompt
 *     └── narrationTiming      (NEW: per-scene 69labs TTS to measure real
 *           └── classify        durations, redistributed to shot.duration_s)
 *
 * narrationTiming runs after classify so the per-scene narration_chunk and
 * its constituent shot.narration_text rows exist to be measured. Its result
 * — measured per-scene seconds — is written back to scenes.estimated_dur_s
 * and proportionally to each shot's duration_s, so downstream prompt /
 * generate-assets / render see real timings instead of 150-wpm estimates.
 */
export async function startShotPlanningFlow(projectId: string) {
  return flowProducer.add({
    name: 'prompt',
    queueName: 'prompt',
    data: { projectId, stage: 'prompt' },
    children: [
      {
        name: 'narrationTiming',
        queueName: 'prompt',
        data: { projectId, stage: 'narrationTiming' },
        children: [
          {
            name: 'classify',
            queueName: 'analysis',
            data: { projectId, stage: 'classify' },
          },
        ],
      },
    ],
  });
}

/**
 * Phase 3 — user-triggered after reviewing shots + prompts. The
 * generateAssets stage handler internally fans out one job per shot per asset
 * type and blocks on its own children.
 */
export async function startGenerateAssetsFlow(projectId: string) {
  return flowProducer.add({
    name: 'generateAssets',
    queueName: 'orchestrator',
    data: { projectId, stage: 'generateAssets' },
  });
}

/**
 * Phase 4 — user-triggered after reviewing generated assets.
 *
 *   publish
 *     └── encode            (render-worker: composite + audio mix + final encode)
 *           └── mixAudio    (placeholder status node)
 *                 └── buildTimeline
 *
 * NOTE: there is deliberately NO separate `composite` child. The `encode` stage
 * already runs the composite internally (runComposite → runAudioMix →
 * finalEncode), and runComposite is not on-disk-idempotent, so a separate
 * composite child would just do the full ~9GB download + image-encode + concat
 * a SECOND time before encode redoes it. The composite stage is still
 * independently runnable via the replay endpoint when debugging.
 */
export async function startRenderFlow(projectId: string) {
  return flowProducer.add({
    name: 'publish',
    queueName: 'publish',
    data: { projectId },
    children: [
      {
        name: 'encode',
        queueName: 'render',
        data: { projectId, stage: 'encode' },
        // Encode is the multi-hour render. It used to have no retry, so a single
        // transient fault near the end (e.g. a Redis/R2 connection blip, the
        // EMAXCONN we hit) discarded the whole job and required a manual
        // re-trigger. The composite + audio stages are now resume-safe (they
        // reuse a valid master/mix on disk), so a retry is cheap — it skips
        // straight back to the failed step. Auto-retry transient faults with a
        // generous backoff instead of dying.
        opts: { attempts: 3, backoff: { type: 'exponential', delay: 60_000 } },
        children: [
          {
            name: 'mixAudio',
            queueName: 'audio',
            data: { projectId },
            // Flow children default to attempts:1 — BullMQ does NOT apply a
            // queue's defaultJobOptions to flow leaves. Pull the queue's retry
            // opts in explicitly so a transient fault (e.g. the EMAXCONN pooler
            // burst that discarded a whole render) retries instead of failing
            // the parent and aborting the flow. Both stages are resume-safe.
            opts: jobOptionsFor('audio'),
            children: [
              {
                name: 'buildTimeline',
                queueName: 'timeline',
                data: { projectId },
                opts: jobOptionsFor('timeline'),
              },
            ],
          },
        ],
      },
    ],
  });
}
