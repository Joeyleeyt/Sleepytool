import { z } from 'zod';
import { eventsRepo, projectsRepo, scenesRepo, shotsRepo, transcriptsRepo } from '@emberforge/db';
import { structured } from '@emberforge/ai-clients';
import { CLASSIFY_SYSTEM } from '@emberforge/prompt-engine';
import { FxSpecSchema } from '@emberforge/core/schemas';
import { CAMERA_MOVES, LENS_PROFILES, TRANSITIONS, VISUAL_TYPES } from '@emberforge/core';
import { applyVisualQuota, packByVisualBlock, quotaCounts, TARGET_IMAGE_RATIO } from '@emberforge/timeline-engine';

// Visuals-only contract: shot boundaries are decided deterministically as
// ~10s "visual blocks" (see packByVisualBlock), so the LLM no longer splits the
// narration — it only assigns the calm visual treatment for each pre-cut block.
//
// subject / activity / location / mood are the per-shot composition fields: the
// model derives them from THIS shot's narration but re-cast into the analyzed
// world/era, so each shot tracks its own sentence (no off-world "old man") while
// the subject VARIES shot-to-shot (anti-repetition / demonetization guard).
// continuityFromPrevious / movementIntensity / stimulationScore are sleep-mode
// reasoning fields. subject + activity + location + mood are folded into the
// persisted visualSummary the image/video prompt is built from. visualAnchor is
// kept optional for back-compat with older outputs.
const ShotVisualSchema = z.object({
  visualType: z.enum(VISUAL_TYPES),
  visualSummary: z.string(),
  // The transcript keywords this shot's visual was built from. Not persisted —
  // it forces the model to ground each subject in THIS sentence's own words
  // (transcript-driven visuals) rather than inventing an off-theme stand-in.
  keywords: z.array(z.string()).nullable().optional(),
  subject: z.string().nullable().optional(),
  // Whether this shot's subject includes a person/people. Drives shot-type
  // routing so people-subjects (the backbone of history/biography docs) never
  // land on the people-free atmospheric_broll path. Transient — not persisted.
  showsPeople: z.boolean().nullable().optional(),
  activity: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  mood: z.string().nullable().optional(),
  visualAnchor: z.string().nullable().optional(),
  continuityFromPrevious: z.string().nullable().optional(),
  cameraMovement: z.enum(CAMERA_MOVES),
  lens: z.enum(LENS_PROFILES),
  movementIntensity: z.number().min(0).max(1).nullable().optional(),
  stimulationScore: z.number().min(0).max(1).nullable().optional(),
  fxRecommendation: FxSpecSchema,
  transitionIn: z.enum(TRANSITIONS),
  transitionOut: z.enum(TRANSITIONS),
  soundtrackMood: z.string(),
});
const ShotVisualListSchema = z.object({ shots: z.array(ShotVisualSchema) });
type ShotVisual = z.infer<typeof ShotVisualSchema>;

// Sleep-mode pacing: visuals are packed into LONG "visual blocks" instead of
// per-sentence ~3-5s shots. TARGET is the ideal block length, MAX the ceiling a
// single visual may run, MIN the floor below which a block is folded into its
// neighbor. Raising these is the primary lever for longer-per-visual pacing —
// the LLM never sets duration, packByVisualBlock does.
//
// Client ask (6/11): "shots split by the transcript are too short — each shot
// should run over ~10s; if a sentence is shorter than ~10s, merge it with the
// next." MIN=10 is that floor (a block never closes below it, so short sentences
// keep merging forward); TARGET=12 is the typical length; MAX=16 the ceiling.
const SHOT_TARGET_S = Number(process.env.SHOT_TARGET_S ?? 12);
const SHOT_MAX_S = Number(process.env.SHOT_MAX_S ?? 16);
const SHOT_MIN_S = Number(process.env.SHOT_MIN_S ?? 10);

// Only these visual types have wired-up workers in safe-mode. Any other type
// the LLM emits is downgraded to atmospheric_broll so the pipeline never hangs.
const SUPPORTED_VISUAL_TYPES = new Set(['cinematic_video', 'image_with_motion', 'atmospheric_broll']);

