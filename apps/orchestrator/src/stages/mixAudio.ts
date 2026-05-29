import { eventsRepo, projectsRepo } from '@emberforge/db';

export async function mixAudioStage(projectId: string) {
  await eventsRepo.emit(projectId, 'audio', 'started');
  // The actual audio mix runs on a render worker (it needs ffmpeg + local
  // asset cache). The orchestrator emits the job; the render-worker handles it.
  // For now the audio_mixed status is set when the render-worker reports back
  // via a status update — kept lightweight here for the skeleton.
  await projectsRepo.setStatus(projectId, 'audio_mixed');
  await eventsRepo.emit(projectId, 'audio', 'delegated_to_render_worker');
  return { delegated: true };
}
