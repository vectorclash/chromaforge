import tinycolor from 'tinycolor2';
import { randomColorHex } from '../../render/prng';
import {
  getSizeScale,
  getElementSizeScale,
  getFrameSizeScale,
  REFERENCE_ELEMENT_SIZE_SCALE
} from '../../render/scale';
import { getGeometrySettings } from '../../render/designSettings';

export default class GenerateGeometricShape {
  constructor(
    width,
    height,
    shapeNum,
    colors = [],
    rng = Math.random,
    settings = null,
    geometryLayout = null,
    sizeFrame = null
  ) {
    const geometry = getGeometrySettings(settings);

    let config = {
      width: width,
      height: height,
      shapes: []
    };
    // Passed straight through to GeometricShape.js's renderer -- see its own comment for
    // what 'single'/'mirror' do. Not consumed here at all (no rng() draws depend on it),
    // so it can't desync the settings-dependent rng() consumption invariant the rest of
    // this generator relies on.
    if (geometryLayout) config.legLayout = geometryLayout;

    this.rng = rng;
    this.colors = colors;

    this.shapeVertices =
      geometry.pointsMin + Math.round(rng() * (geometry.pointsMax - geometry.pointsMin));
    // Ring count (shapeDepth): 2-6 at coherence 0 (unchanged from before coherence existed --
    // chaotic triangles hide the ring structure, so more rings never looked odd there), reined
    // in to 2-4 at full coherence, where every ring is a fully visible band and 5-6 of them
    // packed inside the fixed coherentSize clearance below reads as too busy/thin. Interpolated
    // linearly so partial coherence isn't a hard cutoff. Still exactly one rng() draw regardless
    // of coherence, preserving the "settings-dependent rng() consumption is size-independent"
    // invariant the rest of this generator depends on.
    // The min rises too (2 -> 3 at full coherence): with the vector-equilibrium chord
    // cells (see latticeCells), depth 2 has only one ring pair to splay between and reads
    // washed-out/soft rather than as the nested web -- confirmed against real renders at
    // 6 vertices (36 cells vs. depth 3's 72). Threshold deliberately isn't the slider's
    // exact midpoint: `2 + Math.round(coherence)` (the original formula) flips at exactly
    // 0.5 with no ramp -- an extra ring (and the cell-count jump that comes with it, since
    // cell count grows with ring-pair count) landing at exactly the halfway point directly
    // fed the "50% looks like 100%" complaint alongside the cellKeep fix below. Moved to
    // 0.85 -- close enough to full coherence to still avoid the washed-out depth-2 look
    // there, but out of the 0-0.7 range where cellKeep's own ramp is doing the real work.
    const maxShapeDepth = 6 - Math.round(2 * geometry.coherence);
    const minShapeDepth = 2 + (geometry.coherence >= 0.85 ? 1 : 0);
    this.shapeDepth = minShapeDepth + Math.round(rng() * (maxShapeDepth - minShapeDepth));
    this.shapeAng = 360 / this.shapeVertices;
    // Orientation-independent (see render/scale.js's getElementSizeScale) -- chaotic shapes
    // have no containment requirement (unlike coherentSize below), so there's no reason to
    // anchor their size to the short axis only, which was making them relatively bigger on
    // near-square/portrait canvases than on wide ones.
    //
    // The minimum term is a FRACTION of the size scale, not an absolute pixel count. It used
    // to read `150 + ...`, described as "an intentional absolute minimum (avoids degenerate
    // near-zero shapes at tiny sizes)". The intent was fine; a fixed pixel value was the wrong
    // mechanism, and it was a real bug (v8 -> v9, 2026-07-29, found by Aaron comparing a
    // Printful order preview against the live product page): this formula is otherwise fully
    // resolution-relative, so an absolute term makes a render's composition depend on the
    // pixel size it happens to be rendered at. Mockup previews render through
    // capMockupRenderSize while print files render at true printfile dimensions, so previews
    // systematically showed LARGER shapes than the print they were previewing -- on the mesh
    // shorts, whose 11250px sheet is capped to 2000px (a 5.6x ratio, the largest in the
    // catalogue), the first shape spanned 37.6% of the sheet in the preview against 22.9% in
    // the print, +65%. That also explains those mockups reading washed-out pastel: oversized
    // translucent shapes stack toward white. A relative floor is scale-invariant, so a small
    // canvas now gets proportionally small shapes -- which is what "the same composition at any
    // size" means, and is not degenerate.
    // 150/2160 is chosen to reproduce the old value EXACTLY at the studio's own default
    // resolution, so the canvas people actually design on does not move at all; every other
    // size is what shifts. The two terms are rounded SEPARATELY, matching the old
    // `150 + Math.round(...)` exactly rather than rounding their sum -- rounding the sum would
    // differ by up to 1px at the reference and give up that guarantee for nothing.
    // Consumes the same single rng() draw, so no downstream layer shifts.
    const CHAOTIC_MIN_FRACTION = 150 / REFERENCE_ELEMENT_SIZE_SCALE;
    const chaoticSizeScale = getElementSizeScale(width, height, sizeFrame);
    const chaoticSize =
      Math.round(chaoticSizeScale * CHAOTIC_MIN_FRACTION) + Math.round((rng() * chaoticSizeScale) / 3);
    // At full coherence the lattice radius (shapeSize * shapeDepth, drawn from the canvas
    // centre) is user-controlled via geometry.size: 0.15 * sizeScale (fairly small, ~30%
    // of the short dimension's half) at size=0, up through 0.375 * sizeScale (the original
    // fixed factor, fitting with the original 12.5% margin) at size=0.5, the default --
    // deliberately piecewise-linear rather than one straight line across the whole [0, 1]
    // range, since a single line pins its midpoint at exactly (low+high)/2, and 0.375 is
    // already load-bearing as the exact midpoint of the ORIGINAL [0.15, 0.6] range (so
    // pre-existing designs, which have no `size` field and fall back to the 0.5 default,
    // keep rendering byte-identical). Raising the high end (Aaron's call, 2026-07-06: the
    // old 0.6 ceiling "should be much higher") without breaking that invariant meant
    // extending only the size>0.5 half onto a steeper second line, up to 1.8 * sizeScale at
    // size=1 (3x the old 0.6 ceiling -- a dramatic overflow, most of the polygon extending
    // well past the canvas edge). Deliberately keeps using getSizeScale (min(w,h)), not
    // getElementSizeScale -- containment/overflow amount should key off the short axis, not
    // the orientation-independent element scale, so a non-square canvas doesn't bleed
    // differently depending on which axis is short.
    // In between coherence 0 and 1, interpolate -- the chaotic size can be far larger than
    // the canvas (that off-screen bleed IS the chaos), so raising coherence steadily reins
    // it in AND, as a side effect of this same lerp, steadily hands control to the size
    // setting -- at coherence 0 shapeSize collapses to exactly chaoticSize regardless of
    // size (0 * anything = 0), so the size slider has no effect until coherence rises,
    // matching the "the higher the coherence, the more accurate/controllable" request.
    // Pure arithmetic on the single depth draw above; no rng() consumption depends on
    // coherence or size.
    const sizeFactor =
      geometry.size <= 0.5
        ? 0.15 + geometry.size * 0.45
        : 0.375 + (geometry.size - 0.5) * 2.85;
    const coherentSize = (getFrameSizeScale(width, height, sizeFrame) * sizeFactor) / this.shapeDepth;
    this.shapeSize = chaoticSize + (coherentSize - chaoticSize) * geometry.coherence;

    this.points = this.pointsArray(this.shapeSize);

    // shapeNum (from generateArtwork.js) is unscaled -- this loop always builds the full,
    // size-independent count (each buildShape() call's rng() consumption doesn't depend on
    // width/height, only on this.colors.length, which is fixed per design).
    for (let i = 0; i < shapeNum; i++) {
      config.shapes.push(this.buildShape());
    }
    // REAL bug, found via a live customer order (2026-07-20): this used to slice the kept
    // count by getCountScale(width, height), same as GenerateStarField/
    // GenerateLargeRadialField -- but for geometry specifically that meant a mockup preview
    // (rendered client-side capped at RENDER_CAP=2000, see lib/printful.js) could keep a
    // visibly smaller SUBSET of these shapes than the real, uncapped print render at true
    // printfile resolution -- not a smaller picture of the same composition, a genuinely
    // different one (confirmed live: the same seed rendered at a mockup's capped size vs.
    // its print's real size was missing entire shapes, including one that dominated the
    // print's center). The coherent lattice-cell path below already exempts itself from
    // getCountScale for exactly this reason ("a thumbnail must show the same complete shape
    // as a print") -- this makes the chaotic-shape path match that same standard, since the
    // business requirement is that geometry must render as identically as possible across
    // resolutions, even though stars/gradients are allowed to vary. Safe to do without
    // affecting the rng()-consumption invariant: buildShape() already runs shapeNum times
    // unconditionally above regardless of size, so this only changes how much of that
    // already-generated, size-independent result gets kept, not what gets drawn from rng().
    //
    // `density` (see designSettings.js) is the deliberate, studio-controlled version of the
    // slice this bug fix removed. Critically it is NOT a function of width/height, so it
    // can't reintroduce the mockup/print divergence above -- every placement of a given
    // design keeps the same shapes regardless of its printfile size. Default 1 keeps all of
    // them, exactly as this line did before the setting existed.
    let keepCount = Math.max(1, Math.round(shapeNum * geometry.density));
    // Coherence trades these chaotic random triangles away for ordered lattice cells
    // (below): at 1, none survive -- only the clean polygon remains. Applied as a min()
    // against whatever density already allowed, so the two compose rather than override:
    // high coherence still wins (it must reach 0 survivors at 1) and low density can only
    // ever remove more, never add back.
    if (geometry.coherence > 0) {
      keepCount = Math.min(keepCount, Math.round(shapeNum * (1 - geometry.coherence)));
    }
    config.shapes = config.shapes.slice(0, keepCount);

    if (geometry.coherence > 0) {
      // The recognizable-shape half of coherence: fill the lattice's actual cells (the
      // triangles that tessellate the regular polygon) instead of arbitrary 3-point
      // triangles. A `coherence` fraction of all cells is drawn, shuffled so a partial
      // fill scatters organically rather than always growing from the centre; at 1 that's
      // every cell -- a perfect fully-filled polygon. Deliberately NOT sliced by
      // getCountScale: the filled polygon is the design itself, so a thumbnail must show
      // the same complete shape as a print (cell count tops out at 12 vertices x depth 6 =
      // 132 triangles, trivial at any size). All rng() consumed here (the shuffle + each
      // cell's colors) depends only on vertex/depth/coherence -- size-independent, so the
      // cross-size determinism guarantee holds.
      const cells = this.latticeCells();
      this.shuffle(cells);
      // A straight `cells.length * coherence` (the original formula) undersold how fast
      // this fills visually: the cells overlap heavily by design (see latticeCells'
      // comment on hard-light blending), so a modest fraction of them already covers most
      // of the polygon's area -- confirmed by measuring actual painted-pixel density
      // inside the shape's own footprint at each coherence step (a scratch
      // render-service/spike-coherence.js harness, not committed): the linear formula hit
      // ~80% visual density by coherence 0.1-0.3 and never moved much past that the rest
      // of the way to 1 (Aaron's report: "at 50% it feels like it's almost 100%"). Raising
      // this to an exponent backs off cellKeep hard at low coherence and lets it catch up
      // near the top, which measured out much closer to a linear density ramp (~50% density
      // at 0.3, ~80% at 0.7, ~83% -- the format's actual ceiling -- only at 1). 2.5 was the
      // best fit tried (1.5/2/3 also tested); not a formula with special meaning, just the
      // exponent that matched real measured density best.
      const cellKeep = Math.round(cells.length * Math.pow(geometry.coherence, 2.5));
      // The shuffle above only decides WHICH cells survive a partial fill (scattered, not
      // center-out). Draw order is deterministic: cells reaching the outer rings render
      // first (behind) and cells connecting toward the centre render last (on top) --
      // with shuffled order, a big outer chord panel drawn late would sit over the inner
      // web and swallow its edges (user-reported: points looked disconnected). Sort by
      // outermost vertex radius descending, then innermost ascending-depth (a splay
      // triangle reaching further inward layers above that same ring's own star
      // triangles). Pure arithmetic on already-selected cells: no rng(), so consumption
      // and the cross-size determinism guarantee are untouched. Keys are quantized to
      // integer RING indices, not raw radii: pointsArray rounds coordinates to pixels, so
      // two vertices nominally on the same ring have slightly different raw radii, and
      // that rounding noise varies with canvas size -- raw-radius keys could order two
      // same-ring cells differently at different sizes, desyncing which rng() colors each
      // cell gets between a mockup and its print. Ring-index keys make every intended tie
      // exact; ties fall back to the shuffled order, which is itself size-independent.
      const ringOf = p => Math.round(Math.sqrt(p[0] * p[0] + p[1] * p[1]) / this.shapeSize);
      const maxRing = c => Math.max(ringOf(c[0]), ringOf(c[1]), ringOf(c[2]));
      const minRing = c => Math.min(ringOf(c[0]), ringOf(c[1]), ringOf(c[2]));
      const kept = cells.slice(0, cellKeep);
      kept.sort((a, b) => maxRing(b) - maxRing(a) || minRing(b) - minRing(a));
      for (let i = 0; i < kept.length; i++) {
        config.shapes.push(this.buildShape(kept[i]));
      }
    }

    return config;
  }

