import type { ProjectStatus, StylePresetId } from '../enums.js';

export interface Project {
  id: string;
  ownerId: string;
  title: string;
  status: ProjectStatus;
  stylePreset: StylePresetId;
  targetRes: '1920x1080' | '3840x2160';
  targetFps: 24 | 30 | 60;
  createdAt: Date;
  updatedAt: Date;
}

export interface TranscriptRecord {
  id: string;
  projectId: string;
  rawText: string;
  wordCount: number;
  estDurationS: number;
  analysisJson: TranscriptAnalysis | null;
  createdAt: Date;
}

export interface TranscriptAnalysis {
  globalTopic: string;
  arc: { stage: string; from: number; to: number }[];
  recurringEntities: { kind: 'character' | 'environment' | 'concept'; name: string; descriptor: string }[];
  toneSummary: string;
  estimatedDurationS: number;
}
