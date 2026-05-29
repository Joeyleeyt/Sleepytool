/**
 * Typed fetch wrappers for the EmberForge API. All calls go through
 * /api/ef/* which is rewritten to the API host (see next.config.mjs).
 */
import type { ProjectStatus, VisualType, AssetKind } from '@emberforge/core';

const BASE = '/api/ef';

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

  startRender: (id: string) =>
    http<{ ok: boolean; projectId: string }>(`/v1/projects/${id}/render`, { method: 'POST' }),
};