  // Point triples (literal [x,y] coordinates, not indices) of the coherent structure's
  // cells: a "vector equilibrium" web of long chords, not a disjoint tessellation. Two
  // families, both spanning the figure vertex-to-vertex:
  //   1. Per ring, every "star" chord triangle (k, k+skip, k+2*skip) for every skip up to
  //      V/2 -- this traces the complete chord graph of each ring (same edge set as all
  //      C(V,3) triangles, verified by wireframe comparison, at V*floor(V/2) cells per
  //      ring instead of C(V,3), which matters at V=12 where C(V,3)=220).
  //   2. Between every PAIR of rings (not just adjacent), for each outer-ring vertex k and
  //      each skip j, the symmetric splay triangle (outer k, inner k+j, inner k-j) -- the
  //      long chords fanning from each vertex down into every nested ring.
  // This replaced an earlier disjoint fan/band tessellation (center fan + each ring-band
  // quad fanned from its own centroid) that filled the polygon completely but read as a
  // faceted gemstone; the user wanted the classic vector-equilibrium look (nested rings
  // with every vertex chord-connected across the whole figure), reference-matched via
  // rendered wireframes before landing. Cells now overlap heavily by design --
  // GeometricShape.js fills with 'hard-light' compositing, so overlaps blend rather than
  // occlude. Derives points-per-ring from the array itself rather than assuming
  // shapeVertices iterations, so a floating-point wobble in pointsArray's `ang < 360`
  // accumulation could never desync the indexing. No rng() here: cell geometry/count
  // depends only on vertices/depth -- size-independent, preserving cross-size determinism.
  latticeCells() {
    const perRing = (this.points.length - 1) / this.shapeDepth;
    const idx = (ring, k) => 1 + (ring - 1) * perRing + (((k % perRing) + perRing) % perRing);
    // floor((V-1)/2), NOT floor(V/2): for even V, skip = V/2 makes the star triangle's
    // third point wrap onto its first ((k, k+V/2, k+V) = (k, k+V/2, k)) and the splay
    // triangle's two inner points coincide (k+V/2 == k-V/2 mod V) -- zero-area cells that
    // render as nothing but still consume color rng() and partial-coherence slots.
    const maxSkip = Math.floor((perRing - 1) / 2);
    const cells = [];
    for (let ring = 1; ring <= this.shapeDepth; ring++) {
      for (let skip = 1; skip <= maxSkip; skip++) {
        for (let k = 0; k < perRing; k++) {
          cells.push([
            this.points[idx(ring, k)],
            this.points[idx(ring, k + skip)],
            this.points[idx(ring, k + 2 * skip)]
          ]);
        }
      }
    }
    for (let outer = 2; outer <= this.shapeDepth; outer++) {
      for (let inner = 1; inner < outer; inner++) {
        for (let k = 0; k < perRing; k++) {
          for (let j = 1; j <= maxSkip; j++) {
            cells.push([
              this.points[idx(outer, k)],
              this.points[idx(inner, k + j)],
              this.points[idx(inner, k - j)]
            ]);
          }
        }
      }
    }
    return cells;
  }

