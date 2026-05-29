import { eventsRepo, projectsRepo, timelinesRepo } from '@emberforge/db';
import { buildTimeline } from '@emberforge/timeline-engine';

export async function buildTimelineStage(projectId: string) {
  await eventsRepo.emit(projectId, 'timeline', 'started');
  const tl = await buildTimeline(projectId);
  await timelinesRepo.upsert(tl);
  await projectsRepo.setStatus(projectId, 'timeline_built');
  await eventsRepo.emit(projectId, 'timeline', 'succeeded', { clips: tl.clips.length, totalDurS: tl.totalDurationS });
  return { clips: tl.clips.length, totalDurS: tl.totalDurationS };
}
