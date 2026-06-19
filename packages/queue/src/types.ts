export type QueueName =
  | 'analysis'
  | 'prompt'
  | 'veo3'
  | 'veo32'
  // 69labs image and video are independent features with independent rate
  // limits (images 60/min, videos 5/min) and separate concurrency caps. Each
  // gets its own queue + worker so a burst of slow video jobs can't head-of-line
  // block image jobs (and vice versa) — they drain fully independently.
  // Each 69labs feature can run across multiple parallel "lanes" (worker groups)
  // so two projects generate concurrently instead of one queueing behind the
  // other — lane 1 keeps the base name, lane k>1 gets a numeric suffix. See
  // lanes.ts. Add a queue name here for every lane you enable (LABS_LANES).
  | 'labsImage'
  | 'labsImage2'
  | 'labsVideo'
  | 'labsVideo2'
  | 'tts'
  | 'tts2'
  | 'remotion'
  | 'timeline'
  | 'audio'
  | 'render'
  | 'publish'
  | 'orchestrator'
  // The `assetsReady` completion gate. It lives on its OWN queue (not
  // 'orchestrator') so it is processed by a dedicated worker and can never be
  // starved by the blocking `generateAssets` jobs that occupy the orchestrator
  // pool while awaiting it — that self-starvation is what deadlocked the
  // orchestrator queue (3 blocked generateAssets jobs → 0 slots left for their
  // own assetsReady parents → wait forever). See generateAssets.ts.
  | 'assetsGate';

export interface StageJob {
  projectId: string;
}

export interface ShotJob {
  projectId: string;
  shotId: string;
}