// Deterministic treatment used only when the LLM returns fewer visuals than
// there are chunks (or fails entirely). The visual is built straight from THIS
// chunk's narration (transcript-driven), so the fallback still tracks what is
// being said; the camera rotates so consecutive fallbacks feel different, and a
// soft transition is always used so cuts are never jarring.
const FALLBACK_CAMERAS = ['ken_burns_in', 'dolly_in', 'orbit_left', 'ken_burns_out'] as const;
const FALLBACK_TRANSITIONS = ['crossfade', 'dip_to_black'] as const;
function fallbackVisual(i: number, narration: string): ShotVisual {
  return {
    visualType: 'atmospheric_broll',
    visualSummary: summarize(narration),
    subject: null,
    cameraMovement: FALLBACK_CAMERAS[i % FALLBACK_CAMERAS.length]!,
    lens: '50mm_natural',
    fxRecommendation: { embers: 'off', smoke: 'off', filmGrain: 0.08, glow: 'low', vignette: 0.4 },
    transitionIn: FALLBACK_TRANSITIONS[i % FALLBACK_TRANSITIONS.length]!,
    transitionOut: FALLBACK_TRANSITIONS[(i + 1) % FALLBACK_TRANSITIONS.length]!,
    soundtrackMood: 'ambient_drone',
  };
}

function summarize(narration: string, max = 140): string {
  const clean = narration.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1).replace(/[,;:.]?\s+\S*$/, '') + '…';
}

// The transcript-level visual-world contract (set by the analyze stage). Empty
// for labs-only / legacy projects, in which case the backstop below is a no-op.
type WorldContract = {
  worldName: string | null;
  allowed: string[];
  forbidden: string[];
  // The documentary niche (from the analyze stage). Handed to the LLM so it can
  // apply genre-specific shot rules — e.g. "history" keeps named historical
  // people on screen as era archetypes instead of recasting them to scenery.
  genre: string | null;
};

function containsAny(haystack: string, needles: string[]): boolean {
  const h = haystack.toLowerCase();
  return needles.some((n) => n && h.includes(n.toLowerCase()));
}

// Deterministic backstop with a DELIBERATELY NARROW remit: it only fires when a
// shot names a FORBIDDEN / off-aesthetic thing (on-screen text, UI, charts,
// modern clutter — the generic, subject-independent ban list). It no longer
// requires shots to match an allow-list: transcript-driven content that stays on
// subject is kept verbatim, which is the whole point — the picture must follow
// what the sentence actually says, not a fixed rotation palette. No-op when the
// project has no forbidden list (labs-only / legacy projects).
function enforceWorld(
  v: ShotVisual,
  world: WorldContract,
): { subject: string; summary: string } | null {
  const text = `${v.subject ?? ''} ${v.visualAnchor ?? ''} ${v.visualSummary ?? ''}`;
  const hitsForbidden = world.forbidden.length > 0 && containsAny(text, world.forbidden);
  if (!hitsForbidden) return null; // on-subject, transcript-driven — keep as-is

  // Names a banned off-aesthetic thing — replace with a neutral, in-subject
  // ambient view so a single bad LLM choice can never reach the image prompt.
  const subject = world.worldName ?? 'the surrounding scene';
  return {
    subject,
    summary:
      `A slow, still, low-stimulation ambient view${world.worldName ? ` of ${world.worldName}` : ''}, ` +
      `dark, quiet and barely moving.`,
  };
}

// Compose the persisted visualSummary the image/video prompt is built from out
// of the per-shot composition fields. Prefer the structured subject/activity/
// location/mood (the new contract); fall back to the model's free-text
// visualSummary, then to a summary of the narration. This is how each shot's own
// sentence — its own transcript keywords — reaches generation.
// A locative phrase in the subject signals it ALREADY names where it sits
// (e.g. "a regal figure in a softly lit palace"), so appending the separate
// location field would just repeat the place ("…palace, within the gilded walls
// of her palace"). When the subject already has a place, the location fragment
// is dropped; activity is always kept. We require the preposition to be followed
// by a determiner ("in a palace", "on her throne") so non-locative idioms like
// "in deep thought", "at rest" or "before dawn" don't trip it and discard a
// genuine location.
const SUBJECT_HAS_PLACE = /\b(in|within|inside|atop|on|at|beneath|under|among|amid|beside|near)\s+(a|an|the|his|her|their|its|this|that)\b/i;

