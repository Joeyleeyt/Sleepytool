import { eventsRepo, projectsRepo, transcriptsRepo } from '@emberforge/db';
import { structured } from '@emberforge/ai-clients';
import { ANALYZE_SYSTEM, rememberEntity } from '@emberforge/prompt-engine';
import { TranscriptAnalysisSchema } from '@emberforge/core/schemas';

export async function analyzeStage(projectId: string) {
  await eventsRepo.emit(projectId, 'analyze', 'started');

  const transcript = await transcriptsRepo.findByProject(projectId);
  if (!transcript) throw new Error('transcript not found');

  if (transcript.analysisJson) {
    await eventsRepo.emit(projectId, 'analyze', 'cached');
    await projectsRepo.setStatus(projectId, 'analyzed');
    return { cached: true };
  }

  const analysis = await structured({
    model: 'opus',
    system: ANALYZE_SYSTEM,
    user: transcript.rawText,
    schema: TranscriptAnalysisSchema,
    maxTokens: 32_000,
    cacheSystem: true,
  });

  await transcriptsRepo.saveAnalysis(transcript.id, analysis);

  for (const ent of analysis.recurringEntities) {
    if (ent.kind === 'concept') continue; // concepts aren't visual
    await rememberEntity({
      projectId,
      kind: ent.kind,
      key: ent.name.toLowerCase(),
      descriptor: ent.descriptor,
    });
  }

  await projectsRepo.setStatus(projectId, 'analyzed');
  await eventsRepo.emit(projectId, 'analyze', 'succeeded', { entities: analysis.recurringEntities.length });
  return analysis;
}
