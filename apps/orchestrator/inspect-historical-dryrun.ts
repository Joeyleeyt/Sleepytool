/**
 * Dry-run the prompt-generation pipeline on a HISTORICAL transcript WITHOUT
 * touching the DB (no project/scene/shot rows are written). It exercises the
 * real ANALYZE_SYSTEM → CLASSIFY_SYSTEM → builder chain so we can eyeball the
 * generated prompts for the new genre="history" figure-archetype handling.
 *
 *   pnpm --filter @emberforge/orchestrator exec tsx apps/orchestrator/inspect-historical-dryrun.ts
 *
 * It makes real LLM calls (analyze=gpt-4o, classify=gpt-4o-mini via the router)
 * and one harmless visual-memory SELECT per shot for a throwaway projectId.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, parse } from 'node:path';

function findDotEnv(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  const root = parse(dir).root;
  while (dir !== root) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return '.env';
}
async function loadDotEnv(path = findDotEnv()) {
  try {
    const txt = await readFile(path, 'utf8');
    for (const line of txt.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const key = t.slice(0, eq).trim();
      let value = t.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    /* .env missing is fine */
  }
}
await loadDotEnv();

const { z } = await import('zod');
const { structured } = await import('@emberforge/ai-clients');
const { ANALYZE_SYSTEM, CLASSIFY_SYSTEM, buildStyleAnchor, OFF_WORLD_NEGATIVE, buildVeo3Prompt, buildImagePrompt, buildAtmosphericPrompt } = await import('@emberforge/prompt-engine');
const { TranscriptAnalysisSchema, FxSpecSchema } = await import('@emberforge/core/schemas');
const { CAMERA_MOVES, LENS_PROFILES, TRANSITIONS, VISUAL_TYPES } = await import('@emberforge/core');
const { packByVisualBlock } = await import('@emberforge/timeline-engine');

// A short historical transcript that explicitly names figures (Caesar, Plato,
// Cleopatra, da Vinci) so the genre="history" figure rule has something to bite.
const TRANSCRIPT = `In the dim halls of ancient Rome, the senate gathered as the lamps burned low.
Julius Caesar entered the chamber, his presence quieting the murmuring senators.
Far to the east, generations earlier, Plato had taught his students beneath the olive trees of Athens.
He spoke softly of justice and the soul while the young men listened.
In Egypt, Cleopatra received foreign envoys within the gilded walls of her palace.
Centuries later, Leonardo da Vinci bent over his notebooks, sketching machines the world had never seen.
The Tiber drifted black and silent past the sleeping marble city, and the empire dreamed on.`;

