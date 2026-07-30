import os from 'node:os';
import path from 'node:path';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import pino from 'pino';
import { acquire, tryAcquireSlot, connection, allLaneQueues, NUM_LANES } from '@emberforge/queue';
import { assetsRepo, eventsRepo, generationsRepo, promptsRepo, shotsRepo } from '@emberforge/db';
import { labs69, withKeySlot } from '@emberforge/ai-clients';
import { r2Paths, uploadFile } from '@emberforge/storage';

const log = pino({ name: 'labs-worker' });

// 69labs caps CONCURRENT in-flight jobs PER ACCOUNT/key (separate from the
// req/min rate limit). Exceeding it returns `403 Concurrent ... limit reached`.
// `withKeySlot` gives every active key its own pool of PER_KEY_MAX slots and
// spreads jobs across keys, so two keys run 2×PER_KEY_MAX jobs per feature at
// once instead of funnelling everything through key #1.
//
// The per-key cap differs BY FEATURE on 69labs: image allows 4 concurrent jobs
// per key, video fewer. LABS69_PER_KEY_CONCURRENCY is the shared default;
// LABS69_IMAGE_PER_KEY_CONCURRENCY / LABS69_VIDEO_PER_KEY_CONCURRENCY override
// it per feature (image defaults to 4 to match the provider's image cap).
const PER_KEY_MAX = Math.max(1, Number(process.env.LABS69_PER_KEY_CONCURRENCY ?? 2));
const IMAGE_PER_KEY_MAX = Math.max(1, Number(process.env.LABS69_IMAGE_PER_KEY_CONCURRENCY ?? 4));
const VIDEO_PER_KEY_MAX = Math.max(1, Number(process.env.LABS69_VIDEO_PER_KEY_CONCURRENCY ?? PER_KEY_MAX));
// Expected active-key count — only sizes each worker's BullMQ pull cap so
// enough jobs are in hand to fill every key's slots. The real limiter is the
// per-key slot pool; bump this when you add more keys. Per-kind env still wins.
const MAX_KEYS = Math.max(1, Number(process.env.LABS69_MAX_KEYS ?? 2));
const IMAGE_MAX = Math.max(1, Number(process.env.LABS69_IMAGE_MAX_CONCURRENCY ?? MAX_KEYS * IMAGE_PER_KEY_MAX));
const VIDEO_MAX = Math.max(1, Number(process.env.LABS69_VIDEO_MAX_CONCURRENCY ?? MAX_KEYS * VIDEO_PER_KEY_MAX));

// Provider job ids currently in flight (id -> URL segment), so we can cancel
// them on shutdown instead of orphaning them — orphaned jobs keep occupying a
// concurrency slot on 69labs and eventually exhaust the cap. The `--watch` dev
// restart was the main culprit.
const inflight = new Map<string, 'images' | 'videos'>();

