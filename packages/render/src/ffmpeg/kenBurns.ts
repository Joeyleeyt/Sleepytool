/**
 * Single source of truth for Ken Burns (zoompan) motion. Previously the same
 * math lived — and slowly drifted apart — in three places (mixClips,
 * sleepRender, shotComposite). Centralising it here means one place to keep the
 * motion mathematically stable and jitter-free.
 *
 * WHY THE OLD IMPLEMENTATION SHOOK
 * --------------------------------
 * FFmpeg's `zoompan` computes the crop window position from the `x`/`y`
 * expressions and then FLOORS those offsets to whole INPUT pixels every single
 * frame. When the input canvas is close to the output size, that 1px floor is
 * ~1px of *visible* jump as the zoom ramps — the image appears to vibrate.
 *
 * THE FIX (three independent levers, all applied here)
 * 1. OVERSAMPLE the input canvas heavily (default 4×) so one input-pixel of
 *    floor error is only a small fraction of an OUTPUT pixel — sub-pixel and
 *    invisible. (Clamped so 4K doesn't blow up to an absurd canvas.)
 * 2. Drive the motion from the OUTPUT frame counter `on` (a pure frame-based
 *    ramp), never the recursive `zoom+step` accumulator — the recursive form
 *    re-reads the previous frame's already-quantised zoom and so advances by an
 *    uneven step each frame.
 * 3. Ease the ramp with a smoothstep (3t²−2t³) so velocity starts and ends at
 *    zero — cinematic, and it removes the hard linear "snap" at clip edges.
 * Plus: a gentler default zoom ceiling (1.10, was 1.15) — less total travel
 * means fewer integer-boundary crossings, i.e. less opportunity to shake.
 */

export type KenBurnsMode = 'none' | 'in' | 'out' | 'left' | 'right';

/** 1.10 = a 10% push over the whole clip. Documentary Ken Burns is subtle; a
 *  smaller move also crosses fewer integer-pixel crop boundaries (less jitter).
 *  Override with KENBURNS_MAX_ZOOM; sleep stories pass ~1.02 explicitly. */
const DEFAULT_MAX_ZOOM = 1.1;

function even(n: number): number {
  return Math.round(n / 2) * 2;
}

export interface KenBurnsOpts {
  mode: KenBurnsMode;
  width: number;
  height: number;
  durationS: number;
  fps: number;
  /** Zoom ceiling. Defaults to KENBURNS_MAX_ZOOM env or 1.10. */
  maxZoom?: number;
  /** Input pad/stream label (default '0:v'). */
  inputLabel?: string;
  /** Output pad label (default 'v'). */
  outputLabel?: string;
  /** Extra filters inserted just before the output label,
   *  e.g. ',format=yuv420p' or ',format=yuv420p,setpts=PTS-STARTPTS'. */
  suffix?: string;
}

/**
 * Build a jitter-free Ken Burns chain `[input] … [output]`.
 *
 * The returned string is a complete filterchain (usable in `-filter_complex`).
 * Centered moves ('in' / 'out') only zoom; 'left' / 'right' also pan across the
 * zoom headroom. 'none' is a perfectly static (but still oversampled) frame.
 */
export function kenBurnsFilter(o: KenBurnsOpts): string {
  const input = o.inputLabel ?? '0:v';
  const output = o.outputLabel ?? 'v';
  const suffix = o.suffix ?? '';
  const N = Math.max(1, Math.round(o.durationS * o.fps));
  const maxZoom = o.maxZoom ?? Number(process.env.KENBURNS_MAX_ZOOM ?? DEFAULT_MAX_ZOOM);

  // --- Anti-jitter geometry (lever 1: heavy input oversample) --------------
  // Render the source at `factor`× the target so zoompan's whole-input-pixel
  // x/y floor is sub-pixel in the final frame. Clamp the rendered long edge so
  // 4K targets stay sane (8192 ≈ 2.1× of 3840) while 1080p gets the full 4×.
  const oversample = Math.max(2, Number(process.env.KENBURNS_OVERSAMPLE ?? '4'));
  const maxRender = Number(process.env.KENBURNS_MAX_RENDER ?? '8192');
  const longEdge = Math.max(o.width, o.height);
  const factor = Math.min(oversample, Math.max(maxZoom * 1.25, maxRender / longEdge));
  const rw = even(o.width * factor);
  const rh = even(o.height * factor);

  // Optional output supersample + lanczos downscale — anti-aliases any residual
  // sub-pixel stepping for the most demanding footage. Default 1 (off) so the
  // zoompan output cost stays at target resolution. Raise via KENBURNS_SUPERSAMPLE.
  const superscale = Math.max(1, Number(process.env.KENBURNS_SUPERSAMPLE ?? '1'));
  const sw = even(o.width * superscale);
  const sh = even(o.height * superscale);
  const downscale = superscale > 1 ? `,scale=${o.width}:${o.height}:flags=lanczos` : '';

  // --- Eased, frame-based motion (levers 2 & 3) ----------------------------
  const denom = Math.max(1, N - 1); // `on` runs 0..N-1, so this reaches 1 exactly
  const t = `(min(1,on/${denom}))`;
  const ease = `(${t}*${t}*(3-2*${t}))`; // smoothstep ease-in-out
  const up = `(${(maxZoom - 1).toFixed(6)}*${ease})`;
  const cx = '(iw-iw/zoom)/2';
  const cy = '(ih-ih/zoom)/2';

  let zoom: string;
  let x: string;
  let y: string;
  switch (o.mode) {
    case 'none':
      zoom = '1';
      x = cx;
      y = cy;
      break;
    case 'out':
      zoom = `(${maxZoom}-${up})`;
      x = cx;
      y = cy;
      break;
    case 'left':
      // Pan only within the zoom headroom (max offset = iw-iw/zoom), eased.
      zoom = `(1+${up})`;
      x = `(iw-iw/zoom)*(1-${ease})`;
      y = cy;
      break;
    case 'right':
      zoom = `(1+${up})`;
      x = `(iw-iw/zoom)*${ease}`;
      y = cy;
      break;
    case 'in':
    default:
      zoom = `(1+${up})`;
      x = cx;
      y = cy;
      break;
  }

  return (
    `[${input}]scale=${rw}:${rh}:force_original_aspect_ratio=increase,crop=${rw}:${rh},` +
    `zoompan=z='${zoom}':x='${x}':y='${y}':d=${N}:s=${sw}x${sh}:fps=${o.fps}${downscale},` +
    `setsar=1${suffix}[${output}]`
  );
}
