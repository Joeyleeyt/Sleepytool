import { eventsRepo, scenesRepo, shotsRepo } from '@emberforge/db';
import { labs69 } from '@emberforge/ai-clients';
import { acquire } from '@emberforge/queue';

/**
 * Per-segment TTS timing pass. Runs at the front of Phase 2 (after classify,
 * before prompt) so every downstream stage works with REAL narration durations
 * instead of the 150-wpm estimate.
 *
 * For each scene we synthesize the scene's `narrationChunk` with 69labs TTS
 * once, observe the real `durationSeconds`, and:
 *   1. Write the measured duration onto `scenes.estimated_dur_s`.
 *   2. Redistribute each shot's `duration_s` proportionally to its
 *      `narration_text` character count vs the scene's total. Character count
 *      is a better proxy than word count for the TTS engine's actual pacing,
 *      because long words and punctuation slow it down.
 *
 * The TTS audio is NOT persisted as an asset — Phase 3's tts-worker still
 * runs per-shot to produce the final narration audio assets used by render.
 * This stage is timing-only. Net cost: ~1 extra 69labs TTS call per scene,
 * typically $0.01–$0.05 per project.
 *
 * Scenes run concurrently via Promise.all; the Redis token-bucket rate
 * limiter (`acquire('69labs.tts')`) prevents oversubscribing 69labs' published
 * 20 req/min cap.
 *
 * Failure mode: if a scene's TTS fails, we leave that scene's existing
 * 150-wpm estimates in place and emit a per-scene `failed` event. Other
 * scenes are unaffected. The pipeline progresses to `prompt` regardless —
 * partial measurement is better than blocking the whole plan-shots run.
 */
export async function narrationTimingStage(projectId: string) {
  const started = Date.now();
  // eslint-disable-next-line no-console
  console.log(`[narrationTiming] start projectId=${projectId}`);
  await eventsRepo.emit(projectId, 'narrationTiming', 'started');

  const scenes = await scenesRepo.findByProject(projectId);
  if (scenes.length === 0) {
    // eslint-disable-next-line no-console
    console.log('[narrationTiming] no scenes — skipping');
    await eventsRepo.emit(projectId, 'narrationTiming', 'skipped', { reason: 'no_scenes' });
    return { measured: 0, skipped: 0 };
  }

  // Voice + pace are global today (env vars). Per-scene overrides could live
  // on the scene row later; for now, picking up whatever LABS69_VOICE_ID is
  // set keeps timing aligned with what Phase 3's tts-worker will actually use.
  const voiceId = process.env.LABS69_VOICE_ID ?? '';
  if (!voiceId) {
    // eslint-disable-next-line no-console
    console.warn(
      '[narrationTiming] LABS69_VOICE_ID not set — skipping timing pass (shots keep 150-wpm estimates)',
    );
    await eventsRepo.emit(projectId, 'narrationTiming', 'skipped', { reason: 'no_voice' });
    return { measured: 0, skipped: scenes.length };
  }

  let measured = 0;
  let skipped = 0;

  await Promise.all(
    scenes.map(async (scene) => {
      const sceneStart = Date.now();
      const text = scene.narrationChunk;
      if (!text || text.trim().length === 0) {
        skipped += 1;
        return;
      }
      try {
        await acquire('69labs.tts');
        const result = await labs69.tts({ text, voiceId, pace: 'medium' });
        const realDurationS = result.durationS;

        const sceneShots = await shotsRepo.findByScene(scene.id);
        const totalChars = sceneShots.reduce((n, s) => n + s.narrationText.length, 0);
        if (totalChars === 0) {
          skipped += 1;
          return;
        }
        // Redistribute proportionally to character count.
        const updates: Promise<unknown>[] = [];
        let assignedSoFar = 0;
        for (let i = 0; i < sceneShots.length; i++) {
          const s = sceneShots[i]!;
          let durationS: number;
          if (i === sceneShots.length - 1) {
            // Give the last shot whatever's left so the sum exactly equals
            // realDurationS — avoids floating-point drift accumulating.
            durationS = Math.max(0.1, realDurationS - assignedSoFar);
          } else {
            durationS = (s.narrationText.length / totalChars) * realDurationS;
            assignedSoFar += durationS;
          }
          updates.push(shotsRepo.setDuration(s.id, round3(durationS)));
        }
        updates.push(scenesRepo.setEstimatedDuration(scene.id, round3(realDurationS)));
        await Promise.all(updates);
        measured += 1;

        // eslint-disable-next-line no-console
        console.log(
          `[narrationTiming] scene ${scene.ordinal} ok realDurS=${realDurationS.toFixed(2)} ` +
            `shots=${sceneShots.length} ${Date.now() - sceneStart}ms`,
        );
        await eventsRepo.emit(projectId, 'narrationTiming', 'scene_measured', {
          sceneId: scene.id,
          ordinal: scene.ordinal,
          realDurationS,
          shotCount: sceneShots.length,
        });
      } catch (err) {
        skipped += 1;
        const message = (err as Error).message ?? String(err);
        // eslint-disable-next-line no-console
        console.warn(`[narrationTiming] scene ${scene.ordinal} FAILED: ${message}`);
        await eventsRepo.emit(projectId, 'narrationTiming', 'scene_failed', {
          sceneId: scene.id,
          ordinal: scene.ordinal,
          message,
        });
      }
    }),
  );

  const elapsed = Date.now() - started;
  // eslint-disable-next-line no-console
  console.log(
    `[narrationTiming] done projectId=${projectId} measured=${measured}/${scenes.length} ${elapsed}ms`,
  );
  await eventsRepo.emit(projectId, 'narrationTiming', 'succeeded', {
    measured,
    skipped,
    total: scenes.length,
  });
  return { measured, skipped, total: scenes.length };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
