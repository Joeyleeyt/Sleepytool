import { FlowProducer } from 'bullmq';
import { getConnection } from './connection.js';

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
 *     └── classify
 */
export async function startShotPlanningFlow(projectId: string) {
  return flowProducer.add({
    name: 'prompt',
    queueName: 'prompt',
    data: { projectId },
    children: [
      {
        name: 'classify',
        queueName: 'analysis',
        data: { projectId, stage: 'classify' },
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
 *     └── encode
 *           └── composite
 *                 └── mixAudio
 *                       └── buildTimeline
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
        children: [
          {
            name: 'composite',
            queueName: 'render',
            data: { projectId, stage: 'composite' },
            children: [
              {
                name: 'mixAudio',
                queueName: 'audio',
                data: { projectId },
                children: [
                  {
                    name: 'buildTimeline',
                    queueName: 'timeline',
                    data: { projectId },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
}
