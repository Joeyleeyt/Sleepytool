import type { GenStatus } from '../enums.js';

export type GenerationProvider = 'veo3' | '69labs.image' | '69labs.video' | '69labs.tts' | '69labs.lipsync' | 'remotion';

export interface Prompt {
  id: string;
  shotId: string;
  target: GenerationProvider;
  promptText: string;
  negative: string | null;
  seed: number | null;
  params: Record<string, unknown>;
  inputHash: string;
  createdAt: Date;
}

export interface Generation {
  id: string;
  promptId: string;
  provider: GenerationProvider;
  providerJobId: string | null;
  status: GenStatus;
  attempt: number;
  costUsd: number | null;
  latencyMs: number | null;
  error: Record<string, unknown> | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}
