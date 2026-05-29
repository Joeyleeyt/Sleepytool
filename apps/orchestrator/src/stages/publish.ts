import { eventsRepo, projectsRepo } from '@emberforge/db';

export async function publishStage(projectId: string) {
  await eventsRepo.emit(projectId, 'publish', 'started');
  // Signed URL generation happens on demand via the API; optionally upload to
  // YouTube via the Data API here. Mark project published for the dashboard.
  await projectsRepo.setStatus(projectId, 'published');
  await eventsRepo.emit(projectId, 'publish', 'succeeded');
  return { published: true };
}
