import type { TransitionType } from '../enums.js';

export interface TimelineClip {
  shotId: string;
  /**
   * 'clip'   — a narrated shot (video clip or Ken Burns still).
   * 'freeze' — a silent held still inserted by the pacing pattern: the frozen
   *            last frame of the preceding clip, held 3–4s with no narration.
   * Absent on legacy timelines ⇒ treat as 'clip'.
   */
  kind?: 'clip' | 'freeze';
  startS: number;
  endS: number;
  /** For 'freeze' clips this is the SOURCE clip's video asset — the render
   *  worker extracts its last frame to build the held still. */
  videoAssetId: string;
  /** Absent for 'freeze' clips (no narration plays over a held still). */
  narrationAssetId?: string;
  musicAssetId?: string;
  overlayAssetIds: string[];
  /** -1 for 'freeze' clips (no subtitle line). */
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
