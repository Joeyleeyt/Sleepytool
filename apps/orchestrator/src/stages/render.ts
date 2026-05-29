import { eventsRepo, projectsRepo } from '@emberforge/db';

/**
 * Render stage delegates the heavy lifting to the GPU render-worker via the
 * 'render' queue. The orchestrator just bookkeeps state transitions.
 */
export async function compositeStage(projectId: string) {
  await eventsRepo.emit(projectId, 'composite', 'started');
  await projectsRepo.setStatus(projectId, 'composited');
  await eventsRepo.emit(projectId, 'composite', 'delegated_to_render_worker');
  return { delegated: true };
}

export async function encodeStage(projectId: string) {
  await eventsRepo.emit(projectId, 'encode', 'started');
  await projectsRepo.setStatus(projectId, 'encoded');
  await eventsRepo.emit(projectId, 'encode', 'delegated_to_render_worker');
  return { delegated: true };
}
