// The vectorclash mark as it appears in an animation export -- the seed-specific variant
// for whichever design is being animated.
//
// This is deliberately NOT a second implementation of the mark. It calls
// generateMarkLines() against the same `${seed}-label` stream the printed label mark uses,
// so a design's video mark and its sewn-in tag carry the identical surviving chords and
// inks. What differs is everything around the mark: no panels, no background fill, no
// transparency ink-inversion (that exists so the mark survives printed over fabric; over
// the animation it sits on the artwork's own dark-to-mid tones and wants the light inks).

import { generateMarkLines, MARK_BOUNDS, MARK_RING, MARK_RING_COLOR } from './generateLabelMark';

// `palette` is the design's actually-rendered colours, which the caller has to resolve because
// it differs per mode (2D: the artwork's own gradient stops; 3D: the tunnel scene's). Passing
// it is what keeps the mark's accent on the design instead of on generateLabelMark's
// DEFAULT_BASE_COLOR -- `design.colors` is empty for every auto-palette design, so without
// this the accent chords come out the same yellow-green (#ccff00) on the majority of designs.
// It shifts no rng() draws, so the surviving chords are the printed tag's exactly; only the
// ~20% of them that carry the accent are recoloured.
export function generateLogoMark(design, { palette = null } = {}) {
  const { lines, accentColor } = generateMarkLines(design, { transparent: false, palette });
  return {
    lines,
    accentColor,
    ringColor: MARK_RING_COLOR,
    ring: MARK_RING,
    bounds: MARK_BOUNDS
  };
}

export default generateLogoMark;
