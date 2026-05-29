import { request } from 'undici';
import { withRetry } from './retry.js';

const BASE = process.env.VEO3_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta';
const KEY = process.env.VEO3_API_KEY ?? '';

export interface Veo3GenerateInput {
  prompt: string;
  negative?: string;
  durationS?: number;        // 5..15
  resolution?: '1080p' | '4k';
  aspectRatio?: '16:9' | '9:16' | '1:1';
  seed?: number;
}

export interface Veo3Result {
  videoUrl: string;
  durationS: number;
  costUsd: number;
  providerJobId: string;
}

/**
 * Veo 3 is async: submit a generation, poll until done, return signed URL.
 * Endpoint shapes are intentionally provider-stubbed — wire to the actual
 * Google Generative Language / Vertex Veo endpoint your team is using.
 */
export async function generateVideo(input: Veo3GenerateInput): Promise<Veo3Result> {
  return withRetry(async () => {
    const submit = await request(`${BASE}/models/veo-3:generateVideo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify({
        prompt: input.prompt,
        negativePrompt: input.negative,
        videoConfig: {
          durationSec: input.durationS ?? 8,
          aspectRatio: input.aspectRatio ?? '16:9',
          resolution: input.resolution ?? '1080p',
          seed: input.seed,
        },
      }),
    });
    if (submit.statusCode >= 400) throw Object.assign(new Error(`veo3 submit ${submit.statusCode}`), { status: submit.statusCode });
    const { name } = (await submit.body.json()) as { name: string };

    const start = Date.now();
    const timeoutMs = 10 * 60 * 1000;
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 4000));
      const poll = await request(`${BASE}/${name}`, { headers: { 'x-goog-api-key': KEY } });
      if (poll.statusCode >= 400) throw Object.assign(new Error('veo3 poll'), { status: poll.statusCode });
      const body = (await poll.body.json()) as {
        done?: boolean;
        response?: { videoUri: string; durationSec: number; usage?: { cost?: number } };
        error?: { message: string };
      };
      if (body.error) throw new Error(`veo3: ${body.error.message}`);
      if (body.done && body.response) {
        return {
          videoUrl: body.response.videoUri,
          durationS: body.response.durationSec,
          costUsd: body.response.usage?.cost ?? estimateCost(input.durationS ?? 8, input.resolution ?? '1080p'),
          providerJobId: name,
        };
      }
    }
    throw new Error('veo3 timeout');
  });
}

function estimateCost(durationS: number, resolution: '1080p' | '4k'): number {
  const perSec = resolution === '4k' ? 0.35 : 0.15;
  return durationS * perSec;
}
