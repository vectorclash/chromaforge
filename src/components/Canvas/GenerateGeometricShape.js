import tinycolor from 'tinycolor2';
import { randomColorHex } from '../../render/prng';
import { getCountScale, getSizeScale } from '../../render/scale';
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
    this.shapeDepth = 2 + Math.round(rng() * 4);
    this.shapeAng = 360 / this.shapeVertices;
    // Sized off the smaller dimension, not width alone (see render/scale.js) -- the "width *
    // height / (height * 3)" this replaces algebraically reduced to just "width / 3" anyway,
    // so this wasn't the area-based formula it looked like. The "150 +" floor is left as an
    // intentional absolute minimum (avoids degenerate near-zero shapes at tiny sizes), not
    // part of the aspect-ratio bug this fixes.
    const chaoticSize = 150 + Math.round((rng() * getSizeScale(width, height)) / 3);
    // At full coherence the whole lattice (radius = shapeSize * shapeDepth, drawn from the
    // canvas centre) must sit inside the visible design with clearance on all sides: 75% of
    // the short dimension's half, i.e. a 12.5% margin at the closest edge. In between,
    // interpolate -- the chaotic size can be far larger than the canvas (that off-screen
    // bleed IS the chaos), so raising coherence steadily reins it in. Pure arithmetic on
    // the single draw above; no rng() consumption depends on the coherence value here.
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

  // Index triples (into this.points) of every cell in the lattice: a fan of triangles
  // from the centre to ring 1, then each ring-to-ring band split into two triangles per
  // angular step. Derives points-per-ring from the array itself rather than assuming
  // shapeVertices iterations, so a floating-point wobble in pointsArray's `ang < 360`
  // accumulation could never desync the indexing.
  latticeCells() {
    const perRing = (this.points.length - 1) / this.shapeDepth;
    const idx = (ring, k) => 1 + (ring - 1) * perRing + (k % perRing);
    const cells = [];
    for (let k = 0; k < perRing; k++) {
      cells.push([0, idx(1, k), idx(1, k + 1)]);
    }
    for (let ring = 2; ring <= this.shapeDepth; ring++) {
      for (let k = 0; k < perRing; k++) {
        cells.push([idx(ring - 1, k), idx(ring, k), idx(ring, k + 1)]);
        cells.push([idx(ring - 1, k), idx(ring - 1, k + 1), idx(ring, k + 1)]);
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
  // between() shuffle of rng() draws). With `pointIndices` (a lattice cell from
  // latticeCells()): those exact points, no positional rng() at all -- the colors below
  // still draw identically either way.
  buildShape(pointIndices = null) {
    let shape = {
      colors: [],
      points: []
    };

    if (pointIndices) {
      shape.points.push(
        this.points[pointIndices[0]],
        this.points[pointIndices[1]],
        this.points[pointIndices[2]]
      );
    } else {
      let randomPoints = this.between(0, this.points.length - 1);

      shape.points.push(
        this.points[randomPoints[0]],
        this.points[randomPoints[1]],
        this.points[randomPoints[2]]
      );
    }

    if (this.colors.length > 0) {
      this.shuffleColors(this.colors);
      if (this.colors.length === 1) {
        let ranGrayScale = Math.round(this.rng() * 255);
        shape.colors.push(
          this.colors[0],
          tinycolor({ r: ranGrayScale, g: ranGrayScale, b: ranGrayScale }),
          tinycolor(this.colors[0])
            .spin(-40 + this.rng() * 80)
            .toHexString()
        );
      } else if (this.colors.length === 2) {
        shape.colors.push(
          this.colors[0],
          this.colors[1],
          tinycolor(this.colors[0])
            .spin(-20 + this.rng() * 40)
            .toHexString()
        );
      } else {
        shape.colors = this.colors;
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

  shuffleColors(array) {
    for (let i = 0; i < array.length; i++) {
      array[i] = tinycolor(array[i])
        .spin(-10 + this.rng() * 20)
        .toHexString();
    }
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
