import os from 'node:os';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ffmpeg, ffprobeDuration, extractLastFrame } from './run.js';
import { buildXfadeChain, concatDemuxer, type XfadeStep, type XfadeFinish } from './concat.js';
import { isImageInput } from './shotComposite.js';
import { kenBurnsFilter, type KenBurnsMode } from './kenBurns.js';
import { cinematicGrade, coverScaleCrop, ensureEmberPlate, isCinematicGradeEnabled, planEmberOverlay } from './filters.js';

/**
 * Directions a still cycles through so consecutive stills never move the same
 * way — alternating zoom in / zoom out / pan left / right / up / down. Chosen by
 * the clip's sequential index, so a long images-only tail keeps varying. This is
 * what makes the post-30-min stills (and every freeze tail) feel dynamic instead
 * of "completely still".
 */
const STILL_KEN_BURNS_CYCLE: KenBurnsMode[] = ['in', 'out', 'left', 'right', 'up', 'down'];

/**
 * Pick a still's Ken Burns move by index. `continuousStart` is set for the frozen
 * tail of a SHORT video clip: that tail is hard-concatenated directly after the
 * live video with no crossfade at the seam, so it MUST begin at zoom=1 to match
 * the last live frame. Every mode starts at zoom=1 EXCEPT 'out', which begins
 * fully zoomed-in and would pop the scale ~8% at that seam — so for a continuous
 * start it's remapped to 'in' (the zoom-in counterpart, also starting at zoom=1).
 * Standalone image shots leave `continuousStart` false: a crossfade dissolves
 * into them, so an 'out' reveal is fine (and looks good).
 */
function stillKenBurnsMode(index: number, continuousStart: boolean): KenBurnsMode {
  const len = STILL_KEN_BURNS_CYCLE.length;
  const mode = STILL_KEN_BURNS_CYCLE[((index % len) + len) % len]!;
  return continuousStart && mode === 'out' ? 'in' : mode;
}

/**
 * One clip in the sleep timeline. Lengths are pre-computed by the caller so that
 * the crossfade overlaps cancel and the master comes out exactly as long as the
 * narration (see render-worker `renderSleepMaster`). This module only realises
 * each clip to its exact length and dissolves the lot together.
 */
export interface SleepClip {
  /** Local source file — an AI video clip or a still image. */
  sourcePath: string;
  /**
   * Exact length of this clip on the timeline, INCLUDING the trailing crossfade
   * overlap with the next clip. The renderer guarantees the produced segment is
   * this long: a short video is extended by holding a frozen, slowly-drifting
   * last frame (never cut early); a long video is trimmed to fit.
   */
  targetDurationS: number;
  /** Crossfade overlap (seconds) of the dissolve INTO this clip. 0 for the
   *  first clip — nothing precedes it. */
  crossfadeInS: number;
  /** ffmpeg xfade transition name. The sleep renderer forces 'fade' (a cross
   *  dissolve); kept here so future per-scene transition types can be wired in
   *  without touching this module. */
  transition?: string;
  /** Sequential index — only used to vary the (imperceptible) pan direction so
   *  long runs of stills don't all drift the same way. */
  index: number;
}

