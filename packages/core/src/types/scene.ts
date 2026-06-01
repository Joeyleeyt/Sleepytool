import type { Emotion, Pacing } from '../enums.js';

export interface SceneAnalysis {
  topic: string;
  emotion: Emotion;
  pacing: Pacing;
  tension: number;
  atmosphere: string;
  visualOpportunities: string[];
  // string | null | undefined — OpenAI Structured Outputs returns explicit
  // null for nullable+optional fields; Claude omits them entirely. Both shapes
  // get stored on scenes.analysis verbatim.
  timelineMarker?: string | null;
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
