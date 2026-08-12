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

export function generateLogoMark(design) {
  const { lines, accentColor } = generateMarkLines(design, { transparent: false });
  return {
    lines,
    accentColor,
    ringColor: MARK_RING_COLOR,
    ring: MARK_RING,
    bounds: MARK_BOUNDS
  };
}

export default generateLogoMark;
