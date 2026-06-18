import { z } from 'zod';
import { CAMERA_MOVES, EMOTIONS, LENS_PROFILES, PACING, STYLE_PRESETS, TRANSITIONS, VISUAL_TYPES } from '../enums.js';

export const CreateProjectSchema = z.object({
  title: z.string().min(1).max(200),
  transcript: z.string().min(100),
  stylePreset: z.enum(STYLE_PRESETS).optional(),
  targetRes: z.enum(['1920x1080', '3840x2160']).optional(),
  targetFps: z.union([z.literal(24), z.literal(30), z.literal(60)]).optional(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

export const FxSpecSchema = z.object({
  embers: z.enum(['off', 'subtle', 'medium', 'heavy']),
  smoke: z.enum(['off', 'low', 'high']),
  filmGrain: z.number().min(0).max(1),
  glow: z.enum(['off', 'low', 'high']),
  vignette: z.number().min(0).max(1),
});

export const SceneAnalysisSchema = z.object({
  topic: z.string(),
  emotion: z.enum(EMOTIONS),
  pacing: z.enum(PACING),
  tension: z.number().min(0).max(1),
  atmosphere: z.string(),
  visualOpportunities: z.array(z.string()),
  // Nullable AND optional so both the Claude path (omits when absent) and
  // the OpenAI Structured Outputs path (returns explicit null) parse cleanly.
  timelineMarker: z.string().nullable().optional(),
  concepts: z.object({
    scientific: z.array(z.string()),
    abstract: z.array(z.string()),
  }),
});

export const SceneDraftSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  title: z.string(),
  narrationChunk: z.string(),
  analysis: SceneAnalysisSchema,
  estimatedDurationS: z.number().positive(),
  startWordIdx: z.number().int().nonnegative(),
  endWordIdx: z.number().int().nonnegative(),
});

export const SceneListSchema = z.object({
  scenes: z.array(SceneDraftSchema),
});

export const ShotDraftSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  narrationText: z.string(),
  durationS: z.number().min(3).max(20),
  visualType: z.enum(VISUAL_TYPES),
  visualSummary: z.string(),
  cameraMovement: z.enum(CAMERA_MOVES),
  lens: z.enum(LENS_PROFILES),
  fxRecommendation: FxSpecSchema,
  transitionIn: z.enum(TRANSITIONS),
  transitionOut: z.enum(TRANSITIONS),
  soundtrackMood: z.string(),
});

export const TranscriptAnalysisSchema = z.object({
  globalTopic: z.string(),
  arc: z.array(z.object({ stage: z.string(), from: z.number(), to: z.number() })),
  recurringEntities: z.array(
    z.object({
      kind: z.enum(['character', 'environment', 'concept']),
      name: z.string(),
      descriptor: z.string(),
    }),
  ),
  toneSummary: z.string(),
  estimatedDurationS: z.number().positive(),
  // --- Sleep-documentary visual-world fields ---------------------------------
  // All nullable+optional so legacy/labs-only projects (which skip analyze or
  // predate these fields) still parse. Persisted inside transcripts.analysisJson
  // and read back at prompt-build time — no dedicated DB columns required.
  visualWorld: z.string().nullable().optional(),            // canonical world id, e.g. "deep_space"
  allowedVisualDomains: z.array(z.string()).nullable().optional(),   // what MAY appear on screen
  forbiddenVisualDomains: z.array(z.string()).nullable().optional(), // injected into the negative prompt
  palette: z.string().nullable().optional(),                // e.g. "dark, low-saturation indigo and black"
  movementStyle: z.string().nullable().optional(),          // e.g. "slow drift and gentle push-in only"
  stimulationLevel: z.enum(['minimal', 'low', 'medium']).nullable().optional(),
  // The documentary niche. Drives genre-specific shot rules in the classify
  // stage (e.g. "history" unlocks figure-accurate handling so named historical
  // people stay on screen as descriptive era archetypes instead of being recast
  // to scenery). nullable+optional for legacy/labs-only projects that predate it.
  genre: z.enum(['space', 'history', 'philosophy', 'nature', 'science', 'other']).nullable().optional(),
});