export interface BuildSleepMasterOpts {
  clips: SleepClip[];
  outPath: string;
  width: number;
  height: number;
  fps: number;
  nvenc?: boolean;
  /** Ken Burns zoom ceiling for stills and frozen tails. 1.18 = an 18% push over
   *  the whole clip — a clearly dynamic drift (1.02 read as "completely still",
   *  1.08 as "too low"). Eased over the full clip, so this ceiling is the only
   *  lever on perceived motion SPEED. Direction cycles per index (STILL_KEN_BURNS_CYCLE).
   *  The render-worker passes SLEEP_KENBURNS_MAX_ZOOM; this default is the fallback. */
  maxZoom?: number;
  /** Scratch dir for per-clip intermediates. Defaults to outPath's dir. */
  workDir?: string;
  /** How many clips to realise in parallel. Defaults to 4. */
  concurrency?: number;
  /**
   * Max clips per intermediate xfade sub-master. A single xfade graph over
   * hundreds of clips overflows ffmpeg's command line / memory (a 2-hour film
   * is ~600 clips), so for long timelines the chain is split into batches of
   * this size — each batch is rendered to its own crossfade master, then the
   * masters are crossfade-JOINED at their scene seams. This is mathematically
   * identical to one chain: a batch ending at clip b has length ΣD + o[b+1],
   * and that trailing o[b+1] is exactly the overlap the next batch's first clip
   * dissolves over, so offsets line up to the frame. <=0 disables batching
   * (always single chain). Defaults to SLEEP_RENDER_BATCH_SIZE or 80.
   */
  batchSize?: number;
  /**
   * Clip indices that START a new script scene (clips[i].sceneId !=
   * clips[i-1].sceneId). Used ONLY by the effect-in-batches path to break batch
   * boundaries at scene changes, so the hard-cut seams between batches land where
   * a cut is natural instead of mid-scene. Ignored by the default xfade-join path.
   */
  sceneBoundaries?: number[];
}

const DEFAULT_MAX_ZOOM = 1.18;
// Effect-in-batches: bake the grade + ember into the PARALLEL batch encodes and
// join the finished batches with a stream-copy concat — eliminating the single
// serial final-join pass (the multi-hour bottleneck). The trade-off is that the
// batch-boundary transitions become hard CUTS instead of dissolves; we break
// batches at scene boundaries (sceneBoundaries) so those cuts land naturally.
// Default OFF (keep the dissolve-everywhere look); enable to cut composite time.
const EFFECT_IN_BATCHES = (process.env.SLEEP_EFFECT_IN_BATCHES ?? 'false') === 'true';
// Inputs-per-batch directly drives PEAK RAM: an xfade graph opens every input in
// the batch and buffers frames across the whole chain. An ~80-input 1080p batch
// was measured at ~8GB resident and got OOM-killed when two ran together on a
// 16GB box (→ lock lost → the whole render silently restarted). Memory scales
// ~linearly with the input count, so a SMALLER batch is the lever that both caps
// per-batch RAM and lets several run in parallel. 40 ≈ ~4GB/batch. More batches
// only enlarges the (tiny) final join graph. <=0 disables batching.
const DEFAULT_BATCH_SIZE = Number(process.env.SLEEP_RENDER_BATCH_SIZE ?? 40);
const CPU_COUNT = Math.max(1, os.cpus()?.length ?? 4);
// Upper bound on parallel batch encoders. The xfade chain's filter is SINGLE-
// THREADED, so more cores only help via more concurrent batches — BUT memory, not
// CPU, is the real limit here (see the memCap in buildBatchedSleepMaster). This is
// just the ceiling; leave one core for the event loop / BullMQ lock heartbeat.
const DEFAULT_BATCH_CONCURRENCY = Math.max(1, Number(process.env.SLEEP_BATCH_CONCURRENCY ?? CPU_COUNT - 1));
// Estimated per-input RAM of an xfade batch (MB) and RAM to hold back for Node +
// OS + page cache. Used to cap batch concurrency so the pool can NEVER exceed
// physical RAM — the OOM-kill → silent-restart loop is far worse than running a
// touch more serially. Both overridable for bigger/smaller boxes.
const BATCH_MEM_PER_CLIP_MB = Math.max(1, Number(process.env.SLEEP_BATCH_MEM_PER_CLIP_MB ?? 110));
const RENDER_RESERVE_MEM_MB = Math.max(512, Number(process.env.SLEEP_RENDER_RESERVE_MEM_MB ?? 3072));
// Below this, a video is treated as "fully covers its slot" and just trimmed —
// avoids producing a sub-frame freeze tail for rounding noise.
const FREEZE_EPSILON_S = 0.08;

