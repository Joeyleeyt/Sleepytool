import { eventsRepo, projectsRepo, promptsRepo, shotsRepo } from '@emberforge/db';
import { inputHash, type Shot, type StylePresetId } from '@emberforge/core';
import { buildAtmosphericPrompt, buildImagePrompt, buildVeo3Prompt } from '@emberforge/prompt-engine';

export async function promptStage(projectId: string) {
  await eventsRepo.emit(projectId, 'prompt', 'started');
  const project = await projectsRepo.findById(projectId);
  if (!project) throw new Error('project not found');
  const shots = await shotsRepo.findByProject(projectId);

  const stylePreset = project.stylePreset as StylePresetId;

  for (const row of shots) {
    const shot = rowToShot(row);
    const visualTarget = pickTarget(shot.visualType);
    const voice = process.env.LABS69_VOICE_ID ?? 'narrator_deep_male_1';
    const ttsHash = inputHash({ text: shot.narrationText, voice });

    // Visual prompt
    if (visualTarget) {
      const built = await buildVisualPrompt(shot, projectId, stylePreset);
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

async function buildVisualPrompt(shot: Shot, projectId: string, stylePreset: StylePresetId) {
  switch (shot.visualType) {
    case 'cinematic_video':
      // Veo3 prompt format works fine for 69labs video too — both expect a
      // single cinematic description string.
      return buildVeo3Prompt({ shot, projectId, stylePreset });
    case 'image_with_motion':
      return buildImagePrompt({ shot, projectId, stylePreset });
    case 'atmospheric_broll':
      return buildAtmosphericPrompt({ shot, stylePreset });
    // Safe-mode fallback for motion-graphics types
    case 'infographic':
    case 'animated_diagram':
    case 'motion_typography':
      return buildAtmosphericPrompt({ shot, stylePreset });
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
    transitionIn: (row.transitionIn ?? 'cut') as Shot['transitionIn'],
    transitionOut: (row.transitionOut ?? 'cut') as Shot['transitionOut'],
    soundtrackMood: row.soundtrackMood ?? 'ambient',
  };
}
