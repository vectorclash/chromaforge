// ../src/render/generateArtwork.js
import tinycolor3 from "tinycolor2";

// ../src/render/prng.js
import tinycolor from "tinycolor2";
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = h << 13 | h >>> 19;
  }
  return function() {
    h = Math.imul(h ^ h >>> 16, 2246822507);
    h = Math.imul(h ^ h >>> 13, 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}
function mulberry32(a) {
  return function() {
    a |= 0;
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function makeRng(seed) {
  const seedStr = typeof seed === "number" ? String(seed) : String(seed ?? "");
  const next = xmur3(seedStr);
  return mulberry32(next());
}
function randomSeed() {
  let s = "";
  for (let i = 0; i < 8; i++) {
    s += Math.floor(Math.random() * 36).toString(36);
  }
  return s;
}
function randomColorHex(rng) {
  const c = () => Math.floor(rng() * 256);
  const hex = (n) => n.toString(16).padStart(2, "0");
  return `#${hex(c())}${hex(c())}${hex(c())}`;
}
function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}
function expandMonochromePalette(baseColor, rng, count = 3) {
  const base = tinycolor(baseColor);
  const { h, s, l } = base.toHsl();
  const isGrey = s === 0;
  const colors = [base.toHexString()];
  for (let i = 1; i < count; i++) {
    const dir = i % 2 === 1 ? 1 : -1;
    const step = Math.ceil(i / 2);
    const hue = isGrey ? h : (h + dir * (8 + rng() * 14) * step + 360) % 360;
    const lightness = clamp(l * 100 + dir * (10 + rng() * 14) * step, 12, 88);
    const saturation = isGrey ? 0 : clamp(s * 100 + (rng() - 0.5) * 20, 20, 95);
    colors.push(tinycolor({ h: hue, s: saturation, l: lightness }).toHexString());
  }
  return colors;
}
function randomPalette(rng, count, { minSpread = 8, maxSpread = 180, baseHue = null } = {}) {
  const spread = minSpread + rng() * (maxSpread - minSpread);
  const hueStart = baseHue === null ? rng() * 360 : baseHue;
  const step = count > 1 ? spread / (count - 1) : 0;
  const colors = [];
  for (let i = 0; i < count; i++) {
    const jitter = (rng() - 0.5) * step * 0.3;
    const hue = (hueStart + step * i + jitter + 360) % 360;
    const saturation = 55 + rng() * 35;
    const lightness = 40 + rng() * 25;
    colors.push(tinycolor({ h: hue, s: saturation, l: lightness }).toHexString());
  }
  return colors;
}

// ../src/components/Canvas/GenerateLinearGradient.js
var GenerateLinearGradient = class {
  constructor(width, height, complexity = 0, colors = [], rng = Math.random, { hueBias = null } = {}) {
    let config = {};
    config.width = width;
    config.height = height;
    let ranDirection = rng();
    if (ranDirection > 0.5) {
      config.gradientDirection = {
        x1: 0,
        y1: Math.round(rng() * height),
        x2: width,
        y2: Math.round(rng() * height)
      };
    } else {
      config.gradientDirection = {
        x1: Math.round(rng() * width),
        y1: 0,
        x2: Math.round(rng() * width),
        y2: height
      };
    }
    config.colors = [];
    if (colors.length > 0) {
      config.colors = colors;
    } else {
      let colorAmount = 2 + complexity;
      config.colors = randomPalette(
        rng,
        colorAmount,
        hueBias !== null ? { baseHue: hueBias, minSpread: 10, maxSpread: 35 } : {}
      );
    }
    return config;
  }
};

// ../src/render/scale.js
var REFERENCE_WIDTH = 3840;
var REFERENCE_HEIGHT = 2160;
var REFERENCE_AREA = REFERENCE_WIDTH * REFERENCE_HEIGHT;
var REFERENCE_ELEMENT_SIZE_SCALE = Math.min(REFERENCE_WIDTH, REFERENCE_HEIGHT);
function getCountScale(width, height) {
  return Math.sqrt(width * height / REFERENCE_AREA);
}
function getSizeScale(width, height) {
  return Math.min(width, height);
}
function resolveFrame(width, height, frame) {
  if (!frame) return [width, height];
  return [width * frame.width, height * frame.height];
}
var REFERENCE_ASPECT = REFERENCE_WIDTH / REFERENCE_HEIGHT;
function getElementSizeScale(width, height, frame = null) {
  const [w, h] = resolveFrame(width, height, frame);
  const canvasAspect = Math.max(w, h) / Math.min(w, h);
  return getSizeScale(w, h) * Math.min(1, (canvasAspect / REFERENCE_ASPECT) ** 2);
}
function getFrameSizeScale(width, height, frame = null) {
  const [w, h] = resolveFrame(width, height, frame);
  return getSizeScale(w, h);
}

// ../src/components/Canvas/GenerateLargeRadialField.js
var GenerateLargeRadialField = class {
  constructor(width, height, colors = [], rng = Math.random) {
    let config = {};
    config.width = width;
    config.height = height;
    config.radGradSize = getSizeScale(width, height) / 2;
    let amount = 2 + Math.round(rng() * 8);
    let keepAmount = Math.max(1, Math.round(amount * getCountScale(width, height)));
    let radGradients = [];
    for (let i = 0; i < amount; i++) {
      let radGrad = {};
      radGrad.alpha = rng().toFixed(2);
      radGrad.size = Math.round(config.radGradSize / 2 + rng() * config.radGradSize * 4);
      radGrad.x = Math.round(-radGrad.size + rng() * width + radGrad.size / 2);
      radGrad.y = Math.round(-radGrad.size + rng() * height + radGrad.size / 2);
      radGrad.colors = [];
      let colorAmount = 2 + Math.round(rng() * 3);
      if (colors.length > 0) {
        radGrad.colors = colors.slice();
      } else {
        radGrad.colors = randomPalette(rng, colorAmount);
      }
      radGradients.push(radGrad);
    }
    config.radGradients = radGradients.slice(0, keepAmount);
    return config;
  }
};

// ../src/components/Canvas/GenerateStarField.js
var GenerateStarField = class {
  constructor(width, height, colors = [], rng = Math.random, backgroundHue = null, sizeFrame = null) {
    let config = {};
    config.width = width;
    config.height = height;
    let sizeScale = getElementSizeScale(width, height, sizeFrame);
    let countScale = getCountScale(width, height);
    let gradientComplexity = Math.round(rng() * 4);
    const starHueBias = backgroundHue === null ? null : (backgroundHue + 180 + (rng() - 0.5) * 60 + 360) % 360;
    let gradientConfig = new GenerateLinearGradient(
      width,
      height,
      gradientComplexity,
      colors.reverse(),
      rng,
      { hueBias: starHueBias }
    );
    config.gradientConfig = gradientConfig;
    let stars = [];
    let xlStarSizeMax = sizeScale / 2.5;
    let xlStarSizeMin = sizeScale / 20;
    let xlStars = [];
    for (let i = 0; i < 5; i++) {
      let ranSize = Math.round(xlStarSizeMin + rng() * xlStarSizeMax);
      let ranX = Math.round(-100 + rng() * width + 100);
      let ranY = Math.round(-100 + rng() * height + 100);
      xlStars.push({ x: ranX, y: ranY, size: ranSize, image: "star-large" });
    }
    stars.push(...xlStars.slice(0, Math.max(1, Math.round(5 * countScale))));
    let largeStarSizeMax = sizeScale / 4.5;
    let largeStarSizeMin = sizeScale / 120;
    let largeStars = [];
    for (let i = 0; i < 50; i++) {
      let ranSize = Math.round(largeStarSizeMin + rng() * largeStarSizeMax);
      let ranX = Math.round(-100 + rng() * width + 100);
      let ranY = Math.round(-100 + rng() * height + 100);
      largeStars.push({ x: ranX, y: ranY, size: ranSize, image: "star-large" });
    }
    stars.push(...largeStars.slice(0, Math.max(1, Math.round(50 * countScale))));
    let mediumStarSizeMax = sizeScale / 100;
    let mediumStarSizeMin = sizeScale / 3e3;
    let mediumStars = [];
    for (let i = 0; i < 200; i++) {
      let ranSize = Math.round(mediumStarSizeMin + rng() * mediumStarSizeMax);
      let ranX = Math.round(-100 + rng() * width + 100);
      let ranY = Math.round(-100 + rng() * height + 100);
      mediumStars.push({ x: ranX, y: ranY, size: ranSize, image: "star-small" });
    }
    stars.push(...mediumStars.slice(0, Math.max(1, Math.round(200 * countScale))));
    let smallStarChance = rng();
    let smallStarAmount;
    if (smallStarChance < 0.7) {
      smallStarAmount = 5e3;
    } else if (smallStarChance > 0.7 && smallStarChance < 0.9) {
      smallStarAmount = Math.round(50 + rng() * 200);
    } else {
      smallStarAmount = Math.round(5e3 + rng() * 1e5);
    }
    config.smallStarAmount = Math.max(1, Math.round(smallStarAmount * countScale));
    let smallStars = [];
    let smallStarSizeMax = sizeScale / 500;
    let smallStarSizeMin = sizeScale / 5e3;
    for (let i = 0; i < smallStarAmount; i++) {
      let ranSize = smallStarSizeMin + rng() * smallStarSizeMax;
      let ranX = -100 + rng() * width + 100;
      let ranY = -100 + rng() * height + 100;
      smallStars.push({ x: ranX, y: ranY, size: ranSize });
    }
    config.smallStars = smallStars.slice(0, config.smallStarAmount);
    config.stars = stars;
    return config;
  }
};

// ../src/components/Canvas/GenerateGeometricShape.js
import tinycolor2 from "tinycolor2";

// ../src/render/designSettings.js
var DEFAULT_GEOMETRY_SETTINGS = {
  // Probability the geometry layer appears at all: 0 = never, 1 = always.
  chance: 0.4,
  // Lattice vertex-count range (a "points" value of 6 makes hexagonal lattices). Equal
  // min/max pins the shape: min = max = 6 means every design gets a hexagon.
  pointsMin: 3,
  pointsMax: 12,
  // 0 = fully chaotic (unbounded size, random unrecognizable triangles, panels mostly
  // unfilled); 1 = a clean regular polygon, every lattice cell filled, sized per `size`
  // below.
  coherence: 0,
  // How large the coherent polygon is: 0 = fairly small (a third of the canvas's half-
  // dimension), 1 = a dramatic overflow well past the canvas edge. Only takes effect at
  // coherence > 0 -- see GenerateGeometricShape's shapeSize blend, which already
  // interpolates the coherent size in proportion to coherence, so this setting naturally
  // gains influence as coherence rises and has zero effect at coherence 0 (chaotic mode
  // has never had a size dial). Default 0.5 is deliberately the exact midpoint of
  // GenerateGeometricShape's ORIGINAL [0.15, 0.6] size-factor range (0 to 0.5 is still that
  // same line -- the high end was later extended further, size=1 now reaching 1.8, but
  // 0.5 stays the fixed boundary between the two so this default is untouched), reproducing
  // the original fixed 0.375 "12.5% margin, fits exactly" full-coherence look byte-for-byte.
  size: 0.5,
  // What fraction of the generated chaotic shapes actually get drawn: 1 = all of them
  // (today's behaviour), lower = a sparser, brighter composition. Only affects the chaotic
  // triangles, not the coherent lattice cells (those are a complete figure -- slicing them
  // would leave a broken polygon; see the lattice path in GenerateGeometricShape).
  //
  // Added 2026-07-24 at Aaron's request, and it exists because of a genuinely useful
  // accident: before v7, keepCount was sliced by getCountScale(width, height), so SMALL
  // placements (a 3000x1800 t-shirt sleeve, countScale 0.807) silently dropped ~19% of the
  // shapes -- and that sparser version read dramatically brighter and more vivid than the
  // full-density front panel, because the shapes dropped are large translucent ones that
  // blend everything beneath them darker. v7 correctly removed that (density must not vary
  // by resolution, or a mockup lies about the print), which also removed the only way to
  // GET that look. This setting brings it back as a deliberate, size-INDEPENDENT choice:
  // every placement on a garment gets the same density, which is exactly what the v7 fix
  // guarantees and what the accident never could.
  //
  // Default 1 keeps output byte-identical to pre-density designs -- buildShape() already
  // runs shapeNum times unconditionally regardless of this value, so rng() consumption is
  // untouched and no GENERATOR_VERSION bump is needed (same reasoning as the original
  // settings block; verified by PNG hash across several seeds and sizes).
  density: 1
  // A `frontOnly` field used to live here (whether the geometry layer was suppressed on
  // non-front merch placements) but was removed 2026-07 -- baking that choice into the
  // saved design meant it was permanent for every product the design was ever printed on.
  // It's now a per-order choice instead: ProductPage.jsx's placement checkboxes, threaded
  // through as `includeGeometry` render context (see generateArtwork's renderContext
  // param) rather than a design setting. Old saved designs may still carry a stray
  // `settings.geometry.frontOnly` key; it's simply never read anymore.
};
function getGeometrySettings(settings) {
  return { ...DEFAULT_GEOMETRY_SETTINGS, ...settings?.geometry || null };
}
function compactSettings(settings) {
  const geometry = getGeometrySettings(settings);
  const isDefault = Object.keys(DEFAULT_GEOMETRY_SETTINGS).every(
    (key) => geometry[key] === DEFAULT_GEOMETRY_SETTINGS[key]
  );
  return isDefault ? void 0 : { geometry };
}

// ../src/components/Canvas/GenerateGeometricShape.js
var GenerateGeometricShape = class {
  constructor(width, height, shapeNum, colors = [], rng = Math.random, settings = null, geometryLayout = null, sizeFrame = null) {
    const geometry = getGeometrySettings(settings);
    let config = {
      width,
      height,
      shapes: []
    };
    if (geometryLayout) config.legLayout = geometryLayout;
    this.rng = rng;
    this.colors = colors;
    this.shapeVertices = geometry.pointsMin + Math.round(rng() * (geometry.pointsMax - geometry.pointsMin));
    const maxShapeDepth = 6 - Math.round(2 * geometry.coherence);
    const minShapeDepth = 2 + (geometry.coherence >= 0.85 ? 1 : 0);
    this.shapeDepth = minShapeDepth + Math.round(rng() * (maxShapeDepth - minShapeDepth));
    this.shapeAng = 360 / this.shapeVertices;
    const CHAOTIC_MIN_FRACTION = 150 / REFERENCE_ELEMENT_SIZE_SCALE;
    const chaoticSizeScale = getElementSizeScale(width, height, sizeFrame);
    const chaoticSize = Math.round(chaoticSizeScale * CHAOTIC_MIN_FRACTION) + Math.round(rng() * chaoticSizeScale / 3);
    const sizeFactor = geometry.size <= 0.5 ? 0.15 + geometry.size * 0.45 : 0.375 + (geometry.size - 0.5) * 2.85;
    const coherentSize = getFrameSizeScale(width, height, sizeFrame) * sizeFactor / this.shapeDepth;
    this.shapeSize = chaoticSize + (coherentSize - chaoticSize) * geometry.coherence;
    this.points = this.pointsArray(this.shapeSize);
    for (let i = 0; i < shapeNum; i++) {
      config.shapes.push(this.buildShape());
    }
    let keepCount = Math.max(1, Math.round(shapeNum * geometry.density));
    if (geometry.coherence > 0) {
      keepCount = Math.min(keepCount, Math.round(shapeNum * (1 - geometry.coherence)));
    }
    config.shapes = config.shapes.slice(0, keepCount);
    if (geometry.coherence > 0) {
      const cells = this.latticeCells();
      this.shuffle(cells);
      const cellKeep = Math.round(cells.length * Math.pow(geometry.coherence, 2.5));
      const ringOf = (p) => Math.round(Math.sqrt(p[0] * p[0] + p[1] * p[1]) / this.shapeSize);
      const maxRing = (c) => Math.max(ringOf(c[0]), ringOf(c[1]), ringOf(c[2]));
      const minRing = (c) => Math.min(ringOf(c[0]), ringOf(c[1]), ringOf(c[2]));
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
    const idx = (ring, k) => 1 + (ring - 1) * perRing + (k % perRing + perRing) % perRing;
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
        let rad = ang * Math.PI / 180;
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
      const spun = this.shuffleColors(this.colors);
      if (spun.length === 2) {
        shape.colors.push(
          spun[0],
          spun[1],
          tinycolor2(spun[0]).spin(-20 + this.rng() * 40).toHexString()
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
    return array.map((c) => tinycolor2(c).spin(-10 + this.rng() * 20).toHexString());
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
};

// ../src/render/generateArtwork.js
var GENERATOR_VERSION = 9;
var BLEND_MODES = [
  "screen",
  "overlay",
  "multiply",
  "hard-light",
  "lighten",
  "darken",
  "soft-light",
  "source-over"
];
function randomBlendMode(rng) {
  return BLEND_MODES[Math.floor(rng() * BLEND_MODES.length)];
}
function generateArtwork(seed = randomSeed(), width, height, colorValues = [], settings = null, { includeGeometry = true, geometryLayout = null, mirrorX = false, sizeFrame = null, legSymmetry = false } = {}) {
  const rng = makeRng(seed);
  const paletteColors = colorValues.length === 1 ? expandMonochromePalette(colorValues[0], makeRng(`${seed}-palette`)) : colorValues;
  const config = {
    generatorVersion: GENERATOR_VERSION,
    seed,
    width,
    height,
    // Pure render-time flag, consumed by renderArtwork -- see its comment. Consumes no
    // rng() and touches no layer generation, so a mirrored render is byte-for-byte the
    // same composition as its unmirrored twin, just flipped.
    mirrorX,
    // Same nature as mirrorX: a pure render-time raster operation consumed by renderArtwork,
    // consuming no rng() and touching no layer generation. Opt-in, so default output is
    // untouched and this needed no GENERATOR_VERSION bump.
    legSymmetry,
    colors: colorValues.slice()
  };
  const compactedSettings = compactSettings(settings);
  if (compactedSettings) config.settings = compactedSettings;
  config.gradientBackgroundConfig = new GenerateLinearGradient(
    width,
    height,
    1,
    paletteColors.slice(),
    rng
  );
  let radialChance = rng();
  if (radialChance > 0.4) {
    config.firstBlend = randomBlendMode(rng);
    config.radialFieldConfig = new GenerateLargeRadialField(
      width,
      height,
      paletteColors.slice(),
      rng
    );
  }
  config.secondBlend = randomBlendMode(rng);
  const backgroundHue = paletteColors.length === 0 ? tinycolor3(config.gradientBackgroundConfig.colors[0]).toHsl().h : null;
  config.starFieldConfig = new GenerateStarField(
    width,
    height,
    paletteColors.slice(),
    rng,
    backgroundHue,
    sizeFrame
  );
  let geometryChance = rng();
  const geometry = getGeometrySettings(settings);
  if (geometryChance >= 1 - geometry.chance) {
    config.thirdBlend = randomBlendMode(rng);
    let shapeNum = 10 + Math.round(rng() * 30);
    const geometryConfig = new GenerateGeometricShape(
      width,
      height,
      shapeNum,
      paletteColors.slice(),
      rng,
      settings,
      geometryLayout,
      sizeFrame
    );
    if (includeGeometry) {
      config.geometryConfig = geometryConfig;
    }
  }
  let overlayChance = rng();
  if (overlayChance >= 0.7 && paletteColors.length > 0) {
    config.overlayBlend = randomBlendMode(rng);
    config.overlayAlpha = rng().toFixed(2);
    config.overlayConfig = new GenerateLinearGradient(
      width,
      height,
      Math.round(rng() * 2),
      paletteColors.slice(),
      rng
    );
  }
  return config;
}

// ../src/components/Canvas/LinearGradient.js
function LinearGradient(config) {
  let canvas = document.createElement("canvas");
  let context = canvas.getContext("2d");
  canvas.width = config.width;
  canvas.height = config.height;
  let gradient = context.createLinearGradient(
    config.gradientDirection.x1,
    config.gradientDirection.y1,
    config.gradientDirection.x2,
    config.gradientDirection.y2
  );
  for (let i = 0; i < config.colors.length; i++) {
    let color = config.colors[i];
    gradient.addColorStop(i / config.colors.length, color);
  }
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}

// ../src/components/Canvas/RadialGradient.js
function RadialGradient(width, height, colors) {
  let canvas = document.createElement("canvas");
  let context = canvas.getContext("2d");
  canvas.width = width;
  canvas.height = height;
  let gradient = context.createRadialGradient(
    canvas.width / 2,
    canvas.height / 2,
    0,
    canvas.width / 2,
    canvas.height / 2,
    canvas.width / 2
  );
  for (let i = 0; i < colors.length; i++) {
    gradient.addColorStop(i / colors.length, colors[i]);
  }
  gradient.addColorStop(1, "transparent");
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}

// ../src/components/Canvas/LargeRadialField.js
function LargeRadialField(config) {
  let canvas = document.createElement("canvas");
  let context = canvas.getContext("2d");
  canvas.width = config.width;
  canvas.height = config.height;
  for (let i = 0; i < config.radGradients.length; i++) {
    context.globalCompositeOperation = "overlay";
    context.globalAlpha = Number(config.radGradients[i].alpha);
    let radGrad = RadialGradient(
      config.radGradSize,
      config.radGradSize,
      config.radGradients[i].colors
    );
    context.drawImage(
      radGrad,
      config.radGradients[i].x,
      config.radGradients[i].y,
      config.radGradients[i].size,
      config.radGradients[i].size
    );
  }
  return canvas;
}

// ../src/components/Canvas/StarField.js
function StarField(config, images) {
  let canvas = document.createElement("canvas");
  let context = canvas.getContext("2d");
  canvas.width = config.width;
  canvas.height = config.height;
  context.globalCompositeOperation = "destination-atop";
  let gradient = LinearGradient(config.gradientConfig);
  context.drawImage(gradient, 0, 0);
  let starCanvas = document.createElement("canvas");
  let starContext = starCanvas.getContext("2d");
  starCanvas.width = config.width;
  starCanvas.height = config.height;
  for (let i = 0; i < config.stars.length; i++) {
    let starImage = images.getResult(config.stars[i].image);
    if (starImage) {
      starContext.drawImage(
        starImage,
        config.stars[i].x,
        config.stars[i].y,
        config.stars[i].size,
        config.stars[i].size
      );
    }
  }
  let smallStars = config.smallStars;
  if (!smallStars && config.smallStarAmount) {
    smallStars = [];
    let smallStarSizeMax = config.width / 500;
    let smallStarSizeMin = config.width / 5e3;
    for (let i = 0; i < config.smallStarAmount; i++) {
      smallStars.push({
        x: -100 + Math.random() * config.width + 100,
        y: -100 + Math.random() * config.height + 100,
        size: smallStarSizeMin + Math.random() * smallStarSizeMax
      });
    }
  }
  if (smallStars) {
    let smallStarImage = images.getResult("star-small");
    if (smallStarImage) {
      for (let i = 0; i < smallStars.length; i++) {
        starContext.drawImage(
          smallStarImage,
          smallStars[i].x,
          smallStars[i].y,
          smallStars[i].size,
          smallStars[i].size
        );
      }
    }
  }
  context.drawImage(starCanvas, 0, 0);
  return canvas;
}

// ../src/components/Canvas/GeometricShape.js
function buildShape(shapeConfig) {
  let fill = new window.createjs.Shape();
  fill.graphics.beginLinearGradientFill(
    [shapeConfig.colors[0], shapeConfig.colors[1], shapeConfig.colors[2]],
    [0, 0.5, 1],
    shapeConfig.points[0][0],
    shapeConfig.points[0][1],
    shapeConfig.points[2][0],
    shapeConfig.points[2][1]
  );
  fill.graphics.moveTo(shapeConfig.points[0][0], shapeConfig.points[0][1]);
  fill.graphics.lineTo(shapeConfig.points[1][0], shapeConfig.points[1][1]);
  fill.graphics.lineTo(shapeConfig.points[2][0], shapeConfig.points[2][1]);
  fill.graphics.lineTo(shapeConfig.points[0][0], shapeConfig.points[0][1]);
  fill.graphics.endFill();
  fill.compositeOperation = "hard-light";
  return fill;
}
function addContainer(stage, shapes, { x, y, flip = false }) {
  let container = new window.createjs.Container();
  container.x = x;
  container.y = y;
  container.rotation = 90;
  if (flip) container.scaleX = -1;
  for (let i = 0; i < shapes.length; i++) {
    container.addChild(buildShape(shapes[i]));
  }
  stage.addChild(container);
}
function GeometricShape(config) {
  let canvas = document.createElement("canvas");
  canvas.width = config.width;
  canvas.height = config.height;
  let stage = new window.createjs.Stage(canvas);
  if (config.legLayout === "single") {
    addContainer(stage, config.shapes, { x: config.width / 4, y: config.height / 2 });
  } else if (config.legLayout === "mirror") {
    addContainer(stage, config.shapes, { x: config.width / 4, y: config.height / 2 });
    addContainer(stage, config.shapes, { x: config.width * 3 / 4, y: config.height / 2, flip: true });
  } else {
    addContainer(stage, config.shapes, { x: config.width / 2, y: config.height / 2 });
  }
  stage.update();
  return canvas;
}

// ../src/render/renderArtwork.js
function clearElement(el) {
  el.width = 0;
  el.height = 0;
}
function renderArtwork(config, images) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = config.width;
  canvas.height = config.height;
  if (config.mirrorX) {
    ctx.translate(config.width, 0);
    ctx.scale(-1, 1);
  }
  const gradientBackground = LinearGradient(config.gradientBackgroundConfig);
  ctx.drawImage(gradientBackground, 0, 0);
  clearElement(gradientBackground);
  if (config.radialFieldConfig) {
    ctx.globalCompositeOperation = config.firstBlend;
    const radialField = LargeRadialField(config.radialFieldConfig);
    ctx.drawImage(radialField, 0, 0);
    clearElement(radialField);
  }
  ctx.globalCompositeOperation = config.secondBlend;
  const starField = StarField(config.starFieldConfig, images);
  ctx.drawImage(starField, 0, 0);
  clearElement(starField);
  if (config.geometryConfig) {
    ctx.globalCompositeOperation = config.thirdBlend;
    const geometry = GeometricShape(config.geometryConfig);
    ctx.drawImage(geometry, 0, 0);
    clearElement(geometry);
  }
  if (config.overlayConfig) {
    ctx.globalCompositeOperation = config.overlayBlend;
    ctx.globalAlpha = Number(config.overlayAlpha);
    const gradientOverlay = LinearGradient(config.overlayConfig);
    ctx.drawImage(gradientOverlay, 0, 0);
    clearElement(gradientOverlay);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  if (config.legSymmetry) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const half = Math.ceil(config.width / 2);
    ctx.save();
    ctx.translate(config.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(canvas, 0, 0, half, config.height, 0, 0, half, config.height);
    ctx.restore();
  }
  return canvas;
}
export {
  GENERATOR_VERSION,
  generateArtwork,
  renderArtwork
};
