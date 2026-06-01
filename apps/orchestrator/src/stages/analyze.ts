import { eventsRepo, projectsRepo, transcriptsRepo } from '@emberforge/db';
import { structured } from '@emberforge/ai-clients';
import { ANALYZE_SYSTEM, rememberEntity } from '@emberforge/prompt-engine';
import { TranscriptAnalysisSchema } from '@emberforge/core/schemas';

export async function analyzeStage(projectId: string) {
  const started = Date.now();
  // eslint-disable-next-line no-console
  console.log(`[analyze] start projectId=${projectId}`);
  await eventsRepo.emit(projectId, 'analyze', 'started');

  try {
    const transcript = await transcriptsRepo.findByProject(projectId);
    if (!transcript) throw new Error('transcript not found');
    // eslint-disable-next-line no-console
    console.log(`[analyze] transcript loaded len=${transcript.rawText.length}ch words=${transcript.wordCount ?? '?'}`);

    if (transcript.analysisJson) {
      // eslint-disable-next-line no-console
      console.log('[analyze] cached — skipping LLM call');
      await eventsRepo.emit(projectId, 'analyze', 'cached');
      await projectsRepo.setStatus(projectId, 'analyzed');
      return { cached: true };
    }

    const analysis = await structured({
      model: 'opus',
      system: ANALYZE_SYSTEM,
      user: transcript.rawText,
      schema: TranscriptAnalysisSchema,
      // 8k covers the analyze schema comfortably (~500–2,000 output tokens).
      // GPT-4o caps total output at 16,384 — sending more than that returns
      // 400 "max_tokens is too large", which kills the whole pipeline silently.
      maxTokens: 8_000,
      cacheSystem: true,
    });
    // eslint-disable-next-line no-console
    console.log(
      `[analyze] LLM ok entities=${analysis.recurringEntities.length} arc=${analysis.arc.length} ` +
        `topic="${analysis.globalTopic.slice(0, 60)}"`,
    );

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
    // eslint-disable-next-line no-console
    console.log(`[analyze] done projectId=${projectId} ${Date.now() - started}ms`);
    return analysis;
  } catch (err) {
    // Surface the error in the events log so the UI / API can see what broke
    // instead of the project sitting at "analyze.started" forever. Re-throw
    // so BullMQ still marks the job failed and applies its retry policy.
    const e = err as { message?: string; status?: number };
    // eslint-disable-next-line no-console
    console.error(`[analyze] FAILED projectId=${projectId} ${Date.now() - started}ms: ${e.message ?? String(err)}`);
    await eventsRepo.emit(projectId, 'analyze', 'failed', {
      message: e.message ?? String(err),
      status: e.status,
    });
    throw err;
  }
}
