/**
 * Typed fetch wrappers for the EmberForge API. The API now lives in this
 * Next.js app under /api/v1/* (Route Handlers — see app/api/). Routes are
 * same-origin so no CORS / proxy plumbing is required.
 */
import type { ProjectStatus, VisualType, AssetKind } from '@emberforge/core';

const BASE = '/api';

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  // Fastify's application/json parser rejects empty bodies with 400. For
  // POST/PUT/PATCH calls that have nothing to send, default to '{}'.
  const method = (init?.method ?? 'GET').toUpperCase();
  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
  const finalInit: RequestInit = {
    headers: { 'content-type': 'application/json' },
    ...init,
    body: init?.body ?? (needsBody ? '{}' : undefined),
  };
  const res = await fetch(`${BASE}${path}`, finalInit);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${text ? ': ' + text : ''}`);
  }
  return res.json() as Promise<T>;
}

export interface Project {
  id: string;
  ownerId: string;
  title: string;
  status: ProjectStatus;
  stylePreset: string;
  targetRes: string;
  targetFps: number;
  createdAt: string;
  updatedAt: string;
}

export interface SceneWithShots {
  id: string;
  ordinal: number;
  title: string | null;
  narrationChunk: string;
  emotion: string | null;
  pacing: string | null;
  atmosphere: string | null;
  topic: string | null;
  estimatedDurS: string | null;
  shots: ShotWithAssets[];
}

export interface ShotWithAssets {
  id: string;
  sceneId: string;
  ordinal: number;
  narrationText: string;
  durationS: string;
  visualType: VisualType;
  visualSummary: string | null;
  cameraMovement: string | null;
  lens: string | null;
  fxRecommendation: Record<string, unknown> | null;
  transitionIn: string | null;
  transitionOut: string | null;
  soundtrackMood: string | null;
  status: 'pending' | 'partial' | 'ready';
  assets: {
    visual: { id: string; kind: AssetKind; r2Key: string; durationS: string | null } | null;
    narration: { id: string; durationS: string | null } | null;
  };
}

export interface Progress {
  status: ProjectStatus;
  shots: { total: number; ready: number; failed: number };
  cost: { totalUsd: number; byProvider: Record<string, { cost: number; count: number }> };
  updatedAt: string;
}

export interface ProjectEvent {
  id: number;
  projectId: string;
  stage: string;
  event: string;
  payload: Record<string, unknown> | null;
  ts: string;
}

export const api = {
  listProjects: () => http<{ projects: Project[] }>('/v1/projects'),

  getProject: (id: string) => http<Project>(`/v1/projects/${id}`),

  createProject: (input: { title: string; transcript: string; stylePreset?: string }) =>
    http<{ projectId: string; status: ProjectStatus }>('/v1/projects', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  getScenes: (id: string) => http<{ scenes: SceneWithShots[] }>(`/v1/projects/${id}/scenes`),

  getProgress: (id: string) => http<Progress>(`/v1/projects/${id}/progress`),

  getEvents: (id: string, since = 0) =>
    http<{ events: ProjectEvent[] }>(`/v1/projects/${id}/events?since=${since}`),

  getRenderUrl: (id: string) =>
    http<{ url: string; durationS: string | null; renderId: string }>(`/v1/projects/${id}/render-url`),

  getAssetUrl: (id: string) =>
    http<{ url: string; kind: AssetKind; durationS: string | null; bytes: number | null }>(`/v1/assets/${id}/url`),

  replayStage: (id: string, stage: string) =>
    http<{ ok: boolean }>(`/v1/projects/${id}/replay/${stage}`, { method: 'POST' }),

  // Partial update for editable project fields (style preset, title, etc.).
  updateProject: (
    id: string,
    patch: { title?: string; stylePreset?: string; targetRes?: '1920x1080' | '3840x2160'; targetFps?: 24 | 30 | 60 },
  ) =>
    http<Project>(`/v1/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  // Phase 2 — kicks off classify + prompt after the user has reviewed scenes.
  planShots: (id: string) =>
    http<{ ok: boolean; projectId: string }>(`/v1/projects/${id}/plan-shots`, { method: 'POST' }),

  // Phase 3 — kicks off per-shot 69labs/Veo 3/TTS fan-out after the user has
  // reviewed shot prompts.
  generateAssets: (id: string) =>
    http<{ ok: boolean; projectId: string }>(`/v1/projects/${id}/generate-assets`, { method: 'POST' }),

  // Phase 4 — kicks off timeline build + render + publish after the user has
  // reviewed every generated asset.
  startRender: (id: string) =>
    http<{ ok: boolean; projectId: string }>(`/v1/projects/${id}/render`, { method: 'POST' }),

  // Prompt overrides — used by the Studio shot editor so the operator can
  // tweak the generated prompt before paying to regenerate the asset.
  getShotPrompts: (shotId: string) =>
    http<{ shotId: string; prompts: ShotPrompt[] }>(`/v1/shots/${shotId}/prompts`),

  updatePrompt: (id: string, patch: { promptText?: string; negative?: string | null }) =>
    http<ShotPrompt>(`/v1/prompts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
};

export interface ShotPrompt {
  id: string;
  shotId: string;
  target: string;
  promptText: string;
  negative: string | null;
  params: Record<string, unknown> | null;
  inputHash: string;
  createdAt: string;
}
