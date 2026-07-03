import tinycolor from 'tinycolor2';
import { randomColorHex } from '../../render/prng';
import { getCountScale, getSizeScale, getElementSizeScale } from '../../render/scale';
import { getGeometrySettings } from '../../render/designSettings';

export default class GenerateGeometricShape {
  constructor(width, height, shapeNum, colors = [], rng = Math.random, settings = null) {
    const geometry = getGeometrySettings(settings);

    let config = {
      width: width,
      height: height,
      shapes: []
    };

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
    const maxShapeDepth = 6 - Math.round(2 * geometry.coherence);
    this.shapeDepth = 2 + Math.round(rng() * (maxShapeDepth - 2));
    this.shapeAng = 360 / this.shapeVertices;
    // Orientation-independent (see render/scale.js's getElementSizeScale) -- chaotic shapes
    // have no containment requirement (unlike coherentSize below), so there's no reason to
    // anchor their size to the short axis only, which was making them relatively bigger on
    // near-square/portrait canvases than on wide ones. The "150 +" floor is left as an
    // intentional absolute minimum (avoids degenerate near-zero shapes at tiny sizes), not
    // part of the aspect-ratio behavior this changes.
    const chaoticSize = 150 + Math.round((rng() * getElementSizeScale(width, height)) / 3);
    // At full coherence the whole lattice (radius = shapeSize * shapeDepth, drawn from the
    // canvas centre) must sit inside the visible design with clearance on all sides: 75% of
    // the short dimension's half, i.e. a 12.5% margin at the closest edge. This is a hard
    // containment requirement, so it deliberately keeps using getSizeScale (min(w,h)), not
    // getElementSizeScale -- switching it would let the polygon bleed past the short axis
    // on non-square canvases. In between, interpolate -- the chaotic size can be far larger
    // than the canvas (that off-screen bleed IS the chaos), so raising coherence steadily
    // reins it in. Pure arithmetic on the single draw above; no rng() consumption depends on
    // the coherence value here.
    const coherentSize = (getSizeScale(width, height) * 0.375) / this.shapeDepth;
    this.shapeSize = chaoticSize + (coherentSize - chaoticSize) * geometry.coherence;

    this.points = this.pointsArray(this.shapeSize);

    // shapeNum (from generateArtwork.js) is unscaled -- this loop always builds the full,
    // size-independent count (each buildShape() call's rng() consumption doesn't depend on
    // width/height, only on this.colors.length, which is fixed per design) and only a
    // size-scaled subset is kept, same fixed-generate-then-truncate reasoning as
    // GenerateStarField/GenerateLargeRadialField -- see render/scale.js.
    for (let i = 0; i < shapeNum; i++) {
      config.shapes.push(this.buildShape());
    }
    let keepCount = Math.max(1, Math.round(shapeNum * getCountScale(width, height)));
    // Coherence trades these chaotic random triangles away for ordered lattice cells
    // (below): at 1, none survive -- only the clean polygon remains.
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
      const cellKeep = Math.round(cells.length * geometry.coherence);
      for (let i = 0; i < cellKeep; i++) {
        config.shapes.push(this.buildShape(cells[i]));
      }
    }

    return config;
  }

  // Point triples (literal [x,y] coordinates, not indices) of every cell in the lattice: a
  // fan of triangles from the centre to ring 1, then each ring-to-ring band ALSO fanned --
  // from its own quad's centroid to its 4 corners -- rather than split by a diagonal.
  // Derives points-per-ring from the array itself rather than assuming shapeVertices
  // iterations, so a floating-point wobble in pointsArray's `ang < 360` accumulation could
  // never desync the indexing.
  //
  // This went through two failed approaches first, both confirmed live via a plotted
  // wireframe + a coordinate/index dump of every generated cell (not just eyeballing the
  // colored render, which two real, separate color-state bugs were muddying at the same
  // time): a trapezoid quad (innerK, innerK+1, outerK, outerK+1) can only be tiled by a
  // 2-triangle split by picking ONE of its two diagonals, and EVERY quad in a ring is the
  // same shape just rotated by the ring's own angular step -- so any single consistent
  // diagonal choice, applied to all of them, necessarily rotates in lockstep with the
  // quads themselves, producing a real (not illusory) windmill/pinwheel in the wireframe
  // itself. Alternating the diagonal by ring parity didn't fix it (verified: nearly
  // identical wireframe) since the bias within any ONE ring's 6 quads was untouched.
  // Alternating by k (angular position) instead was closer but still visibly asymmetric,
  // and leaves an uncancelled seam wherever perRing is odd. Fanning each quad from its own
  // centroid sidesteps the whole problem: there's no diagonal to choose at all, so there's
  // nothing that can rotate. It mirrors ring 1's fan-from-the-true-centre, which never had
  // this problem for the same reason.
  latticeCells() {
    const perRing = (this.points.length - 1) / this.shapeDepth;
    const idx = (ring, k) => 1 + (ring - 1) * perRing + (k % perRing);
    const cells = [];
    for (let k = 0; k < perRing; k++) {
      cells.push([this.points[0], this.points[idx(1, k)], this.points[idx(1, k + 1)]]);
    }
    for (let ring = 2; ring <= this.shapeDepth; ring++) {
      for (let k = 0; k < perRing; k++) {
        const a = this.points[idx(ring - 1, k)];
        const b = this.points[idx(ring - 1, k + 1)];
        const c = this.points[idx(ring, k + 1)];
        const d = this.points[idx(ring, k)];
        const centroid = [(a[0] + b[0] + c[0] + d[0]) / 4, (a[1] + b[1] + c[1] + d[1]) / 4];
        cells.push([centroid, a, b]);
        cells.push([centroid, b, c]);
        cells.push([centroid, c, d]);
        cells.push([centroid, d, a]);
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
      if (spun.length === 1) {
        let ranGrayScale = Math.round(this.rng() * 255);
        shape.colors.push(
          spun[0],
          tinycolor({ r: ranGrayScale, g: ranGrayScale, b: ranGrayScale }),
          tinycolor(spun[0])
            .spin(-40 + this.rng() * 80)
            .toHexString()
        );
      } else if (spun.length === 2) {
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
