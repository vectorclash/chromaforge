// Timing for the vectorclash mark's flight through an animation's loop seam.
//
// The mark is present only at the very start and very end of a cycle, and those two
// appearances are ONE continuous motion rather than two animations that have to be matched
// by hand:
//
//   frame 1        centered, at rest, fully drawn, fully opaque
//   first 0.5s     flies out toward the viewer  -- growing, unbuilding, fading out
//   ...middle...   absent
//   last 0.5s      comes back toward the camera -- growing from small, building in, fading in
//   final frame    lands on exactly the frame-1 pose
//
// That is expressed as a single signed parameter `s`: -1 at the start of the return leg,
// 0 at the seam (which is simultaneously the last frame and frame 1), +1 at the end of the
// exit leg. Scale, opacity and stroke are continuous functions of `s`, so the loop closes by
// construction -- the last frame and frame 1 are the same evaluation of the same curve, not
// two values someone eyeballed into agreement.
//
// Callers pass the LINEAR (unwarped) clock, exactly as they do for rampTime/rampRush, and
// this module applies the warp itself. That is deliberate: the mark must move WITH the
// animation when Speed Ramp is on, but it gets its own floor rather than the mode's. At
// RAMP_FLOOR_3D = 0.03 the seam is a near-stop, so a mark warped by 3D's own floor would
// hang at its frame-1 pose for several seconds of wall time. RAMP_FLOOR_LOGO keeps it
// visibly tied to the ramp without freezing.

import { rampTime, RAMP_FLOOR_2D } from './speedRamp';

// Seconds of ANIMATION time (post-warp) at each end of the cycle. Half a second each side.
export const LOGO_WINDOW = 0.5;

export const RAMP_FLOOR_LOGO = RAMP_FLOOR_2D;

// Octaves of scale change across one leg: at s = ±1 the mark is 2^±LOGO_OCTAVES of its
// seam size (2.64x on the way out, 0.38x at the far end of the return). Exponential rather
// than linear because equal ratios per unit time is what reads as constant-speed travel in
// perspective -- and because its velocity is continuous through s = 0, which a linear ramp
// through a sign change would not be.
export const LOGO_OCTAVES = 1.4;

// The mark's size at the seam, as a fraction of the SHORT edge, for the flat-overlay
// surfaces (the 2D preview and the 2D export). Both must use this same number or the file
// would not match the preview it was approved from. 3D is deliberately not covered: it
// places the mark in the tunnel in world units, which is a different measurement entirely.
export const LOGO_SCREEN_FRACTION = 0.32;

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

// Smoothstep, so the mark holds full opacity through the seam instead of peaking to a point
// there -- a first-derivative kink at the loop point is exactly what would read as a stutter.
const smooth = t => t * t * (3 - 2 * t);

export function logoScale(s) {
  return 2 ** (s * LOGO_OCTAVES);
}

export function logoAlpha(s) {
  return smooth(clamp01(1 - Math.abs(s)));
}

export function logoDraw(s) {
  return clamp01(1 - Math.abs(s));
}

// Returns null outside the two windows, so every draw site can skip all of its work with one
// check -- the mark is absent for most of a cycle and this runs per frame.
export function logoState(linearTime, period, speedRamp = false) {
  if (!(period > 2 * LOGO_WINDOW)) return null;

  const warped = speedRamp ? rampTime(linearTime, period, RAMP_FLOOR_LOGO) : linearTime;
  const p = warped - Math.floor(warped / period) * period;

  let s;
  if (p <= LOGO_WINDOW) s = p / LOGO_WINDOW;
  else if (p >= period - LOGO_WINDOW) s = (p - period) / LOGO_WINDOW;
  else return null;

  return { s, scale: logoScale(s), alpha: logoAlpha(s), draw: logoDraw(s) };
}