async function downloadToTmp(url: string, fileName: string): Promise<string> {
  const tmp = path.join(os.tmpdir(), fileName);
  await mkdir(path.dirname(tmp), { recursive: true });
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status} ${r.statusText}`);
  await writeFile(tmp, Buffer.from(await r.arrayBuffer()));
  return tmp;
}

// True only on a job's LAST retry. BullMQ exposes the configured ceiling on
// job.opts.attempts and the count already burned on job.attemptsMade (which,
// inside the handler, is attempts-1 on the final run).
function isFinalAttempt(job: Job): boolean {
  const max = job.opts?.attempts ?? 1;
  return job.attemptsMade >= max - 1;
}

// A hard 69labs verdict on the PROMPT itself — the model rejected it (CENSORED)
// or the job came back FAILED. Matches ONLY the provider-status errors thrown by
// labs69.pollUntilDone, not transient "fetch failed"/"poll timed out" messages,
// so a network blip or timeout still uses the full retry budget; only a doomed
// prompt short-circuits to the still fallback.
function isUnrenderablePrompt(err: unknown): boolean {
  return /69labs job \S+ (FAILED|CENSORED)/i.test((err as Error)?.message ?? '');
}

// Reduce a prompt 69labs refused to render down to something it reliably can.
//
// A doomed image prompt is almost always doomed because of its LEAD clause: the
// prompt builders put `visualSummary` first (it carries the most weight), and a
// summary that is prose rather than imagery — a rhetorical question, or a
// sentence truncated mid-clause — gives the model nothing to draw. 69labs then
// accepts the job, begins inference and hard-crashes seconds later with a bare
// FAILED and no reason. The trailing style/guard clauses are safe boilerplate.
//
// So: drop any leading clause that reads as prose, strip the long anti-artifact
// guard tail (its "no X" phrasing is dead weight once the prompt is short), and
// keep the descriptive middle. If nothing survives, fall back to a neutral
// ambient still that always renders. Only used AFTER a permanent failure, so a
// weaker prompt is strictly better than no asset at all.
const AMBIENT_STILL_PROMPT =
  'a slow, still, low-stimulation ambient view, dark, quiet and barely moving, ' +
  'soft diffuse light, low-key, desaturated, photoreal, cinematic composition';

// How many leading clauses (subject + scene description) to keep, plus how many
// render-quality tags to rescue from beyond that cap. QUALITY_TAG matches the
// tags that describe HOW the frame should be rendered rather than what is in it.
const CLAUSE_CAP = 12;
const QUALITY_CAP = 4;
const QUALITY_TAG = /\b(photoreal|photorealistic|hyperdetailed|cinematic|still frame|film grain|shallow depth of field|volumetric)\b/i;

function simplifyPrompt(promptText: string): string {
  // Strip the prose lead FIRST, as whole sentences. The lead is narration and
  // contains its own commas, so splitting on commas up front would scatter it
  // into fragments ("What is it" / "specifically") that individually look clean
  // and survive clause filtering. Cut everything up to and including the last
  // sentence terminator ('?', '!', '…') that appears before the style tags.
  let text = promptText;
  const proseEnd = Math.max(text.lastIndexOf('?'), text.lastIndexOf('!'), text.lastIndexOf('…'));
  if (proseEnd >= 0) text = text.slice(proseEnd + 1);
  // A truncated lead may end in a bare '…,' or trail into the tags — drop any
  // now-orphaned leading punctuation.
  text = text.replace(/^[\s,.;:]+/, '');

  const clauses = text
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

  const kept = clauses.filter((c) => {
    // Any residual prose fragment — a question or a mid-clause truncation.
    if (/\?/.test(c) || /(?:…|\.\.\.)$/.test(c)) return false;
    // Negation-style guard clauses ("no borders", "no on-screen text"). 69labs
    // has no negative-prompt channel, so these only burn attention budget.
    if (/^no\s+/i.test(c)) return false;
    return true;
  });

  // Cap the length: an over-long prompt is itself a risk factor, and by this
  // point we care about GETTING A FRAME more than about honouring every tag.
  //
  // Truncating the head alone would drop the TAIL, and the tail is where the
  // render-quality tags live ("photoreal", "cinematic composition") — the very
  // tags worth keeping on a salvage attempt. So take the leading clauses (the
  // subject and scene) and then re-append any quality tags the cap cut off.
  const head = kept.slice(0, CLAUSE_CAP);
  const quality = kept
    .slice(CLAUSE_CAP)
    .filter((c) => QUALITY_TAG.test(c))
    .slice(0, QUALITY_CAP);
  const out = [...head, ...quality].join(', ').trim();
  return out.length >= 20 ? out : AMBIENT_STILL_PROMPT;
}

// One shot's image OR video generation. Shared by both the labsImage and
// labsVideo workers — `job.data.kind` selects the branch. 69labs image and
// video are independent features (separate rate limits and concurrency caps),
// so each runs on its own queue/worker; this handler is the common body.
//
// Fallback: a video prompt 69labs simply cannot render (it returns FAILED or
// never converges, then BullMQ exhausts every retry) would otherwise leave the
// shot with NO visual asset — and buildTimeline throws on the FIRST shot
// missing a video/image, so one doomed prompt blocks the whole render. On the
// LAST video attempt we fall back to a STILL image from the same prompt (which
// is already worded for a near-frozen cinemagraph, so it makes a good still);
// buildTimeline accepts an `image` in place of `video_clip`, so the film
// finishes with a held frame for that one beat instead of failing outright.
async function processShot(job: Job) {
  const { projectId, shotId, kind } = job.data as { projectId: string; shotId: string; kind: 'image' | 'video' };

  const shot = await shotsRepo.findById(shotId);
  if (!shot) throw new Error(`shot ${shotId} not found`);

  try {
    return await generateVisual(projectId, shot, kind);
  } catch (err) {
    // A hard provider failure (69labs CENSORED, or a job that came back FAILED)
    // is the PROMPT's fault — it won't get better on retry, so go straight to
    // the still fallback instead of burning the remaining 7 video attempts. A
    // transient fault (timeout, 429/5xx) still uses the full retry budget and
    // only falls back on the LAST attempt.
    const unrenderable = isUnrenderablePrompt(err);

    // IMAGE: there is no cheaper kind to fall back to, so a doomed image prompt
    // used to burn every BullMQ attempt and then leave the shot with no visual
    // at all — and buildTimeline throws on the FIRST missing one, so a single
    // bad prompt blocked the entire render. Retry once with the prompt reduced
    // to its renderable core; if that works the shot is saved, and if it doesn't
    // we stop immediately instead of retrying a prompt we know 69labs rejects.
    if (kind === 'image' && unrenderable) {
      try {
        log.warn(
          { shotId, projectId },
          '69labs image unrenderable — retrying once with a simplified prompt',
        );
        const res = await generateVisual(projectId, shot, 'image', { simplifyPrompt: true });
        await eventsRepo
          .emit(projectId, 'labs', 'image_simplified_prompt', { shotId })
          .catch((e) => log.warn({ shotId, e }, 'failed to emit labs/image_simplified_prompt event'));
        return res;
      } catch (fbErr) {
        log.error({ shotId, err: fbErr }, 'simplified-prompt image retry also failed');
        throw new UnrecoverableError(
          `69labs image unrenderable and simplified retry failed for shot ${shotId}: ${(err as Error).message}`,
        );
      }
    }

    const permanent = kind === 'video' && unrenderable;
    if (kind === 'video' && (permanent || isFinalAttempt(job))) {
      try {
        log.warn(
          { shotId, projectId, permanent },
          `69labs video ${permanent ? 'unrenderable' : 'exhausted all attempts'} — falling back to a still image`,
        );
        // When the video was PERMANENTLY unrenderable, the still would reuse the
        // very prompt 69labs just rejected — simplify it too, or the fallback
        // simply reproduces the same crash.
        const res = await generateVisual(projectId, shot, 'image', {
          fallbackFromVideo: true,
          simplifyPrompt: permanent,
        });
        await eventsRepo
          .emit(projectId, 'labs', 'video_fallback_image', { shotId, permanent })
          .catch((e) => log.warn({ shotId, e }, 'failed to emit labs/video_fallback_image event'));
        return res;
      } catch (fbErr) {
        log.error({ shotId, err: fbErr }, 'video→image fallback also failed');
        // The still failed too. If the video was permanently unrenderable, don't
        // let BullMQ retry it 7 more times for nothing — stop the job now.
        // (A transient final-attempt failure just throws through below; it's
        // already on its last attempt, so it fails out naturally.)
        if (permanent) {
          throw new UnrecoverableError(
            `69labs video unrenderable and still fallback failed for shot ${shotId}: ${(err as Error).message}`,
          );
        }
      }
    }
    throw err;
  }
}

// Generate + store ONE visual for a shot at the given kind. Owns the full
// lifecycle (generation row, provider slot, submit→poll, download, upload,
// asset row) and its own failure bookkeeping, so callers just decide whether to
// retry or fall back. `opts.fallbackFromVideo` tags the still produced when a
// video prompt proved unrenderable.
async function generateVisual(
  projectId: string,
  shot: NonNullable<Awaited<ReturnType<typeof shotsRepo.findById>>>,
  genKind: 'image' | 'video',
  opts: { fallbackFromVideo?: boolean; simplifyPrompt?: boolean } = {},
) {
  const shotId = shot.id;

  // Where is this shot right now? `loc` is WORKER while we do local work
  // (cache/prompt/slot/download/upload) and 69LABS once it's submitted and we
  // are only polling the provider. Printed to the console so all shots' states
  // are visible at a glance.
  const tag = `labs:${genKind}`;
  const phase = (loc: 'WORKER' | '69LABS', phase: string, extra = '') =>
    console.log(`[${tag}] shot=${shotId} loc=${loc.padEnd(6)} phase=${phase}${extra}`);

  phase('WORKER', opts.fallbackFromVideo ? 'picked_up_fallback' : 'picked_up');

  const assetKind = genKind === 'image' ? 'image' : 'video_clip';
  const cached = await assetsRepo.findByShotKind(shotId, assetKind);
  if (cached) {
    phase('WORKER', 'cached', ` asset=${cached.id}`);
    await eventsRepo.emit(projectId, 'labs', 'cached', { shotId, kind: genKind });
    return { cached: true, assetId: cached.id };
  }

  const target = genKind === 'image' ? '69labs.image' : '69labs.video';
  let prompt = await promptsRepo.findForShot(shotId, target);
  if (!prompt && genKind === 'image') {
    // Fallback path: a video shot has no dedicated 69labs.image prompt. Reuse
    // its video prompt — already written for a near-still cinemagraph, so it
    // renders well as a single frame.
    prompt = await promptsRepo.findForShot(shotId, '69labs.video');
  }
  if (!prompt) throw new Error(`no ${target} prompt for shot ${shotId}`);

  // On a salvage attempt, submit a reduced version of the stored prompt. The
  // prompt ROW is left untouched — this is a per-attempt override, so the
  // original text stays visible in Studio and a later retry starts from it.
  const promptText = opts.simplifyPrompt ? simplifyPrompt(prompt.promptText) : prompt.promptText;
  if (opts.simplifyPrompt) {
    phase('WORKER', 'simplified_prompt', ` chars=${prompt.promptText.length}→${promptText.length}`);
  }

  const generation = await generationsRepo.create({
    promptId: prompt.id,
    provider: target,
    status: 'queued',
  });

  // The per-key concurrency slot is acquired INSIDE withKeySlot below (one pool
  // per key, so we can run a job on whichever key has a free slot) and released
  // the moment the provider job completes — download/upload happen off-slot.
  // Persist the provider job id the instant it's known so a mid-poll crash
  // leaves a reapable record, and track it for shutdown cancellation. 69labs
  // can re-queue a generation under a NEW id mid-poll; we track every id this
  // shot has lived under so shutdown/cleanup cancels the live one, not just the
  // original (cancelling a stale id leaks a provider concurrency slot).
  const seg = genKind === 'image' ? ('images' as const) : ('videos' as const);
  const myJobIds = new Set<string>();
  let providerJobId: string | undefined;
  const trackJob = (id: string) => {
    providerJobId = id;
    myJobIds.add(id);
    inflight.set(id, seg);
  };
  const onSubmit = async (id: string) => {
    trackJob(id);
    // The job now lives at 69labs; everything until COMPLETED is loc=69LABS.
    phase('69LABS', 'submitted', ` job=${id}`);
    await generationsRepo.markStarted(generation.id, id);
  };
  // 69labs swapped in a new underlying job id (it re-queued the generation).
  const onJobId = (id: string) => {
    if (myJobIds.has(id)) return;
    trackJob(id);
    phase('69LABS', 'restarted', ` job=${id}`);
    // Point the generation row at the live job so the orphan reaper cancels it.
    void generationsRepo.markStarted(generation.id, id).catch(() => {});
  };
  // Each 69labs status transition (PENDING→PROCESSING→FINALIZING→…), tagged with
  // the live job id so a mid-poll restart is visible in the console.
  const onStatus = (status: string, id?: string) => {
    const jid = id ?? providerJobId;
    phase('69LABS', status, jid ? ` job=${jid}` : '');
  };
  try {
    await acquire(genKind === 'image' ? '69labs.image' : '69labs.video');
    await generationsRepo.markStarted(generation.id);
    const t0 = Date.now();

    phase('WORKER', 'waiting_slot');
    // Run the whole submit→poll→download on whichever active key has a free slot
    // (one pool of PER_KEY_MAX per key), so two keys generate in parallel. Blocks
    // here until some key has a free slot; the lease is auto-reclaimed if this
    // worker crashes, and it's released the moment the provider job completes so
    // the download/upload below happen off-slot. On a key-attributable failure
    // (bad key, 402 no-credits, 429) withKeySlot rotates to another key and
    // re-runs this whole function — a fresh job under the new account — instead
    // of failing the shot. Content failures (CENSORED) are rethrown immediately
    // so we don't burn the pool on a doomed prompt. The provider job id changes
    // on a rotation; onSubmit/onJobId keep our tracking pointed at the live job.
    phase('WORKER', 'submitting');
    const result = await withKeySlot(
      '69labs',
      async (apiKey, keyId) => {
        // Per-key hourly quota: 69labs allows 100 images / 40 videos per hour
        // PER KEY — the BINDING cap for sustained generation (the per-key
        // concurrency slots, 4 image / 2 video, just bound the burst rate).
        // Charge one token to THIS key's
        // hourly bucket before submitting; blocks here if the key has spent its
        // hour. Bucketed per key, so two keys give 200/80 an hour and a disabled
        // key only drops its own share. (Held under the key's concurrency slot —
        // fine: other jobs on a spent key would be hour-blocked too.)
        await acquire(`${target}.hourly`, 1, `${target}.hourly:${keyId}`);
        return genKind === 'image'
          ? labs69.image({
            prompt: promptText,
            negative: prompt.negative ?? undefined,
            onStatus,
            // 1k is the only resolution this 69labs account/tier actually
            // serves — submitting 2k/4k returns `503 SERVICE_UNAVAILABLE` even
            // though /images/models advertises them (verified live, 2026-06-12).
            // 1k for 16:9 (~1024×576) is sub-1080p and gets upscaled in the
            // final encode; bump back to 2k via LABS69_IMAGE_RESOLUTION only
            // once the plan actually supports it.
            aspectRatio: '16:9',
            resolution: process.env.LABS69_IMAGE_RESOLUTION ?? '1k',
            onSubmit,
            onJobId,
            apiKey,
          })
          : labs69.video({
            prompt: promptText,
            negative: prompt.negative ?? undefined,
            durationS: Number(shot.durationS),
            // Intentionally NOT passing aspectRatio / resolution — the
            // default 69labs video model (Veo 3.1 Lite) rejects both with
            // 400. Output is native 16:9 at the model's chosen size and
            // gets scaled to the project's targetRes in the final encode.
            onSubmit,
            onJobId,
            onStatus,
            apiKey,
          });
      },
      {
        perKeyMax: genKind === 'image' ? IMAGE_PER_KEY_MAX : VIDEO_PER_KEY_MAX,
        leaseMs: genKind === 'image' ? 12 * 60_000 : 15 * 60_000,
        // Redis-backed slot pools, one per key: `cc:69labs.image:<keyId>`.
        tryAcquireSlot,
        slotKeyFor: (keyId) => `${target}:${keyId}`,
        // Until the api_keys table is populated, fall back to the legacy env key
        // so labs jobs keep working exactly as before (safe incremental rollout).
        fallbackKey: process.env.LABS69_API_KEY,
      },
    );

    // Back in the worker: COMPLETED at 69labs, now pulling + storing the bytes.
    phase('WORKER', 'downloading');
    const ext = genKind === 'image' ? 'png' : 'mp4';
    const tmp = await downloadToTmp(result.url, `labs_${shotId}.${ext}`);
    phase('WORKER', 'uploading');
    const key =
      genKind === 'image'
        ? r2Paths.shotImage(projectId, shotId, prompt.inputHash)
        : r2Paths.shotVideo(projectId, shotId, prompt.inputHash);
    const uploaded = await uploadFile(tmp, key, genKind === 'image' ? 'image/png' : 'video/mp4');
    await unlink(tmp).catch(() => {});

    const asset = await assetsRepo.create({
      projectId,
      shotId,
      generationId: generation.id,
      kind: assetKind,
      r2Key: uploaded.key,
      bytes: uploaded.bytes,
      durationS: genKind === 'video' ? String(Number(shot.durationS)) : null,
      metadata: {
        providerJobId: result.providerJobId,
        ...(opts.fallbackFromVideo ? { fallbackFromVideo: true } : {}),
        ...(opts.simplifyPrompt ? { simplifiedPrompt: true } : {}),
      },
    });

    await generationsRepo.markSucceeded(generation.id, {
      providerJobId: result.providerJobId,
      latencyMs: Date.now() - t0,
    });
    phase('WORKER', 'done', ` asset=${asset.id}`);
    await eventsRepo.emit(projectId, 'labs', 'succeeded', {
      shotId,
      kind: genKind,
      ...(opts.fallbackFromVideo ? { fallbackFromVideo: true } : {}),
    });
    return { assetId: asset.id };
  } catch (err) {
    const message = (err as Error).message;
    phase('WORKER', 'failed', ` err=${message}`);
    await generationsRepo.markFailed(generation.id, { message });
    log.error({ shotId, err }, '69labs failed');
    // Surface the 69labs failure to the browser: this worker runs on Fly.io so
    // its logs never reach the operator's console. Emit a project event the web
    // app polls (/events) and re-logs in the browser console. Best-effort — a
    // failed emit must not mask the original generation error.
    await eventsRepo
      .emit(projectId, 'labs', 'failed', { shotId, kind: genKind, message, providerJobId })
      .catch((e) => log.warn({ shotId, e }, 'failed to emit labs/failed event'));
    throw err;
  } finally {
    // labs69.image/video already cancels the provider job(s) on failure, so by
    // here they're either done or cancelled — drop every id this shot lived
    // under from the in-flight set. The per-key concurrency slot was already
    // released inside withKeySlot when the provider job completed.
    for (const id of myJobIds) inflight.delete(id);
  }
}

// Two independent workers, one per 69labs feature, so image and video generate
// on separate tracks: a backlog of slow video jobs can never head-of-line block
// image jobs (or vice versa). BullMQ concurrency is just the PULL cap (≈ keys ×
// per-key slots) so enough jobs are in hand to fill every key's pool — the real
// cross-process limit is the per-key slot pools inside withKeySlot. Jobs pulled
// beyond free slots park in withKeySlot's wait loop holding only a BullMQ lock
// (no download buffer until a slot opens), so peak RAM ~= IMAGE_MAX + VIDEO_MAX.
// One worker group per lane (LABS_LANES). Each lane drains its own
// labsImage{N}/labsVideo{N} queues so a second project generates concurrently
// instead of queueing behind the first. The handler is identical — it routes on
// job.data.kind, not the queue name — and EVERY lane shares the same per-key
// slot pools inside withKeySlot, so 69labs' concurrency caps still hold no
// matter how many lanes run. Concurrency stays at the full pool size per lane,
// so a single active project saturates every slot (100%) and two split them.
for (const { image, video } of allLaneQueues()) {
  new Worker(image, processShot, { connection, concurrency: IMAGE_MAX });
  new Worker(video, processShot, { connection, concurrency: VIDEO_MAX });
}

// On shutdown (incl. the `--watch` dev restart), cancel any in-flight 69labs
// jobs so they release their concurrency slots instead of orphaning and
// exhausting the cap. Best-effort, time-boxed so we don't hang the exit.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  const jobs = [...inflight.entries()];
  if (jobs.length) {
    log.warn({ signal, count: jobs.length }, 'cancelling in-flight 69labs jobs before exit');
    await Promise.race([
      Promise.allSettled(jobs.map(([id, kind]) => labs69.cancel(kind, id))),
      new Promise((r) => setTimeout(r, 5_000)),
    ]);
  }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

log.info(
  {
    lanes: NUM_LANES,
    queues: allLaneQueues().flatMap((l) => [l.image, l.video]),
    perKeyMax: PER_KEY_MAX,
    maxKeys: MAX_KEYS,
    imagePull: IMAGE_MAX,
    videoPull: VIDEO_MAX,
  },
  `labs-worker started — ${NUM_LANES} lane(s), per-key slot pools shared across lanes`,
);
