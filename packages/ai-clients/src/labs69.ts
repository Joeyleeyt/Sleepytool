/**
 * 69labs.vip API client.
 *
 * All endpoints follow the same async pattern:
 *   1. POST /<kind>/generate  → returns { id, queuePosition }
 *   2. Poll GET /<kind>/status/:id  → status: PENDING|PROCESSING|FINALIZING|COMPLETED|FAILED|CANCELLED|CENSORED
 *   3. GET /<kind>/download/:id  → returns 302 redirect to a presigned R2 URL
 *
 * Auth: `Authorization: Bearer vk_...`
 *
 * We expose a synchronous-looking surface (`labs69.image({...})`) that
 * internally does the full submit → poll → resolve-redirect dance and returns
 * a `{ url, providerJobId, durationS? }` shape so the workers stay unchanged.
 */
import { Agent, setGlobalDispatcher } from 'undici';
import { withRetry } from './retry.js';

const BASE = process.env.LABS69_BASE_URL ?? 'https://69labs.vip/api/v1';
const KEY = process.env.LABS69_API_KEY ?? '';
const DEFAULT_VOICE = process.env.LABS69_VOICE_ID ?? '';

// Node's default fetch connect timeout (10s) is too short when many parallel
// workers hit 69labs. Bump it once for the process.
setGlobalDispatcher(
  new Agent({
    connect: { timeout: 60_000 }, // 60s to establish TCP/TLS
    headersTimeout: 90_000,        // 90s waiting for response headers
    bodyTimeout: 5 * 60_000,       // 5min for body download (videos)
  }),
);

/**
 * Per-call request context. Lets the caller (the key manager) supply the API
 * key and base URL for a single generation so multiple keys can be rotated
 * without redeploying. Both fall back to the module-level env defaults, so
 * existing callers that pass nothing keep working unchanged.
 */
export interface Labs69Ctx {
  apiKey?: string;
  baseUrl?: string;
}

const AUTH = (ctx?: Labs69Ctx) => ({ Authorization: `Bearer ${ctx?.apiKey ?? KEY}` });
const baseUrl = (ctx?: Labs69Ctx) => ctx?.baseUrl ?? BASE;

// Per docs, recommended polling intervals: TTS 2-5s, images 3-5s, videos 5-10s.
const POLL_INTERVAL_MS = 3_000;            // default (image / TTS)
const VIDEO_POLL_INTERVAL_MS = 6_000;      // per docs recommendation
const POLL_TIMEOUT_MS = 10 * 60 * 1000;    // 10 min hard ceiling

// Restart-loop guard. 69labs sometimes re-queues a generation on its own side:
// the status URL we keep polling regresses (e.g. PROCESSING → PENDING) and the
// underlying job id changes. Such a job rarely converges, yet without a guard we
// hold a provider concurrency slot until the full POLL_TIMEOUT_MS ceiling.
//   • after the FIRST restart we shrink the remaining window to RESTART_GRACE_MS
//     so a post-restart hang bails in minutes, not 10 min;
//   • after MAX_PROVIDER_RESTARTS restarts we bail immediately (it's flapping).
const RESTART_GRACE_MS = Number(process.env.LABS69_RESTART_GRACE_MS ?? 3 * 60 * 1000);
const MAX_PROVIDER_RESTARTS = Math.max(1, Number(process.env.LABS69_MAX_RESTARTS ?? 2));

