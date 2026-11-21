// The flight's higher-quality settings, by name (tunnelScene's `quality`): nebula overrides for
// nebula3d's NEB3D and extra star fields. Shared by the stock renderer (stockRender.js) and every
// ad builder export (src/adBuilder/flightQuality.js). Imports nothing, so the ad builder's panels can
// read the names without pulling three.js in.

// Overrides for nebula3d's NEB3D. 'site' is the live flight's own volume (still composited in
// float), for comparison.
export const NEBULA_PROFILES = {
  site: null,
  high: { volLateral: 320, volStep: 3, volOct: 7, volSteps: 240, volRes: 1, volDetailHi: true },
  ultra: { volLateral: 448, volStep: 2, volOct: 8, volSteps: 384, volRes: 1, volDetailHi: true },
  // The Blender Nebula Generator's 3D recipe (nebula3d's BLENDER_* shaders): dust lanes and lit gas.
  // Tuned 2026-11-21 from contact sheets: the file's own dust (a hard step at density 45, darkening
  // everything behind it) read as flat black cut-outs with torn edges, so the dust here is a soft
  // edge (dustEdge) and THIN (dustSigma 0.12 per world unit against the file's 45) -- thin dust veils
  // the sky, deep dust goes dark, which is what gives it volume -- with less of it (threshold) and
  // much brighter gas (gasGain), whose filaments are the recipe's real detail.
  blender: {
    recipe: 'blender', volLateral: 448, volStep: 2, volSteps: 384, volRes: 1, volDetailHi: true, volDetail: 0.06,
    threshold: 0.05, dustEdge: 0.03, dustSigma: 0.12,
    // Coloured the way the site colours its nebula (2026-11-21, after several rounds where it
    // read wrong): the gas brightness goes through the site's tone curve -- the alpha distribution
    // of Aaron's original nebula artwork (siteCurve) -- and is painted with the design's gradient,
    // with the site's colour pools. The dust only BLOCKS gas, leaving empty space; it does not
    // darken the sky (dustDark 0). Darkening the sky, black or tinted, is what kept altering the
    // design.
    siteCurve: true,
    dustDark: 0,
    forceNebula: 0.85, // a stock flight always has a nebula, even for a design that rolled none
    gasBody: 0.2,
    gasGain: 25
  }
};

// Extra stars (tunnelScene's quality.stars): 'more' doubles the two fields along the flight path,
// 'deep' also adds a shell of stars far off it.
export const STAR_PROFILES = {
  site: null,
  more: { density: 2 },
  deep: { density: 2, deepRadius: 420, deepCount: 12000, deepSize: 2.2 }
};

