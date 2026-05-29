import type { TransitionType } from '../enums.js';

export interface TimelineClip {
  shotId: string;
  startS: number;
  endS: number;
  videoAssetId: string;
  narrationAssetId: string;
  musicAssetId?: string;
  overlayAssetIds: string[];
  subtitleSegmentIdx: number;
  transitionIn: TransitionType;
  transitionOut: TransitionType;
}

export interface MusicBed {
  startS: number;
  endS: number;
  assetId: string;
  gainDb: number;
}

export interface Timeline {
  id: string;
  projectId: string;
  clips: TimelineClip[];
  totalDurationS: number;
  musicBeds: MusicBed[];
  version: number;
}