  pointsArray(r) {
    let radius = r;
    let points = [];

    points.push([0, 0]);

    for (let h = 1; h <= this.shapeDepth; h++) {
      for (let ang = 0; ang < 360; ang += this.shapeAng) {
        let rad = (ang * Math.PI) / 180;
        let newX = 0 + radius * h * Math.cos(rad);
        let newY = 0 + radius * h * Math.sin(rad);

        points.push([Math.round(newX), Math.round(newY)]);
      }
    }

    return points;
  }

  // With no argument: the original chaotic behaviour, three random lattice points (one
  // between() shuffle of rng() draws). With `cellPoints` (a literal [x,y] triple from
  // latticeCells(), which may include a computed centroid not in this.points at all): those
  // exact points, no positional rng() at all -- the colors below still draw identically
  // either way.
  buildShape(cellPoints = null) {
    let shape = {
      colors: [],
      points: []
    };

    if (cellPoints) {
      shape.points.push(cellPoints[0], cellPoints[1], cellPoints[2]);
    } else {
      let randomPoints = this.between(0, this.points.length - 1);

      shape.points.push(
        this.points[randomPoints[0]],
        this.points[randomPoints[1]],
        this.points[randomPoints[2]]
      );
    }

    if (this.colors.length > 0) {
      // A fresh spin of the ORIGINAL palette every call -- shuffleColors used to mutate
      // this.colors in place, so each call spun whatever the PREVIOUS call had already
      // spun it to, not the true original. That's a cumulative random walk: individually
      // each step is a small, bounded +-10 degree nudge, but walked call after call it
      // drifts smoothly and can travel a full hue rotation over dozens of shapes. For
      // chaotic (randomly positioned) shapes that drift is invisible noise; for the
      // coherent lattice, build order IS spatial order (ring by ring, angle by angle), so
      // the same smooth drift became a visible spiral -- confirmed live: even after fixing
      // the color-aliasing bug below (each shape its own array, not a shared reference),
      // the spiral persisted, because the underlying palette state was still walking.
      // Spinning fresh from the untouched original every time bounds each shape to +-10
      // degrees of the TRUE base color, with no memory of prior calls to walk through.
      const spun = this.shuffleColors(this.colors);
      // No spun.length === 1 case: a one-colour palette is expanded centrally before any
      // generator sees it (see expandMonochromePalette). What was here mixed in a random
      // greyscale as a raw tinycolor object -- see GenerateLargeRadialField's note.
      if (spun.length === 2) {
        shape.colors.push(
          spun[0],
          spun[1],
          tinycolor(spun[0])
            .spin(-20 + this.rng() * 40)
            .toHexString()
        );
      } else {
        shape.colors = spun;
      }
    } else {
      shape.colors.push(
        randomColorHex(this.rng),
        randomColorHex(this.rng),
        randomColorHex(this.rng)
      );
    }

    this.shuffle(shape.colors);

    return shape;
  }

  // Pure -- returns a new array, same length, each entry independently spun +-10 degrees.
  // Deliberately does not mutate `array` (see buildShape's comment on why a mutating
  // version caused a cumulative hue drift across shapes). Same number of rng() draws
  // either way (one per element), so this doesn't change rng() consumption/determinism.
  shuffleColors(array) {
    return array.map(c => tinycolor(c).spin(-10 + this.rng() * 20).toHexString());
  }

  shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      let j = Math.floor(this.rng() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }

  getRandomNumber(min, max) {
    let ranNumber = this.rng() * (max - min) + min;
    return ranNumber;
  }

  between(startNumber, endNumber) {
    let baseNumber = [];
    let randNumber = [];
    for (let i = startNumber; i <= endNumber; i++) {
      baseNumber[i] = i;
    }

    for (let i = endNumber; i > startNumber; i--) {
      let tempRandom = startNumber + Math.floor(this.rng() * (i - startNumber));
      randNumber[i] = baseNumber[tempRandom];
      baseNumber[tempRandom] = baseNumber[i];
    }

    randNumber[startNumber] = baseNumber[startNumber];

    return randNumber;
  }
}