/** Run `fn` over `items` with a bounded pool; results keep input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i]!, i);
    }
  };
  const pool = Math.min(Math.max(1, limit), items.length || 1);
  await Promise.all(Array.from({ length: pool }, () => worker()));
  return results;
}

function intermediateEncodeArgs(nvenc: boolean): string[] {
  const x264Preset = process.env.FFMPEG_INTERMEDIATE_PRESET ?? process.env.FFMPEG_X264_PRESET ?? 'veryfast';
  const x264Crf = process.env.FFMPEG_INTERMEDIATE_CRF ?? process.env.FFMPEG_X264_CRF ?? '20';
  const nvencPreset = process.env.FFMPEG_NVENC_PRESET ?? 'p6';
  const nvencCq = process.env.FFMPEG_NVENC_CQ ?? '20';
  // Cap threads PER encode. This prep phase is filter-bound (zoompan is single-
  // threaded), and MIX_CONCURRENCY now runs one ffmpeg PER CORE, so each encode
  // should take a SINGLE thread — concurrency × threads then equals the core
  // count with no oversubscription, and every core stays busy on its own clip's
  // zoompan. (Previously 2 threads × 4 procs; now 1 thread × CPU_COUNT procs —
  // same total threads, ~2× the parallel zoompan filters.) '0' lets x264
  // auto-pick (one thread per core) for the single-encode case. Thread count does
  // NOT affect output quality — only speed/determinism — so this is free.
  const x264Threads = process.env.FFMPEG_INTERMEDIATE_THREADS ?? '1';
  const threadArgs = x264Threads !== '0' ? ['-threads', x264Threads] : [];
  return nvenc
    ? ['-c:v', 'h264_nvenc', '-preset', nvencPreset, '-cq', nvencCq]
    : ['-c:v', 'libx264', '-preset', x264Preset, '-crf', x264Crf, ...threadArgs];
}

const NVENC_RE = /nvenc|nvcuda|cuda|gpu/i;
const NON_NVENC_RE = /permission|disk full|no space/i;
async function runWithNvencFallback(build: (nvenc: boolean) => string[], nvenc: boolean): Promise<void> {
  try {
    await ffmpeg(build(nvenc));
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (!(nvenc && NVENC_RE.test(msg) && !NON_NVENC_RE.test(msg))) throw err;
    // eslint-disable-next-line no-console
    console.warn('[sleepRender] NVENC failed, retrying with libx264. Reason:', msg.slice(0, 200));
    await ffmpeg(build(false));
  }
}

/** Render a still image into a `durationS`-long, silent, target-res clip with a
 *  barely-perceptible Ken Burns move. Used for image assets and frozen tails.
 *
 *  The motion uses the shared, jitter-free `kenBurnsFilter` (see kenBurns.ts):
 *  an eased zoom up to `maxZoom` plus a slow move whose direction cycles by index
 *  through zoom-in / zoom-out / pan-left / right / up / down (STILL_KEN_BURNS_CYCLE)
 *  so consecutive stills — and long images-only tails — never drift the same way.
 *  The heavy input oversample keeps zoompan's per-frame pixel floor sub-pixel, so
 *  there is no shimmer even on the slowest sleep-story pushes. */
async function prepStillSegment(
  srcImage: string,
  durationS: number,
  index: number,
  opts: BuildSleepMasterOpts,
  outPath: string,
  continuousStart = false,
): Promise<void> {
  const maxZoom = opts.maxZoom ?? DEFAULT_MAX_ZOOM;
  const build = (nvenc: boolean): string[] => [
    '-y',
    '-loop', '1', '-framerate', String(opts.fps), '-t', String(durationS), '-i', srcImage,
    '-filter_complex', kenBurnsFilter({
      mode: stillKenBurnsMode(index, continuousStart),
      width: opts.width,
      height: opts.height,
      durationS,
      fps: opts.fps,
      maxZoom,
      outputLabel: 'v',
      suffix: ',format=yuv420p',
    }),
    '-map', '[v]',
    '-r', String(opts.fps),
    '-t', String(durationS),
    ...intermediateEncodeArgs(nvenc),
    '-pix_fmt', 'yuv420p',
    '-an',
    '-movflags', '+faststart',
    outPath,
  ];
  await runWithNvencFallback(build, !!opts.nvenc);
}

/** Normalise a source video to target res/fps/yuv420p, silent, trimmed to
 *  `durationS` (the source's own motion is preserved — no Ken Burns). */
