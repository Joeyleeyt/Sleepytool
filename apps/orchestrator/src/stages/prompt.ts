import { eventsRepo, projectsRepo, promptsRepo, scenesRepo, shotsRepo, transcriptsRepo } from '@emberforge/db';
import { inputHash, type Shot, type StylePresetId } from '@emberforge/core';
import { buildAtmosphericPrompt, buildImagePrompt, buildStyleAnchor, buildVeo3Prompt, OFF_WORLD_NEGATIVE } from '@emberforge/prompt-engine';

export async function promptStage(projectId: string) {
  await eventsRepo.emit(projectId, 'prompt', 'started');
  const project = await projectsRepo.findById(projectId);
  if (!project) throw new Error('project not found');
  const shots = await shotsRepo.findByProject(projectId);

  const stylePreset = project.stylePreset as StylePresetId;

  // Project-wide continuity inputs from the analyse step. `analysisJson` is
  // jsonb (typed `unknown`); narrow defensively since labs-only projects skip
  // analyze and leave it null. Scene atmosphere comes from the scenes table.
  const transcript = await transcriptsRepo.findByProject(projectId);
  const analysis = (transcript?.analysisJson ?? {}) as {
    globalTopic?: string;
    toneSummary?: string;
    visualWorld?: string | null;
    allowedVisualDomains?: string[] | null;
    forbiddenVisualDomains?: string[] | null;
  };
  const scenes = await scenesRepo.findByProject(projectId);
  const atmosphereByScene = new Map(scenes.map((s) => [s.id, s.atmosphere ?? null]));

  // Sleep-mode visual-world guardrails. The positive prompt is NOT pinned to the
  // world anymore — each shot's subject comes from its own transcript (see the
  // classify stage). The world contract now only feeds the NEGATIVE prompt: the
  // project-specific forbiddenVisualDomains AND the categorical OFF_WORLD_NEGATIVE
  // baseline (documents, charts, symbolic props, UI…) so off-aesthetic intrusions
  // the analyze step never foresaw are still suppressed. allowedVisualDomains is
  // used only to detect whether a world contract exists. All no-ops when none
  // exists (legacy / labs-only projects).
  const allowedDomains = (analysis.allowedVisualDomains ?? []).filter(Boolean);
  const forbiddenDomains = (analysis.forbiddenVisualDomains ?? []).filter(Boolean);
  const worldName = analysis.visualWorld ? analysis.visualWorld.replace(/_/g, ' ') : null;
  // A world contract exists if the analyze step set any of these fields.
  const hasWorldContract = allowedDomains.length > 0 || forbiddenDomains.length > 0 || worldName !== null;
  const domainNegative = hasWorldContract
    ? [...forbiddenDomains, OFF_WORLD_NEGATIVE].filter(Boolean).join(', ')
    : null;

  for (const row of shots) {
    const shot = rowToShot(row);
    const visualTarget = pickTarget(shot.visualType);
    const voice = process.env.LABS69_VOICE_ID ?? 'narrator_deep_male_1';
    const ttsHash = inputHash({ text: shot.narrationText, voice });

    // Shared global-style anchor injected into every shot so the whole video
    // keeps one coherent look + mood and the stream doesn't drift shot-to-shot.
    const baseAnchor = buildStyleAnchor({
      globalTopic: analysis.globalTopic,
      toneSummary: analysis.toneSummary,
      atmosphere: atmosphereByScene.get(shot.sceneId) ?? null,
    });
    // Keep the anchor LIGHT: the shared world/mood cue only, with no per-shot
    // "set within the world of X" pin. That pin re-anchored every shot to the
    // generic scenario and narrowed the visual range; the shot's own
    // transcript-derived subject leads the prompt instead. Off-aesthetic
    // intrusions are still suppressed via the negative prompt (forbiddenDomains
    // + OFF_WORLD_NEGATIVE) below.
    const anchor = baseAnchor;

    // Visual prompt
    if (visualTarget) {
      const built = await buildVisualPrompt(shot, projectId, stylePreset, anchor, domainNegative);
      const hash = inputHash({ prompt: built.prompt, negative: built.negative, target: visualTarget, model_version: 'v1' });
      await promptsRepo.upsert({
        shotId: shot.id,
        target: visualTarget,
        promptText: built.prompt,
        negative: built.negative,
        params: { stylePreset, visualType: shot.visualType, cameraMovement: shot.cameraMovement, lens: shot.lens },
        inputHash: hash,
      });
    }

    // TTS prompt (deterministic — just the text)
    await promptsRepo.upsert({
      shotId: shot.id,
      target: '69labs.tts',
      promptText: shot.narrationText,
      negative: null,
      params: { voice, pace: 'medium' },
      inputHash: ttsHash,
    });
  }

  await projectsRepo.setStatus(projectId, 'prompted');
  await eventsRepo.emit(projectId, 'prompt', 'succeeded', { shots: shots.length });
  return { shots: shots.length };
}

const DISABLE_VEO3 = (process.env.DISABLE_VEO3 ?? 'false') === 'true';

function pickTarget(vt: Shot['visualType']): string | null {
  switch (vt) {
    case 'cinematic_video':
      // When Veo 3 is unavailable, route cinematic shots to 69labs video
      return DISABLE_VEO3 ? '69labs.video' : 'veo3';
    case 'image_with_motion':
      return '69labs.image';
    case 'atmospheric_broll':
      return '69labs.video';
    // Safe-mode: motion-graphics types fall back to atmospheric video
    case 'infographic':
    case 'animated_diagram':
    case 'motion_typography':
      return '69labs.video';
  }
}

async function buildVisualPrompt(
  shot: Shot,
  projectId: string,
  stylePreset: StylePresetId,
  anchor: string,
  extraNegative: string | null,
) {
  switch (shot.visualType) {
    case 'cinematic_video':
      // Veo3 prompt format works fine for 69labs video too — both expect a
      // single cinematic description string.
      return buildVeo3Prompt({ shot, projectId, stylePreset, anchor, extraNegative });
    case 'image_with_motion':
      return buildImagePrompt({ shot, projectId, stylePreset, anchor, extraNegative });
    case 'atmospheric_broll':
      return buildAtmosphericPrompt({ shot, projectId, stylePreset, anchor, extraNegative });
    // Safe-mode fallback for motion-graphics types
    case 'infographic':
    case 'animated_diagram':
    case 'motion_typography':
      return buildAtmosphericPrompt({ shot, projectId, stylePreset, anchor, extraNegative });
  }
}

function rowToShot(row: Awaited<ReturnType<typeof shotsRepo.findByProject>>[number]): Shot {
  return {
    id: row.id,
    sceneId: row.sceneId,
    projectId: row.projectId,
    ordinal: row.ordinal,
    narrationText: row.narrationText,
    durationS: Number(row.durationS),
    visualType: row.visualType,
    visualSummary: row.visualSummary ?? '',
    cameraMovement: (row.cameraMovement ?? 'static') as Shot['cameraMovement'],
    lens: (row.lens ?? '35mm_anamorphic') as Shot['lens'],
    fxRecommendation: (row.fxRecommendation ?? {
      embers: 'medium', smoke: 'off', filmGrain: 0.08, glow: 'low', vignette: 0.4,
    }) as Shot['fxRecommendation'],
    // Sleep-mode default: soft crossfades, never hard cuts (client feedback:
    // "the transitions need to be smoother").
    transitionIn: (row.transitionIn ?? 'crossfade') as Shot['transitionIn'],
    transitionOut: (row.transitionOut ?? 'crossfade') as Shot['transitionOut'],
    soundtrackMood: row.soundtrackMood ?? 'ambient',
  };
}
