// The colours a 3D tunnel scene ACTUALLY renders with.
//
// `design.colors` is a design's stored IDENTITY, not the colours it renders with -- it is
// EMPTY for every auto-palette design (see render/resolvedPalette.js for the 2D counterpart),
// in which case the scene invents a seeded palette of its own. So anything outside the scene
// that has to match it -- the animation's logo-mark accent -- must go through this rather than
// reading `colors` directly.
//
// It lives in its own module, apart from tunnelScene.js, ONLY because that file statically
// imports three.js: three is dynamically imported everywhere so it stays in its own lazy chunk
// (see CLAUDE.md), and a static import of tunnelScene from DisplayCanvas would drag ~185KB
// into the main bundle for the sake of five colours.
//
// It takes the rng instead of making its own precisely so there is one draw sequence:
// createTunnelScene passes its own `-3d` stream, and an external caller passes a fresh
// makeRng(`${seed}-3d`), landing on the identical palette without perturbing anything
// downstream in the scene.

import { randomPalette } from '../render/prng';

export function resolveScenePalette(rng, colors = []) {
  return colors.length > 0 ? colors.slice(0, 6) : randomPalette(rng, 5);
}

export default resolveScenePalette;
