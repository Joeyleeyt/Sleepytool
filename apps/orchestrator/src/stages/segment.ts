import { eventsRepo, projectsRepo, scenesRepo, transcriptsRepo } from '@emberforge/db';
import { structured } from '@emberforge/ai-clients';
import { SEGMENT_SYSTEM } from '@emberforge/prompt-engine';
import { SceneListSchema } from '@emberforge/core/schemas';

export async function segmentStage(projectId: string) {
  await eventsRepo.emit(projectId, 'segment', 'started');

  const transcript = await transcriptsRepo.findByProject(projectId);
  if (!transcript || !transcript.analysisJson) throw new Error('analysis required before segmentation');

  const existing = await scenesRepo.findByProject(projectId);
  if (existing.length > 0) {
    await eventsRepo.emit(projectId, 'segment', 'cached', { scenes: existing.length });
    await projectsRepo.setStatus(projectId, 'segmented');
    return { cached: true, scenes: existing.length };
  }

  const result = await structured({
    model: 'opus',
    system: SEGMENT_SYSTEM,
    user: JSON.stringify({
      analysis: transcript.analysisJson,
      transcript: transcript.rawText,
    }),
    schema: SceneListSchema,
    maxTokens: 32_000,
    cacheSystem: true,
  });

  await scenesRepo.bulkInsert(
    result.scenes.map((s) => ({
      projectId,
      ordinal: s.ordinal,
      title: s.title,
      narrationChunk: s.narrationChunk,
      emotion: s.analysis.emotion,
      pacing: s.analysis.pacing,
      atmosphere: s.analysis.atmosphere,
      topic: s.analysis.topic,
      analysis: s.analysis,
      startWordIdx: s.startWordIdx,
      endWordIdx: s.endWordIdx,
      estimatedDurS: String(s.estimatedDurationS),
    })),
  );

  await projectsRepo.setStatus(projectId, 'segmented');
  await eventsRepo.emit(projectId, 'segment', 'succeeded', { scenes: result.scenes.length });
  return { scenes: result.scenes.length };
}