async function prepVideoSegment(
  src: string,
  durationS: number,
  opts: BuildSleepMasterOpts,
  outPath: string,
): Promise<void> {
  const vf = `${coverScaleCrop(opts.width, opts.height, opts.fps)},format=yuv420p`;
  const build = (nvenc: boolean): string[] => [
    '-y',
    '-i', src,
    '-vf', vf,
    '-t', String(durationS),
    '-r', String(opts.fps),
    ...intermediateEncodeArgs(nvenc),
    '-pix_fmt', 'yuv420p',
    '-an',
    '-movflags', '+faststart',
    outPath,
  ];
  await runWithNvencFallback(build, !!opts.nvenc);
}

/**
 * Realise one clip to a single file of exactly `targetDurationS`:
 *  - image source        → slow Ken Burns over the full duration
 *  - video ≥ target      → trimmed to target
 *  - video < target      → full video, then a frozen, slowly-drifting last frame
 *                          held until the slot is full (never cut early)
 */
async function prepClip(clip: SleepClip, opts: BuildSleepMasterOpts, workDir: string, i: number): Promise<string> {
  const stem = `clip_${i.toString().padStart(5, '0')}`;
  const out = path.join(workDir, `${stem}.mp4`);
  const target = clip.targetDurationS;

  if (isImageInput(clip.sourcePath)) {
    await prepStillSegment(clip.sourcePath, target, clip.index, opts, out);
    return out;
  }

  const srcDur = await ffprobeDuration(clip.sourcePath).catch(() => 0);

  // Source covers (≈) the whole slot — just trim.
  if (srcDur >= target - FREEZE_EPSILON_S) {
    await prepVideoSegment(clip.sourcePath, target, opts, out);
    return out;
  }

  // Source is shorter than the slot. Extend continuity by holding a frozen,
  // slowly-drifting last frame until narration reaches the next clip.
  const liveLen = Math.max(0, srcDur);
  const padLen = target - liveLen;
  const stillImg = path.join(workDir, `${stem}_frame.png`);
  await extractLastFrame(clip.sourcePath, stillImg);

  // Degenerate case: an unreadable/zero-length video. Fall back to a pure still
  // hold of the extracted frame so the slot is still filled (no early cut).
  if (liveLen < FREEZE_EPSILON_S) {
    await prepStillSegment(stillImg, target, clip.index, opts, out);
    return out;
  }

  const videoPart = path.join(workDir, `${stem}_a.mp4`);
  const stillPart = path.join(workDir, `${stem}_b.mp4`);
  await prepVideoSegment(clip.sourcePath, liveLen, opts, videoPart);
  // continuousStart: this tail is hard-concatenated straight after the live video
  // (no crossfade at the seam), so its move must begin at zoom=1 to avoid a pop.
  await prepStillSegment(stillImg, padLen, clip.index, opts, stillPart, true);
  // Both parts share res/fps/pixfmt/sar, so a lossless demuxer concat joins them.
  await concatDemuxer([videoPart, stillPart], out);
  return out;
}

/**
 * Build a single video-only master in which every clip cross-dissolves into the
 * next — a slow, hypnotic sleep-story sequence with no hard cuts.
 *
 * Clip lengths and overlaps are supplied by the caller (already solved so the
 * dissolves cancel out and the master matches the narration length exactly), so
 * this function's only jobs are: (1) realise each clip to its exact length,
 * extending short clips with frozen Ken Burns tails, and (2) chain them through
 * `buildXfadeChain` as crossfades. Audio is intentionally dropped — narration is
 * a separate master muxed in at final encode.
 */