const ShotVisualSchema = z.object({
  visualType: z.enum(VISUAL_TYPES),
  visualSummary: z.string(),
  keywords: z.array(z.string()).nullable().optional(),
  subject: z.string().nullable().optional(),
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

// --- copied verbatim from classify.ts so the dry run mirrors production ---
function containsAny(haystack: string, needles: string[]): boolean {
  const h = haystack.toLowerCase();
  return needles.some((n) => n && h.includes(n.toLowerCase()));
}
function enforceWorld(v: ShotVisual, world: { worldName: string | null; forbidden: string[] }) {
  const text = `${v.subject ?? ''} ${v.visualAnchor ?? ''} ${v.visualSummary ?? ''}`;
  const hitsForbidden = world.forbidden.length > 0 && containsAny(text, world.forbidden);
  if (!hitsForbidden) return null;
  const subject = world.worldName ?? 'the surrounding scene';
  return {
    subject,
    summary:
      `A slow, still, low-stimulation ambient view${world.worldName ? ` of ${world.worldName}` : ''}, ` +
      `dark, quiet and barely moving.`,
  };
}
function summarize(narration: string, max = 140): string {
  const clean = narration.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1).replace(/[,;:.]?\s+\S*$/, '') + '…';
}
const SUBJECT_HAS_PLACE = /\b(in|within|inside|atop|on|at|beneath|under|among|amid|beside|near)\s+(a|an|the|his|her|their|its|this|that)\b/i;
function composeSummary(v: ShotVisual, fallbackNarration: string): string {
  const subject = (v.subject ?? '').trim();
  if (subject) {
    const location = (v.location ?? '').trim();
    const includeLocation = location && !SUBJECT_HAS_PLACE.test(subject);
    const parts = [subject, (v.activity ?? '').trim(), includeLocation ? location : ''].filter(Boolean);
    const base = parts.join(', ');
    const mood = (v.mood ?? '').trim();
    const lead = mood ? `${mood}: ${base}` : base;
    const summary = (v.visualSummary ?? '').trim();
    return summary && summary.toLowerCase().includes(subject.toLowerCase()) ? summary : lead;
  }
  return (v.visualSummary ?? '').trim() || summarize(fallbackNarration);
}

const PROJECT_ID = '00000000-0000-0000-0000-000000000000'; // throwaway UUID; visual-memory SELECT returns []
const STYLE_PRESET = 'noir_documentary' as never; // valid preset id; palette only affects look tags

function bar(s: string) { console.log('\n' + '='.repeat(78) + `\n${s}\n` + '='.repeat(78)); }

// 1) ANALYZE
bar('STAGE 1 — ANALYZE');
const analysis = await structured({
  model: 'opus',
  system: ANALYZE_SYSTEM,
  user: TRANSCRIPT,
  schema: TranscriptAnalysisSchema,
  maxTokens: 8_000,
  cacheSystem: true,
});
console.log('genre              =', (analysis as Record<string, unknown>).genre ?? '(none)');
console.log('visualWorld        =', analysis.visualWorld ?? '(none)');
console.log('globalTopic        =', analysis.globalTopic);
console.log('toneSummary        =', analysis.toneSummary);
console.log('allowedVisualDomains =', JSON.stringify(analysis.allowedVisualDomains));
console.log('forbiddenVisualDomains =', JSON.stringify(analysis.forbiddenVisualDomains));

const world = {
  worldName: analysis.visualWorld ? analysis.visualWorld.replace(/_/g, ' ') : null,
  genre: ((analysis as Record<string, unknown>).genre as string | null) ?? null,
  allowed: (analysis.allowedVisualDomains ?? []).filter(Boolean),
  forbidden: (analysis.forbiddenVisualDomains ?? []).filter(Boolean),
};

// 2) CLASSIFY (single synthetic scene = whole transcript)
bar('STAGE 2 — CLASSIFY');
const chunks = packByVisualBlock(TRANSCRIPT, { minS: 10, maxS: 16, targetS: 12 });
console.log(`packed ${chunks.length} visual blocks`);
const sceneAnalysis = {
  topic: analysis.globalTopic,
  atmosphere: analysis.palette ?? analysis.toneSummary,
  visualOpportunities: (analysis.allowedVisualDomains ?? []).slice(0, 8),
};
const classified = await structured({
  model: 'haiku',
  system: CLASSIFY_SYSTEM,
  user: JSON.stringify({
    world: {
      visualWorld: world.worldName,
      genre: world.genre,
      allowedVisualDomains: world.allowed,
      forbiddenVisualDomains: world.forbidden,
    },
    scene: { title: 'Historical dry run', analysis: sceneAnalysis },
    shots: chunks.map((c, i) => ({ ordinal: i, narrationText: c.text })),
  }),
  schema: ShotVisualListSchema,
  maxTokens: 8_000,
  cacheSystem: true,
});

// 3) BUILD PROMPTS
bar('STAGE 3 — BUILD PROMPTS');
const hasWorldContract = world.allowed.length > 0 || world.forbidden.length > 0 || world.worldName !== null;
const domainNegative = hasWorldContract ? [...world.forbidden, OFF_WORLD_NEGATIVE].filter(Boolean).join(', ') : null;
const anchor = buildStyleAnchor({ globalTopic: analysis.globalTopic, toneSummary: analysis.toneSummary, atmosphere: sceneAnalysis.atmosphere });

const SUPPORTED = new Set(['cinematic_video', 'image_with_motion', 'atmospheric_broll']);

for (let i = 0; i < chunks.length; i++) {
  const c = chunks[i]!;
  const v = classified.shots[i];
  if (!v) { console.log(`\n[shot ${i}] (no LLM visual)`); continue; }
  const corrected = enforceWorld(v, world);
  const visualType = SUPPORTED.has(v.visualType) ? v.visualType : 'atmospheric_broll';
  const visualSummary = corrected ? corrected.summary : composeSummary(v, c.text);

  const shot = {
    id: `dry-${i}`, sceneId: 'scene', projectId: PROJECT_ID, ordinal: i,
    narrationText: c.text, durationS: Number(c.durationS),
    visualType, visualSummary,
    cameraMovement: v.cameraMovement, lens: v.lens,
    fxRecommendation: v.fxRecommendation,
    transitionIn: v.transitionIn, transitionOut: v.transitionOut,
    soundtrackMood: v.soundtrackMood,
  } as never;

  let built: { prompt: string; negative: string };
  if (visualType === 'cinematic_video') built = await buildVeo3Prompt({ shot, projectId: PROJECT_ID, stylePreset: STYLE_PRESET, anchor, extraNegative: domainNegative });
  else if (visualType === 'image_with_motion') built = await buildImagePrompt({ shot, projectId: PROJECT_ID, stylePreset: STYLE_PRESET, anchor, extraNegative: domainNegative });
  else built = await buildAtmosphericPrompt({ shot, projectId: PROJECT_ID, stylePreset: STYLE_PRESET, anchor, extraNegative: domainNegative });

  console.log(`\n────── SHOT ${i} ──────`);
  console.log('narration   :', c.text.replace(/\s+/g, ' ').trim());
  console.log('keywords    :', JSON.stringify(v.keywords));
  console.log('subject     :', v.subject, corrected ? '  (⚠ enforceWorld replaced → ' + corrected.subject + ')' : '');
  console.log('showsPeople :', v.showsPeople, '   visualType:', visualType, v.visualType !== visualType ? `(downgraded from ${v.visualType})` : '');
  console.log('visualSummary:', visualSummary);
  console.log('PROMPT      :', built.prompt);
  console.log('NEGATIVE    :', built.negative);
}

process.exit(0);
