import type { TransitionType } from '@emberforge/core';

export function transitionOverlapS(type: TransitionType): number {
  switch (type) {
    case 'cut':
      return 0;
    case 'crossfade':
    case 'dip_to_black':
      return 0.5;
    case 'whip':
    case 'glitch':
      return 0.25;
    case 'lightleak':
    case 'morph':
    case 'ember_sweep':
      return 0.75;
  }
}

export function ffmpegXfade(type: TransitionType): string {
  switch (type) {
    case 'cut':
      return 'none';
    case 'crossfade':
      return 'fade';
    case 'dip_to_black':
      return 'fadeblack';
    case 'whip':
      return 'wipeleft';
    case 'glitch':
      return 'pixelize';
    case 'lightleak':
      return 'fadewhite';
    case 'morph':
      return 'circleopen';
    case 'ember_sweep':
      return 'distance';
  }
}
