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
// Velocity is RAMP_FLOOR + A * (1 - |2p - 1|)^RAMP_CURVE over the cycle fraction p —
// a rounded triangle rising from the floor at the seam to the peak at mid-cycle — with A
// set so the MEAN velocity is exactly 1.
//
// **That mean is the whole design constraint, and it is not negotiable**: the warp has to
// cover exactly one period per period or the loop seam breaks. So every bit of top speed
// is paid for out of the rest of the cycle, and the two things people ask for — a long
// ramp and a high peak — trade directly against each other:
//
//   RAMP_CURVE   top speed   time hugging the floor or the peak
//     1.0 (pure triangle)  1.75x            ~20%
//     1.2 (current)        1.90x            ~23%
//     2.0                  2.50x            ~37%
//     4.0                  3.75x            ~55%
//
// A profile that is ALWAYS ramping cannot exceed 2.0x, full stop — a triangle from a
// standstill hits exactly 2.0, and anything faster has to sit slow somewhere to fund it.
// Aaron has now seen both ends of that trade: a 3.2x peak (RAMP_CURVE ~4 territory) was
// rejected as "way way too short of a speed up period", and the fix is this shape, which
// spends the entire half-cycle accelerating. If more absolute speed is wanted on top of
// this, it has to come from OUTSIDE the ramp — tunnelScene's FLIGHT_SPEED in 3D, or a
// shorter Duration in either mode — not from a higher peak here.
//
// The floor is the speed at the seam, as a fraction of linear playback, and is the ONE
// value that differs between the two modes — hence the parameter rather than a constant.
// It exists because seamlessness needs velocity to be CONTINUOUS at the seam, not zero:
// v(0) = v(1) = f is exactly as seamless for any f, including 0.
//
//   RAMP_FLOOR_3D (0.03) — a near stop at each loop end (Aaron, 2026-07-28: "it needs to
//     come to a near stop at the beginning and end... just for the 3d at least"). This is
//     NOT the dead stop that was rejected earlier in the same session; that one dwelt
//     under 0.25x for 4.5s of a 10s loop because the shape had a flat plateau there. This
//     shape ramps continuously, so it PASSES THROUGH the slow point: 1.5s under 0.25x and
//     only ~0.6s under 0.1x. Duration at low speed is what reads as a break, not touching
//     zero. Dropping the floor also buys top speed back — 2.16x, since the funded area
//     goes into the burst.
//   RAMP_FLOOR_2D (0.25) — 2D deliberately keeps a real cruise. Its animation is a
//     crossfade between still frames, so near-zero playback speed doesn't read as "slow
//     flight", it reads as a frozen picture.
//
// RAMP_CURVE > 1 also makes the curve C1 at the seam (zero acceleration change there),
// so the loop point has no kick; the only kink is at mid-cycle, where the flight turns
// over from accelerating to decelerating and nothing is discontinuous but jerk.
export const RAMP_CURVE = 1.2;
export const RAMP_FLOOR_2D = 0.25;
export const RAMP_FLOOR_3D = 0.03;

// Peak velocity as a multiple of linear playback, for a given floor: 1.90x in 2D, 2.16x
// in 3D. Nothing reads this at runtime; it is the self-updating answer to "how fast does
// it actually get".
export function rampTopSpeed(floor = RAMP_FLOOR_2D) {
  return floor + (1 - floor) * (RAMP_CURVE + 1);
}

// Integral of the velocity above, in closed form: on the first half w(p) = f*p +
// (1-f)*2^q * p^(q+1), and the second half is that same curve mirrored through the
// midpoint. Lands exactly on 0.5 at half a cycle and 1.0 at the seam for any (q, f), so
// retuning either knob — or using a different floor per mode — can never break the loop.
const TWO_POW_CURVE = 2 ** RAMP_CURVE;

export function rampTime(t, period, floor = RAMP_FLOOR_2D) {
  const k = Math.floor(t / period);
  const p = t / period - k;
  const u = p <= 0.5 ? p : 1 - p;
  const half = floor * u + (1 - floor) * TWO_POW_CURVE * u ** (RAMP_CURVE + 1);
  return (k + (p <= 0.5 ? half : 1 - half)) * period;
}

// Normalized 0..1 "rush" amount for the current LINEAR (unwarped) time: how far the ramp
// is into its fast phase — exactly (v - floor) / (peak - floor), which cancels the floor
// out entirely, so this needs no mode/floor argument: it is 1 at mid-cycle and exactly 0
// at both loop ends whatever the floor is. Any effect driven by it (3D FOV/warp boost, star
// streaking) therefore returns to its resting state at the seam and the loop stays
// seamless. Callers must feed the same clock they feed rampTime.
export function rampRush(t, period) {
  const p = t / period - Math.floor(t / period);
  return (1 - Math.abs(2 * p - 1)) ** RAMP_CURVE;
}
