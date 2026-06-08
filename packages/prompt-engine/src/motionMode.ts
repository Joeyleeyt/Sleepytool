/**
 * Sleep / Dream MOTION CONTRACT — the single source of truth for how much the
 * frame is allowed to move, appended to EVERY 69labs (and Veo3) generation
 * prompt.
 *
 * WHY THIS LIVES IN THE POSITIVE PROMPT
 * 69labs' image and video endpoints expose NO `motion_intensity` / zoom-speed /
 * parallax knob, AND they IGNORE the negative prompt entirely — image()/video()
 * in packages/ai-clients/src/labs69.ts transmit only the positive `prompt`
 * (model / aspectRatio / resolution / seed); `negative` is accepted "for API
 * parity" but never sent. So the ONLY lever on how fast a 69labs clip moves is
 * the POSITIVE prompt text. The product's "SLEEP MODE" spec is therefore encoded
 * here as positive language — both a high-weight LEAD at the front of the prompt
 * (motionLead) and a detailed directive later (motionDirective) — with all the
 * "no fast motion" suppressions phrased POSITIVELY so they survive the dropped
 * negative. MOTION_NEGATIVE is kept too for the Veo3 path (veo3.ts DOES send
 * negativePrompt), where it still bites.
 *
 * The render-side motion (Ken Burns on stills, cross-dissolves between shots) is
 * already sleep-safe and tuned separately — see packages/render (kenBurnsFilter
 * maxZoom ≈1.02 ≈0.2%/s, 2s cross-dissolves). This module governs ONLY the
 * motion baked INTO each generated asset by 69labs.
 *
 * MODES (set MOTION_MODE; defaults to 'sleep' — the long-form sleep target):
 *   🛌 SLEEP — motion_intensity 0.05–0.1: locked / micro-dolly only, parallax
 *              disabled, transitions off inside the clip, zoom speed < 0.5%/s,
 *              object motion disabled. Use for all long-form content.
 *   🌙 DREAM — motion_intensity 0.1–0.15: a single slow pan OR slow push only,
 *              mild parallax allowed. Slightly more dynamic; opt-in.
 */
export type MotionMode = 'sleep' | 'dream';

/** Resolve the active motion mode from the environment. Defaults to 'sleep'. */
export function getMotionMode(): MotionMode {
  return (process.env.MOTION_MODE ?? 'sleep').trim().toLowerCase() === 'dream' ? 'dream' : 'sleep';
}

// 🛌 SLEEP MODE positive directive — near-total stillness baked into the clip.
// Every clause is phrased positively (or as an in-prompt "no X") so it works
// even though 69labs drops the negative prompt.
const SLEEP_MOTION =
  'extremely slow, near-imperceptible motion, motion intensity 0.05 to 0.1, ' +
  'camera locked-off or micro-dolly only, no parallax, no zoom, ' +
  'any drift slower than 0.5% per second, ' +
  'one single continuous uninterrupted shot, no cuts or transitions inside the shot, ' +
  'all objects in the scene remain still, the frame is held almost perfectly static, ' +
  'no camera shake, no motion blur, no fast or sudden movement';

// 🌙 DREAM MODE positive directive — one slow move, otherwise still.
const DREAM_MOTION =
  'very slow, gentle motion, motion intensity 0.1 to 0.15, ' +
  'a single slow pan OR a single slow push only, mild parallax allowed, no zoom, ' +
  'one single continuous uninterrupted shot, no cuts or transitions inside the shot, ' +
  'objects in the scene stay nearly still, the frame drifts almost imperceptibly, ' +
  'no camera shake, no motion blur, no fast or sudden movement';

/**
 * Positive motion directive for VIDEO / camera-motion prompts (cinematic +
 * atmospheric b-roll). Reflects the active MOTION_MODE. Placed mid-prompt to
 * reinforce the front-loaded motionLead().
 */
export function motionDirective(mode: MotionMode = getMotionMode()): string {
  return mode === 'dream' ? DREAM_MOTION : SLEEP_MOTION;
}

// High-weight motion LEAD prepended to the FRONT of every generation prompt.
// These models weight their opening tokens most, and 69labs has no negative
// prompt to lean on, so leading with stillness is the single strongest lever.
// motionDirective() repeats the constraint in detail later in the prompt.
const SLEEP_LEAD =
  'near-frozen, almost completely still footage, no perceptible movement, calm and motionless';
const DREAM_LEAD = 'slow, gently drifting footage, minimal movement, calm and tranquil';

/** Short, front-of-prompt motion lead for VIDEO prompts. Reflects MOTION_MODE. */
export function motionLead(mode: MotionMode = getMotionMode()): string {
  return mode === 'dream' ? DREAM_LEAD : SLEEP_LEAD;
}

/**
 * Positive stillness directive for STILL-IMAGE prompts. An image has no camera
 * motion of its own (the gentle drift is added at render time), so it gets a
 * calmer, composition-only cue instead of the full camera directive — but the
 * same MOTION_NEGATIVE below still suppresses any implied movement / blur.
 */
export const STILL_MOTION =
  'perfectly still calm composition, no implied motion, no motion blur, no sense of movement, ' +
  'no camera shake, serene and static';

/**
 * Shared NEGATIVE motion directive — appended to every builder's negative
 * prompt in both modes. Actively pushes the models away from the fast camera
 * work, in-clip cuts and energetic object motion that break the sleep feel.
 */
export const MOTION_NEGATIVE =
  'fast motion, rapid movement, quick camera move, whip pan, fast pan, fast zoom, snap zoom, ' +
  'dolly zoom, sudden movement, jerky movement, jump cut, hard cut, in-shot transition, ' +
  'scene change mid-shot, flashing, strobing, shaky camera, camera shake, handheld jitter, ' +
  'motion blur, speed ramp, time-lapse, hyperlapse, fast-moving objects, energetic action, ' +
  'dynamic motion, swirling, spinning, frenetic, chaotic movement';