export async function buildSleepMaster(opts: BuildSleepMasterOpts): Promise<void> {
  if (opts.clips.length === 0) throw new Error('buildSleepMaster: no clips');
  const workDir = opts.workDir ?? path.join(path.dirname(opts.outPath), 'sleep_segments');
  await mkdir(workDir, { recursive: true });

  // 1) Realise each clip to its exact slot length. Parallel; order preserved.
  const prepared = await mapLimit(opts.clips, opts.concurrency ?? 4, (clip, i) =>
    prepClip(clip, opts, workDir, i),
  );

  // 2) Chain the clips as crossfades. The first clip's overlap is ignored by
  //    buildXfadeChain; every other clip dissolves IN over its crossfadeInS.
  const steps: XfadeStep[] = opts.clips.map((c, i) => ({
    path: prepared[i]!,
    durationS: c.targetDurationS,
    xfade: c.transition ?? 'fade',
    overlapS: i === 0 ? 0 : c.crossfadeInS,
  }));

  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  // Resolve the finishing look ONCE and bake it into the final pass (below) so
  // finalEncode can stream-copy instead of running a second full re-encode.
  // (async: it pre-scales the ember plate to target res once — see resolveFinish.)
  const finish = await resolveFinish(opts);

  // Short timelines: one xfade graph is fine and avoids the extra re-encode.
  if (batchSize <= 0 || steps.length <= batchSize) {
    await buildXfadeChain(steps, opts.outPath, { nvenc: opts.nvenc, audio: false, finish });
    return;
  }

  // FAST PATH (opt-in): bake the finish into each parallel batch and stream-copy
  // join — drops the serial final-join pass entirely. Seams become hard cuts
  // (aligned to scene boundaries).
  if (EFFECT_IN_BATCHES) {
    await buildEffectInBatchesMaster(steps, batchSize, opts, workDir, finish);
    return;
  }

  // Long timelines (e.g. 2-hour ≈ 600 clips): render in batches, then
  // crossfade-join the batch masters at their scene seams. See batchSize doc
  // for why this is identical to the single chain.
  await buildBatchedSleepMaster(steps, batchSize, opts, workDir, finish);
}

/**
 * Resolve the global "finishing" look (cinematic grade + ember overlay) so it can
 * be baked into the FINAL xfade pass. Reads the same env switches finalEncode
 * uses, so enabling/disabling either lever behaves identically — the only
 * difference is WHERE it's applied (one fewer encode pass). Returns undefined
 * when both are off: the master is then a plain encode and finalEncode
 * stream-copies it (the fast review-render path).
 */
async function resolveFinish(opts: BuildSleepMasterOpts): Promise<XfadeFinish | undefined> {
  const grade = isCinematicGradeEnabled() ? cinematicGrade() : null;
  // Pre-scale the 4K ember plate to target res once (cached in the work dir) so
  // the finishing pass doesn't decode+scale 4K every frame. Best-effort: any
  // failure falls back to null → planEmberOverlay uses the raw 4K asset (the
  // original, slower-but-working path), so this can never break a render.
  const workDir = opts.workDir ?? path.dirname(opts.outPath);
  const plate = await ensureEmberPlate(
    opts.width,
    opts.height,
    opts.fps,
    path.join(workDir, 'fxcache'),
  ).catch(() => null);
  const overlay = planEmberOverlay(opts.width, opts.height, opts.fps, { plate: plate ?? undefined });
  if (!grade && !overlay) return undefined;
  return { grade, overlay, width: opts.width, height: opts.height };
}

/** Split `arr` into contiguous chunks of at most `size`. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Batched crossfade render for long timelines. Each batch of `batchSize` clips
 * becomes its own crossfade master (within-batch dissolves applied), and the
 * masters are then crossfade-joined: the overlap into batch j is the crossfade
 * of batch j's FIRST clip — the same seam dissolve that single-chain rendering
 * would apply between the last clip of j-1 and the first clip of j. Because each
 * batch master already carries the trailing-tail length of that seam overlap,
 * the join offsets line up exactly with the authoritative narration schedule.
 */