// Monotonic progression of a healthy job. A status whose rank is BELOW one the
// job already reached means 69labs restarted it. Unknown statuses rank -1 and
// never trigger the regression check on their own.
const STATUS_RANK: Record<string, number> = {
  PENDING: 0,
  PROCESSING: 1,
  FINALIZING: 2,
  COMPLETED: 3,
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type JobStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'FINALIZING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'CENSORED';

interface JobCreate {
  id: string;
  status?: JobStatus;
  queuePosition?: number;
}

interface JobStatusResp {
  id: string;
  status: JobStatus;
  createdAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  outputMetadata?: {
    format?: string;
    width?: number;
    height?: number;
    durationSeconds?: number;
  };
  // Failure detail when status is FAILED/CENSORED. 69labs hasn't documented a
  // single field name and has used several over time, so we probe them all in
  // `failureDetail()` rather than rely on one. `error` is sometimes a string,
  // sometimes an object with a nested `.message`.
  error?: string | { message?: string; code?: string | number };
  errorMessage?: string;
  failureReason?: string;
  message?: string;
  reason?: string;
  detail?: string;
  // The field 69labs actually populates on a FAILED/CENSORED video job — a
  // human-readable, end-user-facing reason (e.g. the celebrity/likeness block).
  // Listed first in failureDetail() since it's the most reliable in practice.
  userMessage?: string;
  // TTS-specific
  chunksTotal?: number;
  chunksCompleted?: number;
  blockedChunks?: { index: number; text: string }[];
}

interface BaseResult {
  /** Presigned URL the worker should download (resolved from the 302). */
  url: string;
  /** The 69labs job id, kept for traceability. */
  providerJobId: string;
  /** Optional duration in seconds (for video/audio). */
  durationS?: number;
  metadata?: Record<string, unknown>;
}

function parseRetryAfter(res: Response): number | undefined {
  const v = res.headers.get('retry-after');
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  // HTTP-date form is rare on 69labs; ignore.
  return undefined;
}

// First non-empty string among the given candidates. Handles the common
// provider shapes where a field is either a plain string ("Insufficient
// credits") or an object carrying a nested `.message`. Used to dig the
// human-readable reason out of 69labs failure payloads and JSON error bodies.
function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v && typeof v === 'object') {
      const m = (v as { message?: unknown }).message;
      if (typeof m === 'string' && m.trim()) return m.trim();
    }
  }
  return undefined;
}

// Pull the reason 69labs gives for a FAILED/CENSORED job out of the status
// payload so it reaches the operator instead of a bare "FAILED". The field name
// is undocumented and has varied, so probe every shape we've seen.
function failureDetail(s: JobStatusResp): string | undefined {
  return firstString(
    s.userMessage,
    s.error,
    s.errorMessage,
    s.failureReason,
    s.message,
    s.reason,
    s.detail,
  );
}

