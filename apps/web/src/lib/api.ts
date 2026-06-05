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
  status: 'pending' | 'partial' | 'ready' | 'failed';
  assets: {
    visual: { id: string; kind: AssetKind; r2Key: string; durationS: string | null } | null;
    narration: { id: string; durationS: string | null } | null;
  };
  /** Visual prompt (Veo3 / 69labs.video / 69labs.image) — null before
   *  Phase 2 (plan-shots) finishes. The TTS prompt is intentionally omitted
   *  because the narration text is already on the shot itself. */
  visualPrompt: { id: string; target: string; promptText: string; negative: string | null } | null;
  /** Latest failure per leg, only present when the asset hasn't landed and a
   *  prior generation failed all its BullMQ attempts. Drives the per-shot
   *  retry button on /board. */
  failures: {
    visual: { provider: string; message: string; finishedAt: string | null } | null;
    narration: { provider: string; message: string; finishedAt: string | null } | null;
  };
  /** Per-leg generation phase, derived server-side from the latest generation
   *  row. `queued` = sitting in the labs-worker queue (no provider job yet);
   *  `in_labs` = submitted to 69labs and rendering; `ready`/`failed` mirror the
   *  asset/failure state. Drives the per-shot "Queued" / "On 69Labs" pill. */
  progress: {
    visual: LegPhase;
    narration: LegPhase;
  };
}

export type LegPhase = 'queued' | 'in_labs' | 'ready' | 'failed';

export interface Progress {
  status: ProjectStatus;
  /** `ready` = both assets present; `failed` = shots blocked by a permanent
   *  leg failure; `resolved` = ready + failed (shots done generating either
   *  way) — drives the progress bar so a failure doesn't stall it short. */
  shots: { total: number; ready: number; failed: number; resolved: number };
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

  // Re-enqueue the leaf job(s) for a single shot. `legs` defaults to both.
  // Deletes the corresponding asset rows server-side so the worker's cache
  // miss → fresh generation.
  retryShot: (shotId: string, legs?: ('visual' | 'narration')[]) =>
    http<{ ok: boolean; shotId: string; enqueued: { leg: string; queue: string; name: string }[] }>(
      `/v1/shots/${shotId}/retry`,
      { method: 'POST', body: JSON.stringify(legs ? { legs } : {}) },
    ),

  // Prompt overrides — used by the Studio shot editor so the operator can
  // tweak the generated prompt before paying to regenerate the asset.
  getShotPrompts: (shotId: string) =>
    http<{ shotId: string; prompts: ShotPrompt[] }>(`/v1/shots/${shotId}/prompts`),

  updatePrompt: (id: string, patch: { promptText?: string; negative?: string | null }) =>
    http<ShotPrompt>(`/v1/prompts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  // ----- 69labs API key pool -----
  listKeys: () => http<{ keys: ApiKey[] }>('/v1/keys'),

  addKey: (input: { apiKey: string; label?: string }) =>
    http<{ id: string; fingerprint: string }>('/v1/keys', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  setKeyActive: (id: string, active: boolean) =>
    http<{ ok: boolean }>(`/v1/keys/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ action: active ? 'enable' : 'disable' }),
    }),

  deleteKey: (id: string) => http<{ ok: boolean }>(`/v1/keys/${id}`, { method: 'DELETE' }),
};

export interface ApiKey {
  id: string;
  provider: string;
  label: string | null;
  keyFingerprint: string;
  isActive: boolean;
  disabledReason: string | null;
  lastUsedAt: string | null;
  lastError: { message?: string; status?: number } | null;
  createdAt: string;
}

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