async function buildBatchedSleepMaster(
  steps: XfadeStep[],
  batchSize: number,
  opts: BuildSleepMasterOpts,
  workDir: string,
  finish?: XfadeFinish,
): Promise<void> {
  const batches = chunk(steps, batchSize);
  // MEMORY CAP — the one that prevents the OOM-kill → silent-restart loop. Peak
  // RAM ≈ perBatch × concurrency, and a batch's RAM tracks its input count, so we
  // run only as many at once as fit in (totalmem − reserve). This caps below the
  // CPU-based ceiling whenever memory is the tighter constraint (it usually is).
  const realBatchInputs = batches[0]?.length ?? batchSize;
  const usableMb = Math.max(1024, os.totalmem() / (1024 * 1024) - RENDER_RESERVE_MEM_MB);
  const perBatchMb = Math.max(512, realBatchInputs * BATCH_MEM_PER_CLIP_MB);
  const memCap = Math.max(1, Math.floor(usableMb / perBatchMb));
  const batchConcurrency = Math.min(DEFAULT_BATCH_CONCURRENCY, batches.length, memCap);
  // Per-batch libx264 thread budget so the concurrent batch encoders share the
  // cores instead of each grabbing all of them (N×cores threads thrashing). The
  // xfade filter is single-threaded and is the bottleneck, so flooring at 1 is
  // fine; when few batches run, each gets proportionally more threads.
  const batchThreads = Math.max(1, Math.floor(CPU_COUNT / batchConcurrency));
  // eslint-disable-next-line no-console
  console.log(
    `[sleepRender] batched master: ${steps.length} clips → ${batches.length} batches of ≤${batchSize} ` +
      `(concurrency ${batchConcurrency}, ${batchThreads} thr/batch, memCap ${memCap}, ~${Math.round(perBatchMb)}MB/batch)`,
  );

  // Render the batches to their own crossfade masters. They're independent, so a
  // bounded pool encodes several at once; mapLimit preserves input order, so
  // joinSteps stays in batch order for the final join. The first step's overlap
  // is ignored inside each batch (buildXfadeChain skips the first clip's fade-in);
  // we record it as the seam overlap to apply when joining the batch masters.
  const joinSteps = await mapLimit(batches, batchConcurrency, async (batch, b) => {
    const seamOverlapS = batch[0]!.overlapS; // crossfadeInS of this batch's first clip (0 for batch 0)
    const batchPath = path.join(workDir, `batch_${b.toString().padStart(4, '0')}.mp4`);
    await buildXfadeChain(batch, batchPath, { nvenc: opts.nvenc, audio: false, threads: batchThreads });
    // Probe the real master length so join offsets use measured, not computed,
    // durations (immune to any per-clip frame-rounding inside the batch). A zero
    // here would silently corrupt every downstream join offset, so fail loudly
    // instead of defaulting to 0 — the batch master was just written, so an
    // unprobeable result means something is genuinely wrong.
    const durationS = await ffprobeDuration(batchPath).catch(() => 0);
    if (!(durationS > 0)) {
      throw new Error(`sleep batch ${b} produced an unprobeable/zero-length master: ${batchPath}`);
    }
    return { path: batchPath, durationS, xfade: 'fade', overlapS: seamOverlapS } as XfadeStep;
  });

  // Crossfade-join the batch masters. joinSteps has only ~batches.length inputs
  // (e.g. ~8 for a 2-hour film), so this graph is tiny regardless of clip count.
  // The finishing grade + overlay is baked in HERE (the join is the deliverable
  // pass) — not in the per-batch encodes above, which would double-apply it.
  await buildXfadeChain(joinSteps, opts.outPath, { nvenc: opts.nvenc, audio: false, finish });
}

/**
 * Split [0,n) into contiguous [start,end) batch ranges that PREFER scene
 * boundaries. A batch closes when it hits `batchSize` (the memory cap) OR when
 * the next clip starts a new scene and the batch already has at least `minBatch`
 * clips — so the hard-cut seams in the effect-in-batches path land at scene
 * changes, not mid-scene, while staying within the memory budget.
 */
function sceneAwareRanges(n: number, batchSize: number, sceneStarts: Set<number>): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const minBatch = Math.max(1, Math.floor(batchSize / 2));
  let start = 0;
  for (let i = 1; i <= n; i++) {
    const len = i - start;
    const sceneCut = i < n && sceneStarts.has(i);
    if (i === n || len >= batchSize || (sceneCut && len >= minBatch)) {
      ranges.push([start, i]);
      start = i;
    }
  }
  return ranges;
}

