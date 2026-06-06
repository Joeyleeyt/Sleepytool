/**
 * Anti-letterbox / full-frame guard appended to EVERY 69labs generation prompt
 * (video clips and still images alike).
 *
 * 69labs occasionally bakes embedded black bars or a "cinematic" letterbox into
 * the frame; the renderer then composites those bars into the final 16:9 video,
 * producing the padding/letterboxing artifact we're eliminating. Forcing
 * edge-to-edge, border-free composition in the prompt is the only reliable
 * prevention.
 *
 * The first clause is the product-mandated wording — keep it verbatim. The
 * trailing clauses additionally suppress on-screen text, watermarks and camera
 * UI: separate artifacts from letterboxing, but the same in-frame-junk family.
 */
export const FULL_FRAME_GUARD =
  'full frame, edge-to-edge, no borders, no letterboxing, subject fills entire 16:9 frame, ' +
  'no on-screen text or captions, no watermark or logo, no camera UI or HUD, no REC indicator, ' +
  'no timestamp, no viewfinder or focus reticle, no film border or letterbox bars';
