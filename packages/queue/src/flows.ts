import { FlowProducer } from 'bullmq';
import { connection } from './connection.js';

export const flowProducer = new FlowProducer({ connection });

/**
 * Tree A — runs automatically on project creation. Stops at `assets_ready`
 * so the user can review every generated image / video clip before paying
 * for the final render.
 *
 *   generateAssets
 *     └── prompt
 *           └── classify
 *                 └── segment
 *                       └── analyze
 */
export async function startAssetsFlow(projectId: string) {
  return flowProducer.add({
    name: 'generateAssets',
    queueName: 'orchestrator',
    data: { projectId, stage: 'generateAssets' },
    children: [
      {
        name: 'prompt',
        queueName: 'prompt',
        data: { projectId },
        children: [
          {
            name: 'classify',
            queueName: 'analysis',
            data: { projectId, stage: 'classify' },
            children: [
              {
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
              },
            ],
          },
        ],
      },
    ],
  });
}

/**
 * Tree B — runs only when the user clicks Render after reviewing assets.
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
