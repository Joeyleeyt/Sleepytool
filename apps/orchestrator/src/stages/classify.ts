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
// visualAnchor / continuityFromPrevious / movementIntensity / stimulationScore
// are sleep-mode reasoning fields: they force the model to commit to ONE world
// per shot, to relate each shot to the last, and to self-score its restfulness.
// visualAnchor + continuity are folded into the persisted visualSummary so the
// continuity actually reaches the image prompt; movement/stimulation are advisory.
const ShotVisualSchema = z.object({
  visualType: z.enum(VISUAL_TYPES),
  visualSummary: z.string(),
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

// Sleep-mode pacing: visuals are packed into ~10s "visual blocks" instead of
// per-sentence ~3-5s shots. TARGET is the ideal block length, MAX the ceiling a
// single visual may run, MIN the floor below which a block is folded into its
// neighbor. Raising these is the primary lever for "approximately 10s per
// visual" — the LLM never sets duration, packByVisualBlock does.
const SHOT_TARGET_S = Number(process.env.SHOT_TARGET_S ?? 10);
const SHOT_MAX_S = Number(process.env.SHOT_MAX_S ?? 12);
const SHOT_MIN_S = Number(process.env.SHOT_MIN_S ?? 8);

// Only these visual types have wired-up workers in safe-mode. Any other type
// the LLM emits is downgraded to atmospheric_broll so the pipeline never hangs.
const SUPPORTED_VISUAL_TYPES = new Set(['cinematic_video', 'image_with_motion', 'atmospheric_broll']);

// Deterministic treatment used only when the LLM returns fewer visuals than
// there are chunks (or fails entirely). Rotates the camera so consecutive
// fallback shots still feel different.
const FALLBACK_CAMERAS = ['ken_burns_in', 'dolly_in', 'orbit_left', 'ken_burns_out'] as const;
function fallbackVisual(i: number, narration: string): ShotVisual {
  return {
    visualType: 'atmospheric_broll',
    visualSummary: summarize(narration),
    cameraMovement: FALLBACK_CAMERAS[i % FALLBACK_CAMERAS.length]!,
    lens: '50mm_natural',
    fxRecommendation: { embers: 'subtle', smoke: 'off', filmGrain: 0.08, glow: 'low', vignette: 0.4 },
    transitionIn: 'cut',
    transitionOut: 'cut',
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
};

function containsAny(haystack: string, needles: string[]): boolean {
  const h = haystack.toLowerCase();
  return needles.some((n) => n && h.includes(n.toLowerCase()));
}

// Deterministic backstop against the classify LLM drifting off-world (e.g.
// illustrating a literal narration noun like "a birth certificate in a drawer"
// for a deep-space film). A shot is off-world when its anchor/summary names a
// FORBIDDEN domain, or — when an allow-list exists — names NONE of the allowed
// world vocabulary. Such shots are rewritten to a generic, in-world ambient
// view so a single bad LLM choice can never reach the image prompt. No-op when
// the project has no world contract (allowed + forbidden both empty).
function enforceWorld(v: ShotVisual, world: WorldContract): { anchor: string | null; summary: string } | null {
  const anchor = v.visualAnchor ?? '';
  const summary = v.visualSummary ?? '';
  const text = `${anchor} ${summary}`;
  const hitsForbidden = world.forbidden.length > 0 && containsAny(text, world.forbidden);
  // World vocabulary = the allowed domains plus the world name itself, so a
  // summary that says "deep space" instead of an exact domain word still passes.
  const vocab = world.allowed.length
    ? [...world.allowed, ...(world.worldName ? [world.worldName] : [])]
    : [];
  const inWorld = vocab.length === 0 ? true : containsAny(text, vocab);
  if (!hitsForbidden && inWorld) return null; // already in-world — keep as-is

  const subject = world.allowed[0] ?? world.worldName ?? 'the surrounding world';
  return {
    anchor: subject,
    summary:
      `A slow, still, low-stimulation ambient view of ${subject}` +
      `${world.worldName ? ` within ${world.worldName}` : ''}, dark, quiet and barely moving.`,
  };
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
  };
  const world: WorldContract = {
    worldName: tAnalysis.visualWorld ? tAnalysis.visualWorld.replace(/_/g, ' ') : null,
    allowed: (tAnalysis.allowedVisualDomains ?? []).filter(Boolean),
    forbidden: (tAnalysis.forbiddenVisualDomains ?? []).filter(Boolean),
  };

  // eslint-disable-next-line no-console
  console.log(
    `[classify] scenes=${scenes.length} world="${world.worldName ?? 'none'}" ` +
      `allowed=${world.allowed.length} forbidden=${world.forbidden.length} — parallel LLM visuals`,
  );

  // Buffer all shots across scenes so the quota is enforced globally
  // (per-scene rebalancing would lose precision on short scenes).
  type Drafted = Parameters<typeof shotsRepo.bulkInsert>[0][number];

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
            // The hard niche boundary. Every visualAnchor must come from
            // allowedVisualDomains; nothing from forbiddenVisualDomains.
            world: {
              visualWorld: world.worldName,
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

      return chunks.map<Drafted>((c, i) => {
        const v = visuals[i] ?? fallbackVisual(i, c.text);
        // Deterministic guard: if the LLM drifted off-world (named a forbidden
        // thing, or nothing from the allowed world), replace its anchor/summary
        // with a generic in-world view before it can reach the image prompt.
        const corrected = enforceWorld(v, world);
        if (corrected) {
          // eslint-disable-next-line no-console
          console.warn(
            `[classify] scene ${scene.ordinal} shot ${i} off-world anchor "${v.visualAnchor ?? v.visualSummary}" → "${corrected.anchor}"`,
          );
        }
        const anchor = corrected ? corrected.anchor : v.visualAnchor;
        const summary = (corrected ? corrected.summary : v.visualSummary) || summarize(c.text);
        // Prepend the per-shot visualAnchor so the chosen "world" is baked into
        // the persisted summary the image/video prompt is built from — this is
        // how continuityFromPrevious reasoning actually reaches generation.
        const anchored = anchor ? `${anchor}; ${summary}` : summary;
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
        };
      });
    }),
  );
  const drafted: Drafted[] = perScene.flat();

  const rebalanced = applyVisualQuota(drafted);
  const counts = quotaCounts(rebalanced);

  // Re-group by scene so we can renumber ordinals per scene to satisfy the
  // shots_scene_ordinal_uq unique index, then flatten and issue ONE bulk
  // insert instead of N round-trips.
  const bySceneId = new Map<string, Drafted[]>();
  for (const row of rebalanced) {
    const arr = bySceneId.get(row.sceneId) ?? [];
    arr.push(row);
    bySceneId.set(row.sceneId, arr);
  }
  const allRows: Drafted[] = [];
  for (const scene of scenes) {
    const rows = bySceneId.get(scene.id);
    if (!rows || !rows.length) continue;
    rows.forEach((row, i) => { row.ordinal = i; });
    allRows.push(...rows);
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
