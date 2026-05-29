import type { Emotion, Pacing } from '../enums.js';

export interface SceneAnalysis {
  topic: string;
  emotion: Emotion;
  pacing: Pacing;
  tension: number;
  atmosphere: string;
  visualOpportunities: string[];
  timelineMarker?: string;
  concepts: { scientific: string[]; abstract: string[] };
}

export interface Scene {
  id: string;
  projectId: string;
  ordinal: number;
  title: string;
  narrationChunk: string;
  analysis: SceneAnalysis;
  estimatedDurationS: number;
  startWordIdx: number;
  endWordIdx: number;
}
