export const PROJECT_STATUSES = [
  'ingested',
  'analyzed',
  'segmented',
  'classified',
  'prompted',
  'generating_assets',
  'assets_ready',
  'timeline_built',
  'audio_mixed',
  'composited',
  'encoded',
  'published',
  'failed',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const VISUAL_TYPES = [
  'cinematic_video',
  'image_with_motion',
  'infographic',
  'motion_typography',
  'animated_diagram',
  'atmospheric_broll',
] as const;
export type VisualType = (typeof VISUAL_TYPES)[number];

export const EMOTIONS = [
  'awe',
  'dread',
  'wonder',
  'tension',
  'contemplative',
  'triumph',
  'melancholy',
  'curiosity',
  'urgency',
] as const;
export type Emotion = (typeof EMOTIONS)[number];

export const PACING = ['slow', 'medium', 'fast'] as const;
export type Pacing = (typeof PACING)[number];

export const CAMERA_MOVES = [
  'static',
  'dolly_in',
  'dolly_out',
  'crane_down',
  'crane_up',
  'orbit_left',
  'orbit_right',
  'whip_pan',
  'handheld_drift',
  'aerial_descend',
  'macro_push',
  'ken_burns_in',
  'ken_burns_out',
] as const;
export type CameraMove = (typeof CAMERA_MOVES)[number];

export const LENS_PROFILES = [
  '14mm_ultrawide',
  '24mm_wide',
  '35mm_anamorphic',
  '50mm_natural',
  '85mm_portrait',
  '135mm_tele',
  'macro_100mm',
] as const;
export type LensProfile = (typeof LENS_PROFILES)[number];

export const TRANSITIONS = [
  'cut',
  'crossfade',
  'dip_to_black',
  'whip',
  'glitch',
  'lightleak',
  'morph',
  'ember_sweep',
] as const;
export type TransitionType = (typeof TRANSITIONS)[number];

export const ASSET_KINDS = [
  'video_clip',
  'image',
  'audio_narration',
  'audio_music',
  'audio_sfx',
  'subtitle_vtt',
  'overlay_fx',
  'final_render',
] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const GEN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type GenStatus = (typeof GEN_STATUSES)[number];

export const STYLE_PRESETS = [
  'cinematic_dark_ember',
  'cosmic_minimal',
  'noir_documentary',
  'warm_archival',
  'nocturne_soft', // sleep-documentary: dark, desaturated, soft-contrast, no embers
] as const;
export type StylePresetId = (typeof STYLE_PRESETS)[number];