/**
 * EFFECT-IN-BATCHES assembly (opt-in via SLEEP_EFFECT_IN_BATCHES). Bakes the
 * finishing grade + ember into each PARALLEL batch encode, then joins the
 * finished batches with a lossless stream-copy concat — so the single, serial,
 * multi-hour final-join pass disappears entirely. The expensive per-frame effect
 * is done once, spread across the batch encoders, instead of once on one core.
 *
 * TIMING: the default xfade-join path makes each batch carry a trailing tail
 * (the seam-overlap the next batch dissolves over). A stream-copy concat does NOT
 * consume any overlap, so here every batch is rendered to EXACTLY its clips'
 * narration span: the last clip of each non-final batch drops its trailing
 * overlap (durationS -= the next batch's first-clip overlap). The within-batch
 * total is then Σ D of the batch's clips, the concat total is Σ D over all clips
 * = the narration length, and each clip still lands at its absolute startS — so
 * the separate narration master stays in sync to the frame.
 *
 * SEAMS: the boundary transitions become hard CUTS (concat can't dissolve). We
 * break batches at scene boundaries so the cuts are natural. The ember "loop
 * phase" resets at each seam, but a hard cut already changes the whole frame, so
 * that reset is hidden by the cut (no offset needed).
 */
async function buildEffectInBatchesMaster(
  steps: XfadeStep[],
  batchSize: number,
  opts: BuildSleepMasterOpts,
  workDir: string,
  finish?: XfadeFinish,
): Promise<void> {
  const n = steps.length;
  const sceneStarts = new Set(opts.sceneBoundaries ?? []);
  const ranges = sceneAwareRanges(n, batchSize, sceneStarts);

  // Memory cap (same reasoning as buildBatchedSleepMaster) sized on the LARGEST
  // batch — the effect adds only a small prescaled-ember decode, so the per-clip
  // estimate still holds.
  const maxInputs = Math.max(...ranges.map(([a, b]) => b - a));
  const usableMb = Math.max(1024, os.totalmem() / (1024 * 1024) - RENDER_RESERVE_MEM_MB);
  const perBatchMb = Math.max(512, maxInputs * BATCH_MEM_PER_CLIP_MB);
  const memCap = Math.max(1, Math.floor(usableMb / perBatchMb));
  const batchConcurrency = Math.min(DEFAULT_BATCH_CONCURRENCY, ranges.length, memCap);
  const batchThreads = Math.max(1, Math.floor(CPU_COUNT / batchConcurrency));
  // eslint-disable-next-line no-console
  console.log(
    `[sleepRender] effect-in-batches: ${n} clips → ${ranges.length} batches (scene-aligned, ≤${batchSize}) ` +
      `(concurrency ${batchConcurrency}, ${batchThreads} thr/batch, memCap ${memCap}, finish baked, stream-copy join)`,
  );

  const batchPaths = await mapLimit(ranges, batchConcurrency, async ([a, b], j) => {
    // Clone the slice so the duration adjustment never mutates the shared steps.
    const batch = steps.slice(a, b).map((s) => ({ ...s }));
    // Non-final batch: drop the trailing seam-overlap so the batch is exactly its
    // clips' narration span (see TIMING above). steps[b].overlapS is o[b+1].
    if (b < n) {
      const last = batch[batch.length - 1]!;
      last.durationS = Math.max(0.1, last.durationS - steps[b]!.overlapS);
    }
    const batchPath = path.join(workDir, `fxbatch_${j.toString().padStart(4, '0')}.mp4`);
    // Bake the finish (grade + ember) into THIS batch's encode — the whole point.
    await buildXfadeChain(batch, batchPath, { nvenc: opts.nvenc, audio: false, threads: batchThreads, finish });
    const durationS = await ffprobeDuration(batchPath).catch(() => 0);
    if (!(durationS > 0)) {
      throw new Error(`effect-in-batches batch ${j} produced an unprobeable/zero-length master: ${batchPath}`);
    }
    return batchPath;
  });

  // Lossless stream-copy join — instant, no re-encode. Requires every batch to
  // share codec params, which they do (identical finish encode settings). The
  // grade+ember are already baked in, so finalEncode still stream-copies.
  await concatDemuxer(batchPaths, opts.outPath);
}
