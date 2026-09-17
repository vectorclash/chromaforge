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
function randomPalette(rng, count, { minSpread = 8, maxSpread = 180, baseHue = null, centered = false } = {}) {
  const spread = minSpread + rng() * (maxSpread - minSpread);
  const anchor = baseHue === null ? rng() * 360 : baseHue;
  const hueStart = centered ? anchor - spread / 2 : anchor;
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
var SAT_TARGET = 96;
var LIGHT_MIN = 30;
var LIGHT_MAX = 56;
var LIGHT_TARGET_DARK = 34;
var LIGHT_TARGET_LIGHT = 52;
var BRIGHT_BACKDROP = 0.42;
function contrastPalette(colors, backgroundLuminance, strength = 1) {
  const goDark = backgroundLuminance > BRIGHT_BACKDROP;
  const targetL = goDark ? LIGHT_TARGET_DARK : LIGHT_TARGET_LIGHT;
  return colors.map((c) => {
    const { h, s, l } = tinycolor(c).toHsl();
    const l100 = l * 100;
    const s100 = s * 100;
    const nextL = l100 + (targetL - l100) * strength;
    const nextS = Math.max(s100, s100 + (SAT_TARGET - s100) * strength);
    return tinycolor({
      h,
      s: clamp(nextS, 0, 100),
      l: clamp(nextL, LIGHT_MIN, LIGHT_MAX)
    }).toHexString();
  });
}
function meanLuminance(colors) {
  if (!colors || colors.length === 0) return 0.5;
  let sum = 0;
  for (const c of colors) {
    const { r, g, b } = tinycolor(c).toRgb();
    const lin = (v) => {
      const x = v / 255;
      return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    sum += 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }
  return sum / colors.length;
}

// ../src/components/Canvas/GenerateLinearGradient.js
var GenerateLinearGradient = class {
  constructor(width, height, complexity = 0, colors = [], rng = Math.random, { hueBias = null, hueSpread = null } = {}) {
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
        hueBias !== null ? {
          baseHue: hueBias,
          centered: true,
          minSpread: hueSpread ? hueSpread.min : 10,
          maxSpread: hueSpread ? hueSpread.max : 35
        } : {}
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

// ../src/render/valueNoise.js
function nHash(x, y, z) {
  const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return n - Math.floor(n);
}
function nLerp(a, b, t) {
  return a + (b - a) * t;
}
function nSmooth(t) {
  return t * t * (3 - 2 * t);
}
function valueNoise(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = nSmooth(x - ix), fy = nSmooth(y - iy), fz = nSmooth(z - iz);
  return nLerp(
    nLerp(
      nLerp(nHash(ix, iy, iz), nHash(ix + 1, iy, iz), fx),
      nLerp(nHash(ix, iy + 1, iz), nHash(ix + 1, iy + 1, iz), fx),
      fy
    ),
    nLerp(
      nLerp(nHash(ix, iy, iz + 1), nHash(ix + 1, iy, iz + 1), fx),
      nLerp(nHash(ix, iy + 1, iz + 1), nHash(ix + 1, iy + 1, iz + 1), fx),
      fy
    ),
    fz
  );
}

// ../src/components/Canvas/GenerateStarField.js
var XL_BASE = 5;
var XL_TOTAL = 7;
var LARGE_BASE = 50;
var LARGE_TOTAL = 90;
var MEDIUM_BASE = 200;
var MEDIUM_TOTAL = 450;
var FINE_SIZE_DIVISOR = 300;
var FINE_FIELD = { freqLarge: 4.5, freqMid: 11.3, freqFine: 29.2, ampLarge: 0.6, ampMid: 0.28, ampFine: 0.12 };
var FIELD_LO = 0.286;
var FIELD_SPAN = 0.48;
var FIELD_JITTER = 0.42;
var FINE_SKEW = 1.4;
function fineFieldAt(u, v, offset) {
  const n = valueNoise(u * FINE_FIELD.freqLarge + offset, v * FINE_FIELD.freqLarge + offset, offset) * FINE_FIELD.ampLarge + valueNoise(u * FINE_FIELD.freqMid + offset, v * FINE_FIELD.freqMid + offset, offset * 2) * FINE_FIELD.ampMid + valueNoise(u * FINE_FIELD.freqFine + offset, v * FINE_FIELD.freqFine + offset, offset * 3) * FINE_FIELD.ampFine;
  const unit = n / (FINE_FIELD.ampLarge + FINE_FIELD.ampMid + FINE_FIELD.ampFine);
  return Math.min(1, Math.max(0, (unit - FIELD_LO) / FIELD_SPAN));
}
var GenerateStarField = class {
  constructor(width, height, colors = [], rng = Math.random, backgroundHue = null, sizeFrame = null, backgroundLuminance = 0.5, seed = "") {
    let config = {};
    const starRng = makeRng(`${seed}-stars`);
    config.width = width;
    config.height = height;
    let sizeScale = getElementSizeScale(width, height, sizeFrame);
    let countScale = getCountScale(width, height);
    let gradientComplexity = Math.round(rng() * 4);
    const starHueBias = backgroundHue === null ? null : (backgroundHue + 180 + (rng() - 0.5) * 60 + 360) % 360;
    const SPECTRUM_CHANCE = 0.14;
    const spectrum = starRng() < SPECTRUM_CHANCE;
    let gradientConfig = new GenerateLinearGradient(
      width,
      height,
      gradientComplexity,
      colors.reverse(),
      rng,
      {
        hueBias: starHueBias,
        hueSpread: spectrum ? { min: 130, max: 260 } : { min: 10, max: 35 }
      }
    );
    const contrastStrength = 0.6 + starRng() * 0.4;
    gradientConfig.colors = contrastPalette(
      gradientConfig.colors,
      backgroundLuminance,
      contrastStrength
    );
    config.gradientConfig = gradientConfig;
    let stars = [];
    const ABUNDANT_CHANCE = 0.15;
    const abundant = starRng() < ABUNDANT_CHANCE;
    let xlStarSizeMax = sizeScale / (abundant ? 3.2 : 7);
    let xlStarSizeMin = sizeScale / 40;
    let xlStars = [];
    for (let i = 0; i < XL_TOTAL; i++) {
      const r = i < XL_BASE ? rng : starRng;
      let ranSize = Math.round(xlStarSizeMin + Math.pow(r(), 2.4) * xlStarSizeMax);
      let ranX = Math.round(-100 + r() * width + 100);
      let ranY = Math.round(-100 + r() * height + 100);
      xlStars.push({ x: ranX, y: ranY, size: ranSize, image: "star-large" });
    }
    stars.push(...xlStars.slice(0, Math.max(1, Math.round(XL_TOTAL * countScale))));
    let largeStarSizeMax = sizeScale / (abundant ? 7 : 14);
    let largeStarSizeMin = sizeScale / 200;
    let largeStars = [];
    for (let i = 0; i < LARGE_TOTAL; i++) {
      const r = i < LARGE_BASE ? rng : starRng;
      let ranSize = Math.round(largeStarSizeMin + Math.pow(r(), 2) * largeStarSizeMax);
      let ranX = Math.round(-100 + r() * width + 100);
      let ranY = Math.round(-100 + r() * height + 100);
      largeStars.push({ x: ranX, y: ranY, size: ranSize, image: "star-large" });
    }
    stars.push(...largeStars.slice(0, Math.max(1, Math.round(LARGE_TOTAL * countScale))));
    let mediumStarSizeMax = sizeScale / 130;
    let mediumStarSizeMin = sizeScale / 3e3;
    let mediumStars = [];
    for (let i = 0; i < MEDIUM_TOTAL; i++) {
      const r = i < MEDIUM_BASE ? rng : starRng;
      let ranSize = Math.round(mediumStarSizeMin + Math.pow(r(), 1.7) * mediumStarSizeMax);
      let ranX = Math.round(-100 + r() * width + 100);
      let ranY = Math.round(-100 + r() * height + 100);
      mediumStars.push({ x: ranX, y: ranY, size: ranSize, image: "star-small" });
    }
    stars.push(...mediumStars.slice(0, Math.max(1, Math.round(MEDIUM_TOTAL * countScale))));
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
    let smallStarSizeMax = sizeScale / FINE_SIZE_DIVISOR;
    let smallStarSizeMin = sizeScale / 5e3;
    const fieldOffset = starRng() * 1e3;
    for (let i = 0; i < smallStarAmount; i++) {
      let sizeRoll = rng();
      let ranX = -100 + rng() * width + 100;
      let ranY = -100 + rng() * height + 100;
      const field = fineFieldAt(ranX / width, ranY / height, fieldOffset);
      const t = field * (1 - FIELD_JITTER) + sizeRoll * FIELD_JITTER;
      let ranSize = smallStarSizeMin + Math.pow(t, FINE_SKEW) * smallStarSizeMax;
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
  // How large the CHAOTIC shapes tend to be -- the exact counterpart of `size` above, which
  // only ever governed the coherent lattice. 0.5 is today's behaviour exactly; higher values
  // make a design's shapes bigger on average AND make small ones rare, because this is a skew
  // on the size draw's distribution, not just a multiplier on its result.
  //
  // Added 2026-09-17 at Aaron's request ("the average geometry size fills the artwork and
  // smaller geometric shapes are much more rare"). The chaotic size draw was a flat
  // `rng() / 3` -- uniform, so the bottom of its range was exactly as likely as the top, and
  // a design that happened to draw low rendered as a small cluster marooned in the middle of
  // the canvas. That low tail is the whole complaint: measured over 400 seeds at the studio's
  // own 3840x2160, the per-design median shape spanned 1.81 short-edges at the 90th percentile
  // but only 0.43 at the 10th -- a 4x spread, entirely down to one uniform draw.
  //
  // It is deliberately a SEPARATE key from `size` rather than an extension of it, and that is
  // a correctness requirement, not tidiness: `size` is already stored on designs in the
  // gallery, so widening its meaning would re-render every one of those that carries a
  // non-default value at less than full coherence. A key that did not exist until now cannot
  // appear in any stored row, so every existing design resolves to the 0.5 default and is
  // byte-identical by construction -- which is the only way to make this change without
  // rewriting artwork customers have already saved (see check-render-regression.mjs).
  //
  // Consumes the SAME single rng() draw in the same position (the skew is arithmetic applied
  // to the value, not an extra draw), so no downstream layer shifts and no GENERATOR_VERSION
  // bump is needed -- same reasoning as `density` above. Verified by PNG hash across seeds
  // and sizes. Like `density` it is size-INDEPENDENT, so it cannot reintroduce the v7
  // mockup/print divergence.
  spread: 0.5,
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
  density: 1,
  // Whether the star field composites ABOVE the geometry layer instead of below it.
  // false (default) keeps the original order: background -> radial field -> stars ->
  // geometry -> overlay. true swaps the middle pair only; the overlay stays on top either
  // way.
  //
  // Added 2026-08-18 at Aaron's request. The default order looks right while the geometry
  // is small, but a large or high-coherence figure covers most of the canvas -- the lattice
  // at coherence 1 is a near-complete fill of overlapping cells, not a sparse scatter -- so
  // the stars underneath are lost entirely. That is worst when the layer's own blend
  // (config.thirdBlend, still a uniform pick from all eight modes) happens to be a
  // darkening one, which is exactly the failure starBlendMode was introduced to fix for the
  // star layer itself and has never been applied to the layer sitting on top of it.
  //
  // Purely a compositing order, consumed by renderArtwork -- it consumes ZERO rng() and
  // touches no layer generation, so every layer's geometry, colours and blend modes are
  // byte-identical either way and default false is byte-identical to pre-setting output.
  // Hence no GENERATOR_VERSION bump. Unlike mirrorX/legSymmetry (render context, per-order)
  // this IS part of a design's identity: it changes how the design itself reads, so it is
  // persisted and compared by isSameDesign.
  starsOnTop: false
  // A `frontOnly` field used to live here (whether the geometry layer was suppressed on
  // non-front merch placements) but was removed 2026-07 -- baking that choice into the
  // saved design meant it was permanent for every product the design was ever printed on.
  // It's now a per-order choice instead: ProductPage.jsx's placement checkboxes, threaded
  // through as `includeGeometry` render context (see generateArtwork's renderContext
  // param) rather than a design setting. Old saved designs may still carry a stray
  // `settings.geometry.frontOnly` key; it's simply never read anymore.
};
var LEGACY_GEOMETRY_CHANCE = 0.4;
var STUDIO_DEFAULT_GEOMETRY_CHANCE = 0.9;
var STUDIO_DEFAULT_GEOMETRY_SPREAD = 0.85;
var STUDIO_DEFAULT_GEOMETRY_SETTINGS = {
  ...DEFAULT_GEOMETRY_SETTINGS,
  chance: STUDIO_DEFAULT_GEOMETRY_CHANCE,
  spread: STUDIO_DEFAULT_GEOMETRY_SPREAD
};
function getGeometrySettings(settings) {
  const resolved = { ...DEFAULT_GEOMETRY_SETTINGS, chance: LEGACY_GEOMETRY_CHANCE };
  const stored = settings?.geometry;
  if (stored) {
    for (const key of Object.keys(resolved)) {
      if (stored[key] !== void 0) resolved[key] = stored[key];
    }
  }
  return resolved;
}
function getGeometryPresence(settings) {
  const stated = settings?.geometry?.present;
  if (typeof stated === "boolean") return stated;
  const chance = settings?.geometry?.chance;
  if (chance === 1) return true;
  if (chance === 0) return false;
  return null;
}
function compactSettings(settings) {
  const geometry = getGeometrySettings(settings);
  const { chance, ...dna } = geometry;
  const dnaIsDefault = Object.keys(DEFAULT_GEOMETRY_SETTINGS).every(
    (key) => dna[key] === DEFAULT_GEOMETRY_SETTINGS[key]
  );
  const present = getGeometryPresence(settings);
  if (present !== null) return { geometry: { ...dna, present } };
  if (chance === LEGACY_GEOMETRY_CHANCE) return dnaIsDefault ? void 0 : { geometry: dna };
  return { geometry: { ...dna, chance } };
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
    const spreadExponent = geometry.spread <= 0.5 ? 3 - 4 * geometry.spread : 1 - 1.4 * (geometry.spread - 0.5);
    const chaoticSizeDraw = Math.pow(rng(), spreadExponent);
    const chaoticSize = Math.round(chaoticSizeScale * CHAOTIC_MIN_FRACTION) + Math.round(chaoticSizeDraw * chaoticSizeScale / 3);
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
var GENERATOR_VERSION = 13;
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
var STAR_BLEND_ON_DARK = ["source-over", "source-over", "source-over", "lighten"];
var STAR_BLEND_ON_LIGHT = ["source-over", "source-over", "source-over", "darken"];
var STAR_BLEND_BIAS = 0.9;
function starBlendMode(rng, backgroundLuminance) {
  const roll = rng();
  if (roll >= STAR_BLEND_BIAS) {
    const t2 = (roll - STAR_BLEND_BIAS) / (1 - STAR_BLEND_BIAS);
    return BLEND_MODES[Math.min(BLEND_MODES.length - 1, Math.floor(t2 * BLEND_MODES.length))];
  }
  const set = backgroundLuminance > BRIGHT_BACKDROP ? STAR_BLEND_ON_LIGHT : STAR_BLEND_ON_DARK;
  const t = roll / STAR_BLEND_BIAS;
  return set[Math.min(set.length - 1, Math.floor(t * set.length))];
}
function generateArtwork(seed = randomSeed(), width, height, colorValues = [], settings = null, { includeGeometry = true, geometryLayout = null, mirrorX = false, sizeFrame = null, legSymmetry = false } = {}) {
  const rng = makeRng(seed);
  const paletteColors = colorValues.length === 1 ? expandMonochromePalette(colorValues[0], makeRng(`${seed}-palette`)) : colorValues;
  const geometry = getGeometrySettings(settings);
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
    // A design SETTING (see designSettings.js), not render context like the two above --
    // it is persisted and part of a design's identity. Sits on the config alongside them
    // because renderArtwork is the one place it takes effect: it swaps the star and
    // geometry layers' compositing order and nothing else. Consumes no rng().
    starsOnTop: geometry.starsOnTop,
    colors: colorValues.slice()
  };
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
  const backgroundLuminance = meanLuminance(config.gradientBackgroundConfig.colors);
  config.secondBlend = starBlendMode(rng, backgroundLuminance);
  const backgroundHue = paletteColors.length === 0 ? tinycolor3(config.gradientBackgroundConfig.colors[0]).toHsl().h : null;
  config.starFieldConfig = new GenerateStarField(
    width,
    height,
    paletteColors.slice(),
    rng,
    backgroundHue,
    sizeFrame,
    backgroundLuminance,
    seed
  );
  const geometryDraw = rng();
  const stated = getGeometryPresence(settings);
  const hasGeometry = stated === null ? geometryDraw >= 1 - geometry.chance : stated;
  if (hasGeometry) {
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
  config.geometryChance = geometry.chance;
  const compactedSettings = compactSettings({
    ...settings,
    geometry: { ...geometry, present: hasGeometry }
  });
  if (compactedSettings) config.settings = compactedSettings;
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

// ../src/render/starSprite.js
var STAR_SHAPE = {
  // Opaque centre.
  coreR: 0.17,
  // Inner halo: a flat semi-transparent disc with the "very small stroke" at its rim that
  // gives the original its lens-element look.
  haloR: 0.34,
  haloAlpha: 0.62,
  haloStrokeAlpha: 0.82,
  // The rim highlight's own thickness, and its own (small) feather. Kept SEPARATE from
  // featherR below: coupling them made the bright band as wide as the soft falloff and the
  // rim read as a fat ring rather than the fine line the original had.
  haloStrokeW: 6e-3,
  rimFeatherR: 6e-3,
  rimFeatherMinPx: 1,
  // How far the halo drops immediately past the rim, as a fraction of the disc's own alpha.
  // The original raster does the same thing -- disc 167, rim peak 203, then straight down to
  // 74 -- and it is what makes the rim read as a lit edge instead of a gradient shoulder.
  haloOuterFalloff: 0.55,
  // EDGE FEATHER (2026-08-20, Aaron: the new stars "feel a bit more pixelated than the old
  // ones"). They are not lower resolution -- they are drawn as paths at the exact output
  // size, so there is no raster to enlarge and "higher res" is not available as a fix. What
  // changed is edge HARDNESS: the raster was a 648px sheet being upscaled, i.e. blurred,
  // which hid its own antialiasing, while a filled arc lands a full-contrast edge inside a
  // single pixel. At 3x zoom both have identical 1px AA on the halo rim; only the new one
  // has the contrast to make the steps visible. It also matters that the studio renders at
  // 3840x2160 and displays far smaller -- a hard edge is high-frequency content that aliases
  // on the downscale, where a soft one resamples cleanly.
  // So the core rim and the halo rim are ramps rather than cuts. Expressed in fractions of
  // the star with a device-pixel floor, since a feather thinner than a pixel is not a
  // feather.
  featherR: 0.022,
  featherMinPx: 1.4,
  // Outer glow. Pulled hard back in v12 (Aaron: it "feels a bit too much"), then opened up
  // again in v13 once the arms were fading earlier -- a wider, slightly stronger glow gives
  // the star back its presence without the hard-edged brightness the arms were carrying.
  // Reaches past the halo but stops well short of the arm tips, so the arms read as streaks
  // leaving the glow rather than as spokes inside a fog.
  glowR: 0.9,
  glowAlpha: 0.3,
  // Diffraction spikes. `spikeAlpha` is the arm's opacity along its held stretch, raised
  // well above the raster's effective 0.49 ceiling -- it is the value that decides whether a
  // star reads as a cross or a ball.
  // Arms are 50% longer than the sprite box they came from and do not taper in WIDTH
  // (Aaron) -- a diffraction spike is a constant-width streak that fades out, not a wedge.
  // Only the opacity tapers (see spikeHold below). Note spikeR > 1 is fine and
  // deliberate: nothing here is bounded by a sprite frame any more, so `size` is the star's
  // core-and-halo diameter while the arms reach beyond it.
  spikeR: 1.335,
  spikeW: 0.03,
  spikeAlpha: 0.9,
  // Fraction of the arm that holds full opacity before the fade begins. Low, so an arm is
  // bright only close to the core and spends most of its length fading -- which is what a
  // diffraction spike actually does, and what stops four long bars reading as a plus sign.
  spikeHold: 0.2,
  // An arm narrower than this many device pixels is widened to it (and dimmed in
  // proportion, so it keeps the same total light rather than getting heavier as it
  // shrinks). Just over one pixel: enough that antialiasing always has something to
  // resolve, small enough that a big star's arm is still a hairline.
  spikeMinPx: 1.25
};
function drawStarSprite(ctx, cx, cy, size, shape = STAR_SHAPE) {
  const R = size / 2;
  if (!(R > 0)) return;
  const prevAlpha = ctx.globalAlpha;
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#fff";
  const glowR = R * shape.glowR;
  if (glowR > 0.5) {
    const g = ctx.createRadialGradient(cx, cy, R * shape.haloR * 0.6, cx, cy, glowR);
    g.addColorStop(0, `rgba(255,255,255,${shape.glowAlpha})`);
    g.addColorStop(0.2, `rgba(255,255,255,${shape.glowAlpha * 0.74})`);
    g.addColorStop(0.4, `rgba(255,255,255,${shape.glowAlpha * 0.5})`);
    g.addColorStop(0.6, `rgba(255,255,255,${shape.glowAlpha * 0.29})`);
    g.addColorStop(0.8, `rgba(255,255,255,${shape.glowAlpha * 0.12})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
  }
  const haloR = R * shape.haloR;
  const feather = Math.max(shape.featherMinPx, R * shape.featherR);
  if (haloR > 0.5) {
    const outer = haloR + feather;
    const sw = Math.max(shape.rimFeatherMinPx, R * shape.haloStrokeW);
    const rf = Math.max(shape.rimFeatherMinPx, R * shape.rimFeatherR);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, outer);
    let last = 0;
    const stop = (radius, alpha) => {
      const t = Math.min(1, Math.max(last, radius / outer));
      g.addColorStop(t, `rgba(255,255,255,${alpha})`);
      last = t;
    };
    stop(0, shape.haloAlpha);
    stop(haloR - sw / 2 - rf, shape.haloAlpha);
    stop(haloR - sw / 2, shape.haloStrokeAlpha);
    stop(haloR + sw / 2, shape.haloAlpha * shape.haloOuterFalloff);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, outer, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
  }
  const spikeR = R * shape.spikeR;
  let halfW = R * shape.spikeW / 2;
  let spikeAlpha = shape.spikeAlpha;
  const minHalf = shape.spikeMinPx / 2;
  if (halfW < minHalf) {
    spikeAlpha *= halfW / minHalf;
    halfW = minHalf;
  }
  if (spikeR > 1 && spikeAlpha > 4e-3) {
    const inner = R * shape.coreR * 0.5;
    for (let i = 0; i < 4; i++) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(i * Math.PI / 2);
      const g = ctx.createLinearGradient(inner, 0, spikeR, 0);
      g.addColorStop(0, `rgba(255,255,255,${spikeAlpha})`);
      g.addColorStop(shape.spikeHold, `rgba(255,255,255,${spikeAlpha})`);
      g.addColorStop(
        shape.spikeHold + (1 - shape.spikeHold) * 0.45,
        `rgba(255,255,255,${spikeAlpha * 0.62})`
      );
      g.addColorStop(
        shape.spikeHold + (1 - shape.spikeHold) * 0.78,
        `rgba(255,255,255,${spikeAlpha * 0.24})`
      );
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.globalAlpha = 1;
      ctx.fillStyle = g;
      ctx.fillRect(inner, -halfW, spikeR - inner, halfW * 2);
      ctx.restore();
    }
    ctx.fillStyle = "#fff";
  }
  const coreR = R * shape.coreR;
  if (coreR > 0.35) {
    ctx.globalAlpha = 1;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(Math.max(0, (coreR - feather) / coreR), "rgba(255,255,255,1)");
    g.addColorStop(1, `rgba(255,255,255,${shape.haloAlpha})`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
  } else {
    ctx.globalAlpha = Math.min(1, Math.max(0.5, coreR / 0.35));
    ctx.beginPath();
    ctx.arc(cx, cy, 0.35, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = prevAlpha;
}
var SMALL_STAR_SHAPE = {
  // Point tips, on the axes, as a fraction of the sprite's half-width.
  pointR: 0.68,
  // Control-point distance for the concave sides, as a fraction of pointR -- this is what
  // sets the waist. These four numbers were FITTED to the raster's own alpha profile by
  // search, not eyeballed, so the field keeps the character it already had.
  waistK: 0.12,
  // Blur radius as a fraction of the half-width, and the outer glow that sits under it.
  blurR: 0.11,
  glowR: 0.92,
  glowAlpha: 0.4
};
function buildSmallStarSprite(px, makeCanvas, shape = SMALL_STAR_SHAPE) {
  const size = Math.max(8, Math.round(px));
  const c = makeCanvas(size, size);
  const ctx = c.getContext("2d");
  const R = size / 2;
  const cx = R;
  const cy = R;
  const path = () => {
    const r = R * shape.pointR;
    const k = r * shape.waistK;
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.quadraticCurveTo(cx + k, cy - k, cx + r, cy);
    ctx.quadraticCurveTo(cx + k, cy + k, cx, cy + r);
    ctx.quadraticCurveTo(cx - k, cy + k, cx - r, cy);
    ctx.quadraticCurveTo(cx - k, cy - k, cx, cy - r);
    ctx.closePath();
  };
  const gr = R * shape.glowR;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, gr);
  g.addColorStop(0, `rgba(255,255,255,${shape.glowAlpha})`);
  g.addColorStop(0.35, `rgba(255,255,255,${shape.glowAlpha * 0.5})`);
  g.addColorStop(0.7, `rgba(255,255,255,${shape.glowAlpha * 0.16})`);
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, gr, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  const blur = R * shape.blurR;
  if (blur >= 0.5) {
    ctx.filter = `blur(${blur}px)`;
    path();
    ctx.fill();
    ctx.filter = "none";
  }
  path();
  ctx.fill();
  ctx.putImageData(ctx.getImageData(0, 0, size, size), 0, 0);
  return c;
}

// ../src/components/Canvas/StarField.js
var SMALL_SPRITE_PX = 256;
function StarField(config) {
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
  const smallSprite = buildSmallStarSprite(SMALL_SPRITE_PX, (w, h) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  });
  for (let i = 0; i < config.stars.length; i++) {
    const star = config.stars[i];
    if (star.image === "star-large") {
      drawStarSprite(starContext, star.x + star.size / 2, star.y + star.size / 2, star.size);
      continue;
    }
    starContext.drawImage(smallSprite, star.x, star.y, star.size, star.size);
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
    for (let i = 0; i < smallStars.length; i++) {
      starContext.drawImage(
        smallSprite,
        smallStars[i].x,
        smallStars[i].y,
        smallStars[i].size,
        smallStars[i].size
      );
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
function renderArtwork(config) {
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
  const drawStars = () => {
    ctx.globalCompositeOperation = config.secondBlend;
    const starField = StarField(config.starFieldConfig);
    ctx.drawImage(starField, 0, 0);
    clearElement(starField);
  };
  const drawGeometry = () => {
    if (!config.geometryConfig) return;
    ctx.globalCompositeOperation = config.thirdBlend;
    const geometry = GeometricShape(config.geometryConfig);
    ctx.drawImage(geometry, 0, 0);
    clearElement(geometry);
  };
  if (config.starsOnTop) {
    drawGeometry();
    drawStars();
  } else {
    drawStars();
    drawGeometry();
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

// ../src/render/hatWrap.js
var HAT_WRAP_SUPERSAMPLE = 2;
function resolve(geom, outW) {
  const s = (piece) => ({
    cx: piece.cx * outW,
    cy: piece.cy * outW,
    rIn: (piece.rIn ?? 0) * outW,
    rOut: (piece.rOut ?? piece.r) * outW,
    half: piece.half ?? 0
  });
  const disc = { cx: geom.disc.cx * outW, cy: geom.disc.cy * outW, r: geom.disc.r * outW };
  const crown = s(geom.crown);
  const brim = s(geom.brim);
  return { disc, crown, brim };
}
function hatWrapSourceSize(geom, outW) {
  const { crown, brim } = resolve(geom, outW);
  const seamArc = crown.rOut * 2 * crown.half;
  const total = crown.rOut - crown.rIn + (brim.rOut - brim.rIn);
  return {
    width: Math.round(seamArc * HAT_WRAP_SUPERSAMPLE),
    height: Math.round(total * HAT_WRAP_SUPERSAMPLE)
  };
}
function hatWrapDiscSourceSize(geom, outW) {
  const { disc } = resolve(geom, outW);
  const side = Math.round(2 * disc.r * HAT_WRAP_SUPERSAMPLE);
  return { width: side, height: side };
}
function readPixels(source, w, h) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(source, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}
function sample(data, w, h, u, v, out, p) {
  const sx = Math.min(w - 1, Math.max(0, u * w - 0.5));
  const sy = Math.min(h - 1, Math.max(0, v * h - 0.5));
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = sx - x0;
  const fy = sy - y0;
  const i00 = y0 * w + x0 << 2;
  const i10 = y0 * w + x1 << 2;
  const i01 = y1 * w + x0 << 2;
  const i11 = y1 * w + x1 << 2;
  for (let k = 0; k < 3; k++) {
    const a = data[i00 + k] * (1 - fx) + data[i10 + k] * fx;
    const b = data[i01 + k] * (1 - fx) + data[i11 + k] * fx;
    out[p + k] = a * (1 - fy) + b * fy;
  }
}
function drawHatWrap(ctx, unrolled, discSource, geom, outW, outH, { mirror = false } = {}) {
  const { disc, crown, brim } = resolve(geom, outW);
  const src = hatWrapSourceSize(geom, outW);
  const dsc = hatWrapDiscSourceSize(geom, outW);
  const uData = readPixels(unrolled, src.width, src.height);
  const dData = readPixels(discSource, dsc.width, dsc.height);
  const crownBand = crown.rOut - crown.rIn;
  const total = crownBand + (brim.rOut - brim.rIn);
  const out = ctx.createImageData(outW, outH);
  const data = out.data;
  for (let y = 0; y < outH; y++) {
    const gy = y + 0.5;
    for (let x = 0; x < outW; x++) {
      const gx = x + 0.5;
      const p = y * outW + x << 2;
      data[p + 3] = 255;
      const ddx = gx - disc.cx;
      const ddy = gy - disc.cy;
      if (ddx * ddx + ddy * ddy <= disc.r * disc.r) {
        sample(dData, dsc.width, dsc.height, 0.5 + ddx / (2 * disc.r), 0.5 + ddy / (2 * disc.r), data, p);
        continue;
      }
      let dx = gx - crown.cx;
      let dy = gy - crown.cy;
      const rc = Math.sqrt(dx * dx + dy * dy);
      const tc = Math.atan2(dx, dy);
      let u;
      let v;
      if (Math.abs(tc) <= crown.half * 1.02 && rc >= crown.rIn * 0.97 && rc <= crown.rOut * 1.03) {
        u = (tc + crown.half) / (2 * crown.half);
        v = (rc - crown.rIn) / total;
      } else {
        dx = gx - brim.cx;
        dy = gy - brim.cy;
        const rb = Math.sqrt(dx * dx + dy * dy);
        const tb = Math.atan2(dx, dy);
        u = (tb + brim.half) / (2 * brim.half);
        v = (crownBand + (rb - brim.rIn)) / total;
      }
      sample(uData, src.width, src.height, u, v, data, p);
    }
  }
  if (!mirror) {
    ctx.putImageData(out, 0, 0);
    return;
  }
  const scratch = document.createElement("canvas");
  scratch.width = outW;
  scratch.height = outH;
  scratch.getContext("2d").putImageData(out, 0, 0);
  ctx.save();
  ctx.translate(outW, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(scratch, 0, 0);
  ctx.restore();
}

// ../src/render/legWrap.js
function legWrapSourceSize(geom, outW, outH) {
  return { width: Math.max(1, Math.round(geom.width * outW)), height: outH };
}
function drawLegWrap(ctx, comp, geom, outW, outH, { mirror = false } = {}) {
  const compW = Math.max(1, Math.round(geom.width * outW));
  const x0 = Math.round((outW - compW) / 2);
  const half = outW / 2;
  const top = geom.shift * outW;
  const bottom = (typeof geom.shiftBottom === "number" ? geom.shiftBottom : geom.shift) * outW;
  const shift = bottom === top ? Math.round(top) : top;
  const slope = (bottom - top) / outH;
  ctx.save();
  if (mirror) {
    ctx.translate(outW, 0);
    ctx.scale(-1, 1);
  }
  for (const [clipX, sign] of [
    [0, -1],
    [half, 1]
  ]) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(clipX, 0, half, outH);
    ctx.clip();
    if (slope) ctx.transform(1, 0, sign * slope, 1, 0, 0);
    const left = x0 + sign * shift;
    const right = left + compW;
    if (left > 0 || right < outW) {
      ctx.imageSmoothingEnabled = false;
      if (left > 0) ctx.drawImage(comp, 0, 0, 1, comp.height, left - outW, 0, outW + 1, outH);
      if (right < outW) ctx.drawImage(comp, compW - 1, 0, 1, comp.height, right - 1, 0, outW, outH);
      ctx.imageSmoothingEnabled = true;
    }
    ctx.drawImage(comp, left, 0, compW, outH);
    ctx.restore();
  }
  ctx.restore();
}
export {
  GENERATOR_VERSION,
  drawHatWrap,
  drawLegWrap,
  generateArtwork,
  hatWrapDiscSourceSize,
  hatWrapSourceSize,
  legWrapSourceSize,
  renderArtwork
};
