export type QueueName =
  | 'analysis'
  | 'prompt'
  | 'veo3'
  | 'labs'
  | 'tts'
  | 'remotion'
  | 'timeline'
  | 'audio'
  | 'render'
  | 'publish'
  | 'orchestrator';

export interface StageJob {
  projectId: string;
}

export interface ShotJob {
  projectId: string;
  shotId: string;
}