// Error responses from the edge (Cloudflare 5xx, nginx 502) are full HTML
// pages — dumping them verbatim into an Error message floods the worker logs
// with hundreds of unreadable lines. Collapse an HTML body to just its <title>
// (e.g. "69labs.vip | 522: Connection timed out") and cap everything else.
function summarizeBody(text: string, max = 300): string {
  const trimmed = text.trim();
  if (!trimmed) return '(empty body)';
  if (/^<(?:!doctype|html|\?xml)/i.test(trimmed)) {
    const title = trimmed.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim();
    return title ? `<html: ${title}>` : '<html error page>';
  }
  // JSON error bodies: surface the human-readable field (e.g. "Insufficient
  // credits") rather than the raw object, so the operator sees the reason and
  // not {"error":{"message":"…","code":402}}.
  if (/^[[{]/.test(trimmed)) {
    try {
      const j = JSON.parse(trimmed) as Record<string, unknown>;
      const msg = firstString(j.userMessage, j.error, j.errorMessage, j.message, j.detail, j.reason);
      if (msg) return msg.length > max ? `${msg.slice(0, max)}…` : msg;
    } catch {
      // Leading [ or { but not valid JSON — fall through to raw truncation.
    }
  }
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

async function httpError(path: string, res: Response): Promise<Error> {
  const text = await res.text().catch(() => '');
  return Object.assign(new Error(`69labs ${path} ${res.status}: ${summarizeBody(text)}`), {
    status: res.status,
    retryAfterMs: parseRetryAfter(res),
  });
}

async function postJson<T>(path: string, body: unknown, ctx?: Labs69Ctx): Promise<T> {
  return withRetry(async () => {
    const res = await fetch(`${baseUrl(ctx)}${path}`, {
      method: 'POST',
      headers: { ...AUTH(ctx), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await httpError(path, res);
    return (await res.json()) as T;
  });
}

async function getJson<T>(path: string, ctx?: Labs69Ctx): Promise<T> {
  return withRetry(async () => {
    const res = await fetch(`${baseUrl(ctx)}${path}`, { headers: AUTH(ctx) });
    if (!res.ok) throw await httpError(path, res);
    return (await res.json()) as T;
  });
}

/**
 * Poll job status until it leaves the in-flight set or the timeout fires.
 *
 * `onJobId` fires for every DISTINCT provider job id the status endpoint
 * reports — the first one plus any 69labs swaps in when it re-queues the
 * generation. The caller uses it to cancel whichever id is actually live
 * (cancelling the original `create.id` after a restart leaks a slot), and the
 * worker uses it to keep its in-flight/cancel tracking pointed at the real job.
 */
async function pollUntilDone(
  statusPath: string,
  intervalMs: number = POLL_INTERVAL_MS,
  onStatus?: (status: JobStatus, jobId?: string) => void,
  onJobId?: (jobId: string) => void,
  ctx?: Labs69Ctx,
): Promise<JobStatusResp> {
  let deadline = Date.now() + POLL_TIMEOUT_MS;
  let last: JobStatus | undefined;
  let lastId: string | undefined;
  let maxRank = -1;
  let restarts = 0;
  let graceApplied = false;
  while (Date.now() < deadline) {
    const s = await getJson<JobStatusResp>(statusPath, ctx);

    // Surface each new underlying job id so the caller can cancel the live one.
    if (s.id && s.id !== lastId) onJobId?.(s.id);

    // Detect a 69labs-side restart: the job id changed mid-flight, or the
    // status fell below a stage it had already reached. Either is abnormal and
    // means the generation is looping rather than progressing.
    const rank = STATUS_RANK[s.status] ?? -1;
    const idChanged = !!lastId && !!s.id && s.id !== lastId;
    const statusRegressed = rank >= 0 && rank < maxRank;
    if (idChanged || statusRegressed) {
      restarts++;
      // First restart: shrink the remaining window so a post-restart hang
      // doesn't sit on a concurrency slot for the full 10-min ceiling.
      if (!graceApplied) {
        graceApplied = true;
        deadline = Math.min(deadline, Date.now() + RESTART_GRACE_MS);
      }
    }
    lastId = s.id ?? lastId;
    if (rank >= 0) maxRank = Math.max(maxRank, rank);

    // Notify only on transitions so the caller's log isn't spammed every poll.
    if (onStatus && s.status !== last) {
      last = s.status;
      onStatus(s.status, s.id);
    }

    if (s.status === 'COMPLETED') return s;
    if (s.status === 'FAILED' || s.status === 'CANCELLED') {
      // Attach 69labs' own reason so the operator sees WHY it failed on the
      // board/studio, not just the terminal state.
      const detail = failureDetail(s);
      throw new Error(`69labs job ${s.id} ${s.status}${detail ? `: ${detail}` : ''}`);
    }
    if (s.status === 'CENSORED') {
      const detail = failureDetail(s);
      throw new Error(
        `69labs job ${s.id} CENSORED${detail ? `: ${detail}` : ''} — manual rewrite required`,
      );
    }

    // Flapping past the tolerance → it won't converge, fail fast (retriable).
    if (restarts >= MAX_PROVIDER_RESTARTS) {
      throw new Error(
        `69labs kept restarting job ${s.id} (${restarts}×, status fell back to ${s.status}) — bailing before the ${POLL_TIMEOUT_MS / 1000}s ceiling`,
      );
    }

    await sleep(intervalMs);
  }
  throw new Error(
    graceApplied
      ? `69labs restarted job ${lastId ?? '?'} and it did not finish within ${RESTART_GRACE_MS / 1000}s of the restart`
      : `69labs poll timed out after ${POLL_TIMEOUT_MS / 1000}s`,
  );
}

/**
 * Resolve a download endpoint's 302 redirect to its final presigned URL.
 * We pass redirect: 'manual' so we can read the Location header without
 * also fetching the file bytes here.
 */
async function resolveDownloadUrl(downloadPath: string, ctx?: Labs69Ctx): Promise<string> {
  const res = await fetch(`${baseUrl(ctx)}${downloadPath}`, {
    method: 'GET',
    headers: AUTH(ctx),
    redirect: 'manual',
  });
  const location = res.headers.get('location');
  // Some runtimes auto-follow even with 'manual' on Cloudflare. In that case
  // res.url is the final URL.
  if (res.status >= 300 && res.status < 400 && location) return location;
  if (res.ok && res.url) return res.url;
  throw await httpError(downloadPath, res);
}

/**
 * Cancel an in-flight job so it stops occupying a provider concurrency slot.
 * Best-effort: a job that already reached a terminal state returns 404/400,
 * which we swallow. `kind` is the URL segment ('images' | 'videos').
 */
async function cancelJob(kind: string, id: string, ctx?: Labs69Ctx): Promise<void> {
  await fetch(`${baseUrl(ctx)}/${kind}/cancel/${id}`, { method: 'POST', headers: AUTH(ctx) }).catch(
    () => {},
  );
}

// ============ TTS ============

export interface TtsInput {
  text: string;
  voice?: string;             // alias for voiceId
  voiceId?: string;
  voiceProvider?: 'elevenlabs' | 'edgetts' | 'minimax';
  modelId?: string;
  pace?: 'slow' | 'medium' | 'fast'; // mapped to voiceSettings.speed
  apiKey?: string;
  baseUrl?: string;
}

const PACE_TO_SPEED: Record<'slow' | 'medium' | 'fast', number> = {
  slow: 0.85,
  medium: 1.0,
  fast: 1.15,
};

// ============ public surface ============

export const labs69 = {
  async tts(input: TtsInput): Promise<BaseResult & { durationS: number }> {
    const voiceId = input.voiceId ?? input.voice ?? DEFAULT_VOICE;
    if (!voiceId) throw new Error('labs69.tts: no voiceId (set LABS69_VOICE_ID)');

    const ctx: Labs69Ctx = { apiKey: input.apiKey, baseUrl: input.baseUrl };
    const create = await postJson<JobCreate>('/tts/generate', {
      text: input.text,
      voiceId,
      voiceProvider: input.voiceProvider ?? 'elevenlabs',
      modelId: input.modelId,
      voiceSettings: input.pace ? { speed: PACE_TO_SPEED[input.pace] } : undefined,
    }, ctx);
    // Track every job id seen so a failure-cancel hits the live job, not just
    // the original (a 69labs restart swaps the id and orphans the old slot).
    const seenIds = new Set<string>([create.id]);
    try {
      const done = await pollUntilDone(
        `/tts/status/${create.id}`,
        POLL_INTERVAL_MS,
        undefined,
        (id) => seenIds.add(id),
        ctx,
      );
      const url = await resolveDownloadUrl(`/tts/download/${create.id}`, ctx);
      return {
        url,
        providerJobId: create.id,
        // outputMetadata is optional on TTS; estimate duration from text if absent
        durationS: done.outputMetadata?.durationSeconds ?? estimateTtsDurationS(input.text),
        metadata: { chunksTotal: done.chunksTotal, format: done.outputMetadata?.format ?? 'mp3' },
      };
    } catch (err) {
      // Poll timeout / restart-loop / download error / CENSORED: cancel every
      // id we saw so we don't leak a concurrency slot. (FAILED/CANCELLED are
      // already terminal — cancel is a harmless no-op there.)
      await Promise.all([...seenIds].map((id) => cancelJob('tts', id, ctx)));
      throw err;
    }
  },

  async image(input: {
    prompt: string;
    negative?: string;             // accepted for API parity but not supported by 69labs
    model?: string;
    aspectRatio?: '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9';
    resolution?: '1k' | '2k' | '4k' | string;
    seed?: number;
    imageUrls?: string[];
    // Called the instant the job id is known (right after submit), before the
    // long poll. Lets the worker persist the id so an in-flight job can be
    // cancelled/reaped if this process dies mid-poll.
    onSubmit?: (jobId: string) => void | Promise<void>;
    // Called for every NEW provider job id seen while polling — i.e. the
    // original, plus any id 69labs swaps in when it re-queues the generation.
    onJobId?: (jobId: string) => void;
    // Called on each 69labs status transition (PENDING→PROCESSING→…) with the
    // current job id, so the caller can show where the job is at the provider.
    onStatus?: (status: JobStatus, jobId?: string) => void;
    // The API key + base URL to use for THIS generation. Supplied by the key
    // manager so a single submit→poll→download runs entirely under one account.
    // Omit to fall back to the LABS69_API_KEY / LABS69_BASE_URL env defaults.
    apiKey?: string;
    baseUrl?: string;
  }): Promise<BaseResult> {
    const ctx: Labs69Ctx = { apiKey: input.apiKey, baseUrl: input.baseUrl };
    const create = await postJson<JobCreate>('/images/generate', {
      prompt: input.prompt,
      model: input.model,
      aspectRatio: input.aspectRatio ?? '16:9',
      resolution: input.resolution,
      seed: input.seed,
      imageUrls: input.imageUrls,
    }, ctx);
    // Track every job id seen so failure-cancel hits the live job, not just the
    // original (a 69labs restart swaps the id and orphans the old slot).
    const seenIds = new Set<string>([create.id]);
    await input.onSubmit?.(create.id);
    try {
      const done = await pollUntilDone(
        `/images/status/${create.id}`,
        POLL_INTERVAL_MS,
        input.onStatus,
        (id) => {
          seenIds.add(id);
          input.onJobId?.(id);
        },
        ctx,
      );
      const url = await resolveDownloadUrl(`/images/download/${create.id}`, ctx);
      return {
        url,
        providerJobId: create.id,
        metadata: {
          format: done.outputMetadata?.format ?? 'png',
          width: done.outputMetadata?.width,
          height: done.outputMetadata?.height,
        },
      };
    } catch (err) {
      // Poll timeout / restart-loop / download error / CENSORED: cancel every
      // id we saw so we don't leak a concurrency slot. (FAILED/CANCELLED are
      // already terminal — cancel is a harmless no-op there.)
      await Promise.all([...seenIds].map((id) => cancelJob('images', id, ctx)));
      throw err;
    }
  },

  async video(input: {
    prompt: string;
    negative?: string;
    model?: string;
    aspectRatio?: '16:9' | '9:16' | '1:1';
    resolution?: string;
    durationS?: number;
    mode?: 'normal' | 'spicy' | 'fun';
    imageUrls?: string[];
    mute?: boolean;
    onSubmit?: (jobId: string) => void | Promise<void>;
    onJobId?: (jobId: string) => void;
    onStatus?: (status: JobStatus, jobId?: string) => void;
    apiKey?: string;
    baseUrl?: string;
  }): Promise<BaseResult & { durationS: number }> {
    const ctx: Labs69Ctx = { apiKey: input.apiKey, baseUrl: input.baseUrl };
    // 69labs `duration` field is a STRING like "5" / "10" — but their default
    // model (Veo 3.1 Lite) and several others reject it with 400
    // "does not support duration selection". Gate behind an env so we only
    // send it when the configured model is known to accept it.
    // Set LABS69_VIDEO_SEND_DURATION=true if you've pinned LABS69_VIDEO_MODEL
    // to a model that supports duration. Default off.
    // `??` doesn't short-circuit on empty strings, so coalesce manually —
    // empty LABS69_VIDEO_MODEL should mean "let 69labs pick the default",
    // not "send model=''" which some endpoints would reject.
    const envModel = process.env.LABS69_VIDEO_MODEL;
    const model = input.model || (envModel && envModel.trim().length > 0 ? envModel : undefined);
    const sendDuration =
      (process.env.LABS69_VIDEO_SEND_DURATION ?? 'false') === 'true' && input.durationS != null;
    // Per the 69labs model table: aspectRatio / resolution / mode / duration
    // each must be "valid for the model". Veo 3.1 Lite (`veo-video`) accepts
    // none of them. Only forward each field when the caller explicitly opted
    // in — otherwise let the model use its default.
    const create = await postJson<JobCreate>('/videos/generate', {
      prompt: input.prompt,
      model,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      duration: sendDuration ? String(Math.round(input.durationS!)) : undefined,
      mode: input.mode,
      imageUrls: input.imageUrls,
      mute: input.mute,
    }, ctx);
    const seenIds = new Set<string>([create.id]);
    await input.onSubmit?.(create.id);
    try {
      const done = await pollUntilDone(
        `/videos/status/${create.id}`,
        VIDEO_POLL_INTERVAL_MS,
        input.onStatus,
        (id) => {
          seenIds.add(id);
          input.onJobId?.(id);
        },
        ctx,
      );
      const url = await resolveDownloadUrl(`/videos/download/${create.id}`, ctx);
      return {
        url,
        providerJobId: create.id,
        durationS: done.outputMetadata?.durationSeconds ?? (input.durationS ?? 8),
        metadata: {
          format: done.outputMetadata?.format ?? 'mp4',
          width: done.outputMetadata?.width,
          height: done.outputMetadata?.height,
        },
      };
    } catch (err) {
      await Promise.all([...seenIds].map((id) => cancelJob('videos', id, ctx)));
      throw err;
    }
  },

  async motionGraphics(input: {
    templateId?: string;
    props: Record<string, unknown>;
  }): Promise<BaseResult & { durationS: number }> {
    const create = await postJson<JobCreate>('/motion-graphics/render', {
      templateId: input.templateId,
      props: input.props,
    });
    const done = await pollUntilDone(`/motion-graphics/status/${create.id}`);
    const url = await resolveDownloadUrl(`/motion-graphics/download/${create.id}`);
    return {
      url,
      providerJobId: create.id,
      durationS: done.outputMetadata?.durationSeconds ?? 8,
      metadata: { format: 'mp4', templateId: input.templateId },
    };
  },

  // ----- helpers + discovery -----

  /**
   * Cancel an in-flight job by id, freeing its provider concurrency slot.
   * `kind` is the URL segment: 'images' | 'videos' | 'tts' | 'motion-graphics'.
   * Used by scripts/reap-69labs-orphans.ts to clear leaked jobs.
   */
  async cancel(
    kind: 'images' | 'videos' | 'tts' | 'motion-graphics',
    id: string,
    ctx?: Labs69Ctx,
  ): Promise<void> {
    await cancelJob(kind, id, ctx);
  },

  async listImageModels() {
    return getJson<{ models: { id: string; name: string; cost: number }[]; defaultModelId: string }>(
      '/images/models',
    );
  },

  async listVideoModels() {
    return getJson<{ models: { id: string; name: string; cost: number }[]; defaultModelId: string }>(
      '/videos/models',
    );
  },

  async listMotionTemplates() {
    return getJson<{ templates: { id: string; name: string; cost: number }[] }>(
      '/motion-graphics/templates',
    );
  },

  async listVoiceClones() {
    return getJson<{ voiceClones: { id: string; name: string; status: string }[] }>('/voice-clones');
  },
};

function estimateTtsDurationS(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round((words / 150) * 60));
}
