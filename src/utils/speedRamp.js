// Speed-ramp time warp for animation playback (2D and 3D) and MP4 export.
//
// Maps a linear elapsed time onto a per-cycle sine ease-in-out: each cycle starts
// slow, accelerates through the middle, and decelerates back at the same rate.
// warp(0) = 0 and warp(period) = period with symmetric (zero) velocity at both
// ends, so a loop that was seamless under linear time stays seamless under the
// warp. Monotonic and continuous across cycle boundaries for any t >= 0.
//
// This must stay the single source of the warp: AnimationPreview (2D GSAP
// timeline), Animation3DPreview (tunnel scene setTime), and DisplayCanvas's
// exportAnimationVideo all call it, which is what keeps the preview and the
// frame-by-frame export showing the exact same motion.
export function rampTime(t, period) {
  const k = Math.floor(t / period);
  const p = t / period - k;
  return (k + (1 - Math.cos(Math.PI * p)) / 2) * period;
}

// Normalized 0..1 "rush" amount for the current LINEAR (unwarped) time: how far the
// ramp is into its fast phase — sin(π·p), i.e. the shape of rampTime's own velocity
// curve, peaking at 1 mid-cycle and exactly 0 at both loop ends so any effect driven
// by it (3D FOV/warp boost) returns to its resting state at the seam and the loop
// stays seamless. Callers must feed the same clock they feed rampTime.
export function rampRush(t, period) {
  const p = t / period - Math.floor(t / period);
  return Math.sin(Math.PI * p);
}
