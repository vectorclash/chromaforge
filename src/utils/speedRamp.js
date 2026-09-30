// Speed-ramp time warp for animation playback (2D and 3D) and MP4 export.
//
// Maps a linear elapsed time onto a per-cycle ease: each cycle accelerates for its whole
// first half and decelerates through its whole second half, so playback is essentially
// never at a steady pace. warp(0) = 0 and warp(period) = period with EQUAL velocity at
// both ends, so a loop that was seamless under linear time stays seamless under the warp.
// Monotonic and continuous across cycle boundaries for any t >= 0.
//
// This must stay the single source of the warp: AnimationPreview (2D GSAP
// timeline), Animation3DPreview (tunnel scene setTime), and DisplayCanvas's
// exportAnimationVideo all call it, which is what keeps the preview and the
// frame-by-frame export showing the exact same motion.
//
// ── Shape ────────────────────────────────────────────────────────────────────
// Velocity is RAMP_FLOOR + A * g(u) over the cycle fraction p, where u = 1 - |2p - 1| is the
// triangle rising from 0 at the seam to 1 at mid-cycle and
//
//   g(u) = u^q * (1 + q * (1 - u)),   q = RAMP_CURVE
//
// with A set so the MEAN velocity is exactly 1. g rises from 0 to 1 with ZERO slope at both
// ends, so velocity is smooth through the seam AND through the peak. That second part is new
// (2026-09-30, Aaron: "even with the ramp the entire motion and everything in the scene needs to
// be a smooth transition through"). The previous shape, g = u^1.2, was a triangle under a power:
// smooth at the seam but with a CORNER at mid-cycle, where acceleration flipped from +5.1 to
// -5.1 between two frames -- a visible lurch, and one every effect driven by rampRush inherited
// (the 3D FOV and vanishing-point pull turned it into a zoom glitch).
//
// **That mean is the whole design constraint, and it is not negotiable**: the warp has to
// cover exactly one period per period or the loop seam breaks. So every bit of top speed
// is paid for out of the rest of the cycle, and a rounded peak costs more than a sharp one --
// it spends longer near the top, so the ends must sit slower to fund it. q = 2.4 was chosen to
// keep the old top speeds exactly (Aaron's pick, over keeping the old near-stop):
//
//   shape                3D top   3D under 0.25x   3D under 0.1x   near top (>90%)   (10s loop)
//   u^1.2 (old, corner)  2.16x    1.5s             0.6s            0.85s
//   rounded q=2.4 (now)  2.16x    2.5s             1.5s            1.7s
//   rounded q=1.6        1.78x    1.6s             0.8s            2.3s
//
// 2D keeps 1.90x and never drops below its 0.25x floor either way. Top speed is
// f + (1 - f)(q + 2)/2, so q = 2 * 1.2 reproduces the old tops in both modes by construction.
//
// History worth not repeating, from three rounds with Aaron in 2026-07: a 3.2x peak was
// rejected as "way way too short of a speed up period", and a plateau that dwelt under 0.25x
// for 4.5s of a 10s loop read as "a huge break at the end". Duration at low speed is what
// reads as a break, not touching zero. If more absolute speed is wanted, it has to come from
// OUTSIDE the ramp -- tunnelScene's FLIGHT_SPEED in 3D, or a shorter Duration in either mode.
//
// The floor is the speed at the seam, as a fraction of linear playback, and is the ONE
// value that differs between the two modes — hence the parameter rather than a constant.
// It exists because seamlessness needs velocity to be CONTINUOUS at the seam, not zero:
// v(0) = v(1) = f is exactly as seamless for any f, including 0.
//
//   RAMP_FLOOR_3D (0.03) — a near stop at each loop end (Aaron, 2026-07-28: "it needs to
//     come to a near stop at the beginning and end... just for the 3d at least").
//   RAMP_FLOOR_2D (0.25) — 2D deliberately keeps a real cruise. Its animation is a
//     crossfade between still frames, so near-zero playback speed doesn't read as "slow
//     flight", it reads as a frozen picture.
export const RAMP_CURVE = 2.4;
export const RAMP_FLOOR_2D = 0.25;
export const RAMP_FLOOR_3D = 0.03;

// The rounded rise: 0 at u = 0, 1 at u = 1, zero slope at both
function rise(u) {
  return u ** RAMP_CURVE * (1 + RAMP_CURVE * (1 - u));
}
// Its integral from 0: u^(q+1) - q/(q+2) * u^(q+2), which is 2/(q+2) at u = 1
function riseArea(u) {
  return u ** (RAMP_CURVE + 1) - (RAMP_CURVE / (RAMP_CURVE + 2)) * u ** (RAMP_CURVE + 2);
}

// Peak velocity as a multiple of linear playback, for a given floor: 1.90x in 2D, 2.16x
// in 3D. Nothing reads this at runtime; it is the self-updating answer to "how fast does
// it actually get".
export function rampTopSpeed(floor = RAMP_FLOOR_2D) {
  return floor + ((1 - floor) * (RAMP_CURVE + 2)) / 2;
}

// Integral of the velocity above, in closed form. On the first half (u = 2p) the warp is
// f*p + (1-f)(q+2)/4 * riseArea(2p), which lands on exactly 0.5 at p = 0.5; the second half is
// that curve mirrored through the midpoint, so a cycle covers exactly 1.0 for any (q, f) and
// retuning either -- or using a different floor per mode -- can never break the loop.
export function rampTime(t, period, floor = RAMP_FLOOR_2D) {
  const k = Math.floor(t / period);
  const p = t / period - k;
  const u = p <= 0.5 ? p : 1 - p;
  const half = floor * u + ((1 - floor) * (RAMP_CURVE + 2) * riseArea(2 * u)) / 4;
  return (k + (p <= 0.5 ? half : 1 - half)) * period;
}

// Normalized 0..1 "rush" amount for the current LINEAR (unwarped) time: how far the ramp
// is into its fast phase — exactly (v - floor) / (peak - floor), which cancels the floor
// out entirely, so this needs no mode/floor argument: it is 1 at mid-cycle and exactly 0
// at both loop ends whatever the floor is, with zero slope at both. Any effect driven by it
// (3D FOV/warp boost, star streaking) therefore returns to its resting state at the seam and
// the loop stays seamless, and none of them lurches at the peak. Callers must feed the same
// clock they feed rampTime.
export function rampRush(t, period) {
  const p = t / period - Math.floor(t / period);
  return rise(1 - Math.abs(2 * p - 1));
}
