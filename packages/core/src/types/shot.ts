import type { CameraMove, LensProfile, TransitionType, VisualType } from '../enums.js';

export interface FxSpec {
  embers: 'off' | 'subtle' | 'medium' | 'heavy';
  smoke: 'off' | 'low' | 'high';
  filmGrain: number;
  glow: 'off' | 'low' | 'high';
  vignette: number;
}

export interface Shot {
  id: string;
  sceneId: string;
  projectId: string;
  ordinal: number;
  narrationText: string;
  durationS: number;
  visualType: VisualType;
  visualSummary: string;
  cameraMovement: CameraMove;
  lens: LensProfile;
  fxRecommendation: FxSpec;
  transitionIn: TransitionType;
  transitionOut: TransitionType;
  soundtrackMood: string;
}