function composeSummary(v: ShotVisual, fallbackNarration: string): string {
  const subject = (v.subject ?? '').trim();
  if (subject) {
    const location = (v.location ?? '').trim();
    const includeLocation = location && !SUBJECT_HAS_PLACE.test(subject);
    const parts = [
      subject,
      (v.activity ?? '').trim(),
      includeLocation ? location : '',
    ].filter(Boolean);
    const base = parts.join(', ');
    const mood = (v.mood ?? '').trim();
    const lead = mood ? `${mood}: ${base}` : base;
    // Keep the model's richer sentence if it already elaborates on the subject.
    const summary = (v.visualSummary ?? '').trim();
    return summary && summary.toLowerCase().includes(subject.toLowerCase()) ? summary : lead;
  }
  return (v.visualSummary ?? '').trim() || summarize(fallbackNarration);
}

export async function classifyStage(projectId: string) {
  const started = Date.now();
  // eslint-disable-next-line no-console
  console.log(`[classify] start projectId=${projectId}`);
  await eventsRepo.emit(projectId, 'classify', 'started');
  const scenes = await scenesRepo.findByProject(projectId);
  if (scenes.length === 0) throw new Error('no scenes to classify');

  // Transcript-level visual-world contract (from the analyze stage). Handed to
  // the LLM so it commits each shot to the niche, and enforced deterministically
  // afterwards. Mirrors the resolution in prompt.ts. Empty for labs-only/legacy.
  const transcript = await transcriptsRepo.findByProject(projectId);
  const tAnalysis = (transcript?.analysisJson ?? {}) as {
    visualWorld?: string | null;
    allowedVisualDomains?: string[] | null;
    forbiddenVisualDomains?: string[] | null;
    genre?: string | null;
  };
  const world: WorldContract = {
    worldName: tAnalysis.visualWorld ? tAnalysis.visualWorld.replace(/_/g, ' ') : null,
    allowed: (tAnalysis.allowedVisualDomains ?? []).filter(Boolean),
    forbidden: (tAnalysis.forbiddenVisualDomains ?? []).filter(Boolean),
    genre: tAnalysis.genre ?? null,
  };

  // eslint-disable-next-line no-console
  console.log(
    `[classify] scenes=${scenes.length} world="${world.worldName ?? 'none'}" ` +
      `allowed=${world.allowed.length} forbidden=${world.forbidden.length} — parallel LLM visuals`,
  );

  // Buffer all shots across scenes so the quota is enforced globally
  // (per-scene rebalancing would lose precision on short scenes).
  type Drafted = Parameters<typeof shotsRepo.bulkInsert>[0][number];
  // Drafted + a transient showsPeople flag used only to drive shot-type routing
  // in applyVisualQuota; stripped before the DB insert (no such column).
  type DraftedWithPeople = Drafted & { showsPeople: boolean };

  // Scenes are independent until the global applyVisualQuota step — fan out
  // the per-scene LLM calls so wall-clock = slowest single call, not the sum.
  // The downstream quota + per-scene ordinal renumber preserves ordering.
  const perScene = await Promise.all(
    scenes.map(async (scene) => {
      const sceneStart = Date.now();

      // 1) Deterministic, ~10s "visual block" boundaries. Multiple sentences
      //    share one visual so the picture holds still long enough to feel
      //    restful; blocks aim at SHOT_TARGET_S and never exceed SHOT_MAX_S.
      const chunks = packByVisualBlock(scene.narrationChunk, {
        minS: SHOT_MIN_S,
        maxS: SHOT_MAX_S,
        targetS: SHOT_TARGET_S,
      });
      if (chunks.length === 0) return [];

      // 2) LLM assigns the cinematic treatment per pre-cut chunk — same visual
      //    decisions as before, it just no longer controls the text split.
      let visuals: ShotVisual[] = [];
      try {
        const result = await structured({
          model: 'haiku',
          system: CLASSIFY_SYSTEM,
          user: JSON.stringify({
            // Soft hint only: visualWorld + allowedVisualDomains describe the
            // film's overall subject/tone so shots stay coherent. The subject
            // itself is drawn from each shot's narration, NOT cycled from this
            // list. forbiddenVisualDomains remains a hard ban.
            world: {
              visualWorld: world.worldName,
              genre: world.genre,
              allowedVisualDomains: world.allowed,
              forbiddenVisualDomains: world.forbidden,
            },
            scene: { title: scene.title, analysis: scene.analysis },
            shots: chunks.map((c, i) => ({ ordinal: i, narrationText: c.text })),
          }),
          schema: ShotVisualListSchema,
          maxTokens: 8_000,
          cacheSystem: true,
        });
        visuals = result.shots;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[classify] scene ${scene.ordinal} visual LLM failed: ${(err as Error).message} — using deterministic fallback`,
        );
      }

      // eslint-disable-next-line no-console
      console.log(
        `[classify] scene ${scene.ordinal} ok chunks=${chunks.length} visuals=${visuals.length} ${Date.now() - sceneStart}ms`,
      );

      return chunks.map<DraftedWithPeople>((c, i) => {
        const v = visuals[i] ?? fallbackVisual(i, c.text);
        // Deterministic guard with a narrow remit: only if the LLM named a
        // forbidden / off-aesthetic thing (text, UI, charts, modern clutter) is
        // its subject/summary replaced with a neutral in-subject view before it
        // can reach the image prompt. Transcript-driven, on-subject shots pass
        // through untouched.
        const corrected = enforceWorld(v, world);
        if (corrected) {
          // eslint-disable-next-line no-console
          console.warn(
            `[classify] scene ${scene.ordinal} shot ${i} off-world subject "${v.subject ?? v.visualAnchor ?? v.visualSummary}" → "${corrected.subject}"`,
          );
        }
        // The persisted visualSummary the image/video prompt is built from. When
        // corrected, use the rotated in-world view; otherwise compose it from the
        // per-shot subject/activity/location/mood so each shot tracks its own
        // sentence while staying inside the world.
        const anchored = corrected ? corrected.summary : composeSummary(v, c.text);
        return {
          sceneId: scene.id,
          projectId,
          ordinal: i,
          narrationText: c.text,
          durationS: String(c.durationS),
          visualType: SUPPORTED_VISUAL_TYPES.has(v.visualType) ? v.visualType : 'atmospheric_broll',
          visualSummary: anchored,
          cameraMovement: v.cameraMovement,
          lens: v.lens,
          fxRecommendation: v.fxRecommendation,
          transitionIn: v.transitionIn,
          transitionOut: v.transitionOut,
          soundtrackMood: v.soundtrackMood,
          // A corrected (off-aesthetic) shot is forced to a neutral ambient view,
          // which has no people; otherwise trust the LLM's people call.
          showsPeople: corrected ? false : v.showsPeople ?? false,
        };
      });
    }),
  );
  const drafted: DraftedWithPeople[] = perScene.flat();

  // applyVisualQuota reads showsPeople so a people-subject is never routed to the
  // people-free atmospheric_broll path (it goes to image_with_motion/cinematic).
  const rebalanced = applyVisualQuota(drafted);
  const counts = quotaCounts(rebalanced);

  // Re-group by scene so we can renumber ordinals per scene to satisfy the
  // shots_scene_ordinal_uq unique index, then flatten and issue ONE bulk
  // insert instead of N round-trips.
  const bySceneId = new Map<string, DraftedWithPeople[]>();
  for (const row of rebalanced) {
    const arr = bySceneId.get(row.sceneId) ?? [];
    arr.push(row);
    bySceneId.set(row.sceneId, arr);
  }
  const allRows: Drafted[] = [];
  for (const scene of scenes) {
    const rows = bySceneId.get(scene.id);
    if (!rows || !rows.length) continue;
    // Strip the transient showsPeople before insert (no such column).
    rows.forEach((row, i) => {
      const { showsPeople: _showsPeople, ...rest } = row;
      allRows.push({ ...rest, ordinal: i });
    });
  }
  if (allRows.length > 0) await shotsRepo.bulkInsert(allRows);

  await projectsRepo.setStatus(projectId, 'classified');
  await eventsRepo.emit(projectId, 'classify', 'succeeded', {
    shots: counts.total,
    imageShots: counts.image,
    videoShots: counts.video,
    imageRatioTarget: TARGET_IMAGE_RATIO,
    imageRatioActual: counts.total ? counts.image / counts.total : 0,
  });
  // eslint-disable-next-line no-console
  console.log(
    `[classify] done projectId=${projectId} shots=${counts.total} ` +
      `(img=${counts.image} vid=${counts.video}) ${Date.now() - started}ms`,
  );
  return { shots: counts.total, ...counts };
}
