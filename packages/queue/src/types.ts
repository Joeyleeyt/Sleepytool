export type QueueName =
  | 'analysis'
  | 'prompt'
  | 'veo3'
  // 69labs image and video are independent features with independent rate
  // limits (images 60/min, videos 5/min) and separate concurrency caps. Each
  // gets its own queue + worker so a burst of slow video jobs can't head-of-line
  // block image jobs (and vice versa) — they drain fully independently.
  | 'labsImage'
  | 'labsVideo'
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
