// ../src/render/generateArtwork.js
import tinycolor4 from "tinycolor2";

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
var REFERENCE_ELEMENT_SIZE_SCALE = Math.min(REFERENCE_WIDTH, REFERENCE_HEIGHT);
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
    config.radGradients = radGradients;
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
    stars.push(...xlStars);
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
    stars.push(...largeStars);
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
    stars.push(...mediumStars);
    let smallStarChance = rng();
    let smallStarAmount;
    if (smallStarChance < 0.7) {
      smallStarAmount = 5e3;
    } else if (smallStarChance > 0.7 && smallStarChance < 0.9) {
      smallStarAmount = Math.round(50 + rng() * 200);
    } else {
      smallStarAmount = Math.round(5e3 + rng() * 1e5);
    }
    config.smallStarAmount = smallStarAmount;
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
  // make a design's shapes bigger on average AND make small ones rare, because the slider's
  // upper half both SKEWS the size draw's distribution and raises its ceiling.
  //
  // Added 2026-09-17 at Aaron's request ("the average geometry size fills the artwork and
  // smaller geometric shapes are much more rare", then "it can definitely go much larger"). The chaotic size draw was a flat
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
  starsOnTop: false,
  // Whether the nebula (render/nebula.js) takes the STAR FIELD's gradient, so gas and stars read
  // as one, instead of its own gradient plus colour pools. false (own colours) is the default:
  // Aaron, 2026-10-19 -- own colours + pools is what "really makes everything pop", but linking
  // them is a real look worth choosing, so it is the user's call rather than a per-seed roll.
  // Lives under geometry for the same pragmatic reason as starsOnTop (compactSettings and
  // isSameSettings iterate this block). Consumes no shared rng(); it is part of a design's
  // identity, persisted only when true. An absent key on every stored design reads as own
  // colours, which is intended -- v15 gave every design its nebula at once.
  nebulaLinked: false
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
var STUDIO_DEFAULT_GEOMETRY_SPREAD = 0.7;
var STUDIO_DEFAULT_GEOMETRY_STARS_ON_TOP = true;
var STUDIO_DEFAULT_GEOMETRY_SETTINGS = {
  ...DEFAULT_GEOMETRY_SETTINGS,
  chance: STUDIO_DEFAULT_GEOMETRY_CHANCE,
  spread: STUDIO_DEFAULT_GEOMETRY_SPREAD,
  starsOnTop: STUDIO_DEFAULT_GEOMETRY_STARS_ON_TOP
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
var SPREAD_MAX_GAIN = 3;
var GenerateGeometricShape = class {
  constructor(width, height, shapeNum, colors = [], rng = Math.random, settings = null, geometryLayout = null, sizeFrame = null, geometryScale = 1) {
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
    const spreadAbove = Math.max(0, geometry.spread - 0.5) / 0.5;
    const spreadExponent = geometry.spread <= 0.5 ? 3 - 4 * geometry.spread : 1 - 0.7 * spreadAbove;
    const spreadAmplitude = 1 + (SPREAD_MAX_GAIN - 1) * spreadAbove;
    const chaoticSizeDraw = Math.pow(rng(), spreadExponent);
    const chaoticSize = Math.round(chaoticSizeScale * CHAOTIC_MIN_FRACTION) + Math.round(chaoticSizeDraw * chaoticSizeScale * spreadAmplitude / 3);
    const sizeFactor = geometry.size <= 0.5 ? 0.15 + geometry.size * 0.45 : 0.375 + (geometry.size - 0.5) * 2.85;
    const coherentSize = getFrameSizeScale(width, height, sizeFrame) * sizeFactor / this.shapeDepth;
    this.shapeSize = (chaoticSize + (coherentSize - chaoticSize) * geometry.coherence) * geometryScale;
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

// ../src/render/nebula.js
import tinycolor3 from "tinycolor2";

// ../src/render/nebula2dCpu.js
var NOISE_OFFSETS = [[186.03127584467438, 114.9559537682114, 154.44750347045425], [199.8400018782914, 162.2925926843408, 154.048234399885], [111.63384265071569, 157.36939531224067, 199.0881114730351], [165.44527757573996, 162.76821379148592, 193.4084041028769], [155.58091529076475, 177.15463090621742, 138.140034568063]].map((o) => o.map((v) => Math.fround(v)));
var OFF = NOISE_OFFSETS;
var PERM = [215, 212, 216, 17, 5, 7, 140, 9, 114, 189, 52, 233, 248, 138, 89, 61, 53, 10, 206, 250, 184, 158, 30, 35, 115, 39, 113, 137, 217, 65, 177, 99, 134, 45, 95, 187, 75, 214, 73, 163, 145, 139, 49, 81, 50, 51, 234, 57, 37, 242, 157, 77, 29, 107, 67, 185, 47, 59, 23, 146, 71, 213, 21, 79, 160, 205, 199, 176, 63, 128, 94, 101, 244, 18, 168, 83, 190, 20, 117, 91, 181, 153, 90, 254, 240, 103, 102, 40, 62, 123, 26, 154, 133, 161, 151, 195, 200, 169, 46, 165, 129, 149, 130, 231, 156, 245, 119, 125, 66, 208, 201, 207, 252, 44, 121, 88, 87, 183, 12, 143, 127, 74, 15, 135, 86, 118, 33, 131, 6, 136, 236, 171, 227, 110, 19, 241, 228, 194, 166, 24, 58, 179, 182, 226, 2, 106, 170, 76, 41, 142, 11, 198, 172, 28, 159, 4, 232, 253, 55, 186, 69, 70, 238, 193, 108, 196, 111, 197, 27, 202, 93, 64, 230, 98, 235, 191, 152, 219, 105, 144, 175, 188, 8, 104, 1, 116, 255, 84, 124, 210, 97, 251, 204, 92, 211, 120, 68, 32, 167, 56, 34, 203, 38, 224, 246, 229, 150, 223, 147, 243, 122, 60, 100, 164, 85, 247, 13, 178, 25, 237, 31, 16, 109, 239, 225, 148, 112, 220, 173, 14, 78, 249, 221, 162, 218, 48, 222, 72, 43, 96, 54, 174, 36, 132, 126, 42, 22, 192, 3, 80, 209, 0, 141, 82, 155, 180];
var P = new Uint8Array(512);
for (let i = 0; i < 512; i++) P[i] = PERM[i & 255];
function grad(h, x, y, z) {
  h &= 15;
  const u = h < 8 ? x : y, v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return (h & 1 ? -u : u) + (h & 2 ? -v : v);
}
function perlin(x, y, z) {
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
  const fx = x - X, fy = y - Y, fz = z - Z;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fy * fy * fy * (fy * (fy * 6 - 15) + 10), w = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const xi = X & 255, yi = Y & 255, zi = Z & 255;
  const A = P[xi] + yi, AA = P[A] + zi, AB = P[A + 1] + zi, B = P[xi + 1] + yi, BA = P[B] + zi, BB = P[B + 1] + zi;
  const n000 = grad(P[AA], fx, fy, fz), n100 = grad(P[BA], fx - 1, fy, fz);
  const n010 = grad(P[AB], fx, fy - 1, fz), n110 = grad(P[BB], fx - 1, fy - 1, fz);
  const n001 = grad(P[AA + 1], fx, fy, fz - 1), n101 = grad(P[BA + 1], fx - 1, fy, fz - 1);
  const n011 = grad(P[AB + 1], fx, fy - 1, fz - 1), n111 = grad(P[BB + 1], fx - 1, fy - 1, fz - 1);
  const a0 = n000 + (n100 - n000) * u, a1 = n010 + (n110 - n010) * u, a2 = n001 + (n101 - n001) * u, a3 = n011 + (n111 - n011) * u;
  const b0 = a0 + (a1 - a0) * v, b1 = a2 + (a3 - a2) * v;
  return 0.982 * (b0 + (b1 - b0) * w);
}
function fbm(x, y, z, oct) {
  let fs = 1, amp = 1, maxamp = 0, sum = 0;
  for (let i = 0; i < oct; i++) {
    sum += perlin(fs * x, fs * y, fs * z) * amp;
    maxamp += amp;
    amp *= 0.5;
    fs *= 2;
  }
  return 0.5 * sum / maxamp + 0.5;
}
var WX = 0;
var WY = 0;
var WZ = 0;
function warp(x, y, z, scale, distortion) {
  WX = x * scale;
  WY = y * scale;
  WZ = z * scale;
  if (distortion !== 0) {
    const dx = perlin(WX + OFF[0][0], WY + OFF[0][1], WZ + OFF[0][2]) * distortion;
    const dy = perlin(WX + OFF[1][0], WY + OFF[1][1], WZ + OFF[1][2]) * distortion;
    const dz = perlin(WX + OFF[2][0], WY + OFF[2][1], WZ + OFF[2][2]) * distortion;
    WX += dx;
    WY += dy;
    WZ += dz;
  }
}
function cloud(x, y, z, scale, distortion, ovScale, ovDist, oct, warpOct) {
  warp(x, y, z, ovScale, ovDist * 0.5);
  const m = distortion + fbm(WX, WY, WZ, warpOct);
  warp(x, y, z, scale, m * 0.5);
  const c0 = fbm(WX, WY, WZ, warpOct), c1 = fbm(WX + OFF[3][0], WY + OFF[3][1], WZ + OFF[3][2], warpOct), c2 = fbm(WX + OFF[4][0], WY + OFF[4][1], WZ + OFF[4][2], warpOct);
  warp(x + c0 - 0.5, y + c1 - 0.5, z + c2 - 0.5, scale, m * 0.5);
  return fbm(WX, WY, WZ, oct);
}
var clamp01 = (t) => t < 0 ? 0 : t > 1 ? 1 : t;
var band = (t, p0, p1, p2) => t <= p0 || t >= p2 ? 0 : t < p1 ? (t - p0) / (p1 - p0) : 1 - (t - p1) / (p2 - p1);
var gray = (r, g, b) => 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
var dodge1 = (x, b, t) => {
  if (x === 0) return 0;
  const d = 1 - t * b;
  return d <= 0 ? 1 : Math.min(1, x / d);
};
var CX = [0, 0.352, 0.573, 1];
var CY = [0, 0.157, 0.814, 1];
var CM = [0.4460227273, 1.4205933682, 1.3009259259, 0.4355971897];
function curveS(x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const i = x < CX[1] ? 0 : x < CX[2] ? 1 : 2;
  const h = CX[i + 1] - CX[i], t = (x - CX[i]) / h, t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * CY[i] + (t3 - 2 * t2 + t) * h * CM[i] + (-2 * t3 + 3 * t2) * CY[i + 1] + (t3 - t2) * h * CM[i + 1];
}
var srgb = (c) => {
  c = clamp01(c);
  return c <= 31308e-7 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
};
var UNITS_PER_SHORT_EDGE = 0.81;
function nebula2dRows(loc, w, h, oct, y0, y1, out, { warpOct = Math.min(oct, 6), fineOct = Math.min(oct, 6) } = {}) {
  const k = UNITS_PER_SHORT_EDGE / Math.min(w, h);
  for (let py = y0; py < y1; py++) {
    const dz = (h * 0.5 - py - 0.5) * k;
    for (let px = 0; px < w; px++) {
      const dx = (px + 0.5 - w * 0.5) * k, dy = 1;
      const bx = loc[0] + dx, by = loc[1] + dy, bz = loc[2] + dz;
      let t = clamp01((cloud(bx, by, bz, 1.64, 0.18, 0.76, -2.88, oct, warpOct) - 0.535) / (0.704 - 0.535));
      const c1r = 0.019 * t, c1g = 0.047 * t, c1b = 0.107 * t;
      t = clamp01((cloud(bx, by, bz, 0.82, 0.33, 3.18, 0.36, oct, warpOct) - 0.49) / (0.533 - 0.49));
      const c2r = 0.103 * t, c2g = 0.19 * t, c2b = 0.265 * t;
      t = clamp01((cloud(bx, by, bz - 0.08, 1.09, 0, 1.9, 11, oct, warpOct) - 0.474) / (0.689 - 0.474));
      const c3r = 0.161 * t, c3g = 0.011 * t, c3b = 0;
      let nr = 1 - (1 - c2r) * (1 - c1r), ng = 1 - (1 - c2g) * (1 - c1g), nb = 1 - (1 - c2b) * (1 - c1b);
      nr = 1 - (1 - c3r) * (1 - nr);
      ng = 1 - (1 - c3g) * (1 - ng);
      nb = 1 - (1 - c3b) * (1 - nb);
      warp(dx, dy, dz - 0.3, 1.96, 0);
      const amb = clamp01((fbm(WX, WY, WZ, 1) - 0.125) / (0.792 - 0.125));
      const f7 = band(gray(nr, ng, nb), 5e-3, 0.167, 0.257);
      const m7r = dodge1(nr, amb, f7), m7g = dodge1(ng, amb, f7), m7b = dodge1(nb, amb, f7);
      warp(dx, dy, dz, 5, 0);
      const g0 = fbm(WX, WY, WZ, fineOct), g1 = fbm(WX + OFF[3][0], WY + OFF[3][1], WZ + OFF[3][2], fineOct), g2 = fbm(WX + OFF[4][0], WY + OFF[4][1], WZ + OFF[4][2], fineOct);
      const ft = clamp01((gray(g0, g1, g2) - 0.148) / (0.816 - 0.148));
      const f5 = band(gray(m7r, m7g, m7b), 2e-3, 0.264, 0.68);
      const m5r = dodge1(m7r, 0.692 * ft, f5), m5g = dodge1(m7g, 0.173 * ft, f5), m5b = dodge1(m7b, 7e-3 * ft, f5);
      out[(py - y0) * w + px] = srgb(gray(curveS(m5r), curveS(m5g), curveS(m5b)));
    }
  }
  return out;
}

// ../src/render/nebulaGpu.js
var f3 = (v) => `vec3(${v.map((x) => x.toFixed(10)).join(",")})`;
var VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;
var NOISE_GLSL = `const int PERM[256] = int[256](${PERM.join(",")});
int pm(int i) { return PERM[i & 255]; }
float fade(float t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
float grad3(uint h, float x, float y, float z) {
  h &= 15u;
  float u = h < 8u ? x : y;
  float vt = (h == 12u || h == 14u) ? x : z;
  float v = h < 4u ? y : vt;
  return ((h & 1u) != 0u ? -u : u) + ((h & 2u) != 0u ? -v : v);
}
float perlin(vec3 p) {
  vec3 fl = floor(p); ivec3 I = ivec3(fl); vec3 f = p - fl;
  float u = fade(f.x), v = fade(f.y), w = fade(f.z);
  int xi = I.x & 255, yi = I.y & 255, zi = I.z & 255;
  int A = pm(xi) + yi, AA = pm(A) + zi, AB = pm(A + 1) + zi, B = pm(xi + 1) + yi, BA = pm(B) + zi, BB = pm(B + 1) + zi;
  float n000 = grad3(uint(pm(AA)), f.x, f.y, f.z), n100 = grad3(uint(pm(BA)), f.x - 1.0, f.y, f.z);
  float n010 = grad3(uint(pm(AB)), f.x, f.y - 1.0, f.z), n110 = grad3(uint(pm(BB)), f.x - 1.0, f.y - 1.0, f.z);
  float n001 = grad3(uint(pm(AA + 1)), f.x, f.y, f.z - 1.0), n101 = grad3(uint(pm(BA + 1)), f.x - 1.0, f.y, f.z - 1.0);
  float n011 = grad3(uint(pm(AB + 1)), f.x, f.y - 1.0, f.z - 1.0), n111 = grad3(uint(pm(BB + 1)), f.x - 1.0, f.y - 1.0, f.z - 1.0);
  return mix(mix(mix(n000, n100, u), mix(n010, n110, u), v), mix(mix(n001, n101, u), mix(n011, n111, u), v), w);
}
float snoise(vec3 p) { return 0.982 * perlin(p); }
float fbm(vec3 p, int oct) {
  float fs = 1.0, amp = 1.0, maxamp = 0.0, sum = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= oct) break;
    sum += snoise(fs * p) * amp; maxamp += amp; amp *= 0.5; fs *= 2.0;
  }
  return 0.5 * sum / maxamp + 0.5;
}
const vec3 WARP_OFF[3] = vec3[3](${NOISE_OFFSETS.slice(0, 3).map(f3).join(", ")});
// The colour channels' offsets; channel 0 has none (adding zero changes nothing)
const vec3 CHAN_OFF[3] = vec3[3](vec3(0.0), ${f3(NOISE_OFFSETS[3])}, ${f3(NOISE_OFFSETS[4])});
vec3 lane(int i) { return vec3(i == 0, i == 1, i == 2); }
vec3 warped(vec3 v, float scale, float distortion) {
  vec3 p = v * scale;
  if (distortion != 0.0) {
    vec3 n = vec3(0.0);
    for (int i = 0; i < 3 + uZero; i++) n += snoise(p + WARP_OFF[i]) * lane(i);
    p += n * distortion;
  }
  return p;
}
`;
var RECIPE_GLSL = `#define WOCT min(uOct, 6)
// Five fbm steps through one fbm call and one warp: 0 the overlay that sets the warp amount m,
// 1-3 the three channels of the vector offset c (step 1 also warps p), 4 the cloud itself.
float cloud(vec3 v, float scale, float distortion, float ovScale, float ovDist) {
  float m = 0.0, r = 0.0;
  vec3 p = vec3(0.0), c = vec3(0.0), w = vec3(0.0);
  for (int s = 0; s < 5 + uZero; s++) {
    if (s < 2 || s == 4) w = warped(s == 4 ? v + (c - 0.5) : v, s == 0 ? ovScale : scale, s == 0 ? ovDist * 0.5 : m * 0.5);
    if (s == 1) p = w;
    float f = fbm(s == 0 || s == 4 ? w : p + CHAN_OFF[clamp(s - 1, 0, 2)], s == 4 ? uOct : WOCT);
    if (s == 0) m = distortion + f;
    else if (s == 4) r = f;
    else c += f * lane(s - 1);
  }
  return r;
}
// The three clouds, in the order they are screened together
const vec3 CLOUD_SHIFT[3] = vec3[3](vec3(0.0), vec3(0.0), vec3(0.0, 0.0, -0.08));
const float CLOUD_SCALE[3] = float[3](1.64, 0.82, 1.09), CLOUD_DIST[3] = float[3](0.18, 0.33, 0.0);
const float CLOUD_OV_SCALE[3] = float[3](0.76, 3.18, 1.9), CLOUD_OV_DIST[3] = float[3](-2.88, 0.36, 11.0);
const float CLOUD_LO[3] = float[3](0.535, 0.49, 0.474), CLOUD_SPAN[3] = float[3](0.704 - 0.535, 0.533 - 0.49, 0.689 - 0.474);
const vec3 CLOUD_TINT[3] = vec3[3](vec3(0.019, 0.047, 0.107), vec3(0.103, 0.19, 0.265), vec3(0.161, 0.011, 0.0));
float band(float t, float p0, float p1, float p2) {
  if (t <= p0 || t >= p2) return 0.0;
  return t < p1 ? (t - p0) / (p1 - p0) : 1.0 - (t - p1) / (p2 - p1);
}
float gray(vec3 c) { return dot(c, vec3(0.2126729, 0.7151522, 0.072175)); }
vec3 screen(vec3 a, vec3 b) { return 1.0 - (1.0 - b) * (1.0 - a); }
vec3 dodge(vec3 a, vec3 b, float t) {
  vec3 r;
  for (int i = 0; i < 3; i++) {
    float x = a[i];
    if (x == 0.0) { r[i] = 0.0; continue; }
    float d = 1.0 - t * b[i];
    r[i] = d <= 0.0 ? 1.0 : min(1.0, x / d);
  }
  return r;
}
float curveS(float x) {
  const float X[4] = float[4](0.0, 0.352, 0.573, 1.0), Y[4] = float[4](0.0, 0.157, 0.814, 1.0);
  const float M[4] = float[4](0.4460227273, 1.4205933682, 1.3009259259, 0.4355971897);
  if (x <= 0.0) return 0.0; if (x >= 1.0) return 1.0;
  int i = x < X[1] ? 0 : (x < X[2] ? 1 : 2);
  float h = X[i + 1] - X[i], t = (x - X[i]) / h, t2 = t * t, t3 = t2 * t;
  return (2.0 * t3 - 3.0 * t2 + 1.0) * Y[i] + (t3 - 2.0 * t2 + t) * h * M[i] + (-2.0 * t3 + 3.0 * t2) * Y[i + 1] + (t3 - t2) * h * M[i + 1];
}
float srgb(float c) { c = clamp(c, 0.0, 1.0); return c <= 0.0031308 ? 12.92 * c : 1.055 * pow(c, 1.0 / 2.4) - 0.055; }
float nebulaLum(vec3 dir) {
  vec3 base = uLoc + dir;
  vec3 neb = vec3(0.0);
  for (int k = 0; k < 3 + uZero; k++) {
    float t = clamp((cloud(base + CLOUD_SHIFT[k], CLOUD_SCALE[k], CLOUD_DIST[k], CLOUD_OV_SCALE[k], CLOUD_OV_DIST[k]) - CLOUD_LO[k]) / CLOUD_SPAN[k], 0.0, 1.0);
    neb = screen(neb, CLOUD_TINT[k] * t);
  }
  float ambT = clamp((fbm(warped(dir + uViewOff + vec3(0.0, 0.0, -0.3), 1.96, 0.0), 1) - 0.125) / (0.792 - 0.125), 0.0, 1.0);
  vec3 m7 = dodge(neb, vec3(ambT), band(gray(neb), 0.005, 0.167, 0.257));
  vec3 g = (dir + uViewOff) * 5.0;
  vec3 nc = vec3(0.0);
  for (int i = 0; i < 3 + uZero; i++) nc += fbm(g + CHAN_OFF[i], WOCT) * lane(i);
  vec3 fine = vec3(0.692, 0.173, 0.007) * clamp((gray(nc) - 0.148) / (0.816 - 0.148), 0.0, 1.0);
  vec3 m5 = dodge(m7, fine, band(gray(m7), 0.002, 0.264, 0.68));
  return srgb(gray(vec3(curveS(m5.r), curveS(m5.g), curveS(m5.b))));
}
`;
var NEBULA_UNIFORMS_GLSL = `uniform vec3 uLoc; uniform int uOct;
// Offsets the two terms the recipe anchors to the VIEW (the slow rim glow and the fine grain). Zero
// for the 2D layer, where the nebula is one picture and adding zero changes nothing. The 3D flight's
// volume passes each slice's depth, or those terms are identical in every slice and stack into a
// solid tube along the whole flight.
uniform vec3 uViewOff;
// Never set, so always 0: the recipe's loops count to N + uZero (see the note above NOISE_GLSL).
uniform int uZero;
`;
var NEBULA_LIB_GLSL = NOISE_GLSL + RECIPE_GLSL;
var FS = `#version 300 es
precision highp float; precision highp int;
uniform vec2 uRes; uniform float uK;
${NEBULA_UNIFORMS_GLSL}out vec4 o;
${NEBULA_LIB_GLSL}void main() {
  // gl_FragCoord's y runs up; the CPU's dz = (h/2 - py - 0.5) * k for row py from the top is the
  // same value here, since this pixel's row from the top is h - 1 - floor(gl_FragCoord.y).
  vec2 px = gl_FragCoord.xy;
  vec3 dir = vec3((px.x - uRes.x * 0.5) * uK, 1.0, (px.y - uRes.y * 0.5) * uK);
  // Packed into two 8-bit channels (16 bits), so this needs no float render target: those are an
  // extension (EXT_color_buffer_float) a phone may lack, which silently sent it to the CPU path.
  float q = floor(clamp(nebulaLum(dir), 0.0, 1.0) * 65535.0 + 0.5);
  o = vec4(floor(q / 256.0) / 255.0, mod(q, 256.0) / 255.0, 0.0, 1.0);
}`;
var STATE = null;
function context() {
  if (STATE === false) return null;
  if (STATE && !STATE.g.isContextLost()) return STATE;
  STATE = false;
  const inWorker = typeof document === "undefined";
  if (inWorker ? typeof OffscreenCanvas === "undefined" : typeof WebGL2RenderingContext === "undefined") return null;
  try {
    let canvas;
    if (inWorker) canvas = new OffscreenCanvas(1, 1);
    else {
      canvas = document.createElement("canvas");
      canvas.dataset.nebula = "1";
    }
    const g = (
      /** @type {WebGL2RenderingContext} */
      canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: false })
    );
    if (!g) return null;
    const compile = (type, src) => {
      const s = g.createShader(type);
      g.shaderSource(s, src);
      g.compileShader(s);
      if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(s));
      return s;
    };
    const prog = g.createProgram();
    g.attachShader(prog, compile(g.VERTEX_SHADER, VS));
    g.attachShader(prog, compile(g.FRAGMENT_SHADER, FS));
    g.bindAttribLocation(prog, 0, "aPos");
    g.linkProgram(prog);
    if (!g.getProgramParameter(prog, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(prog));
    const buf = g.createBuffer();
    g.bindBuffer(g.ARRAY_BUFFER, buf);
    g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), g.STATIC_DRAW);
    g.enableVertexAttribArray(0);
    g.vertexAttribPointer(0, 2, g.FLOAT, false, 0, 0);
    STATE = { g, prog, fb: g.createFramebuffer() };
    return STATE;
  } catch (err) {
    console.warn("[nebula] GPU unavailable, using the CPU:", err);
    return null;
  }
}
function nebulaFieldGpu(loc, w, h, oct, units = UNITS_PER_SHORT_EDGE, viewOff = [0, 0, 0]) {
  const s = begin(loc, w, h, oct, units, viewOff);
  if (!s) return null;
  s.g.drawArrays(s.g.TRIANGLE_STRIP, 0, 4);
  return finish(s, w, h);
}
function begin(loc, w, h, oct, units, viewOff) {
  const s = context();
  if (!s) return null;
  const { g, prog, fb } = s;
  const tex = g.createTexture();
  g.bindTexture(g.TEXTURE_2D, tex);
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, w, h, 0, g.RGBA, g.UNSIGNED_BYTE, null);
  g.bindFramebuffer(g.FRAMEBUFFER, fb);
  g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, tex, 0);
  g.viewport(0, 0, w, h);
  g.useProgram(prog);
  g.uniform3fv(g.getUniformLocation(prog, "uLoc"), loc);
  g.uniform2f(g.getUniformLocation(prog, "uRes"), w, h);
  g.uniform1f(g.getUniformLocation(prog, "uK"), units / Math.min(w, h));
  g.uniform1i(g.getUniformLocation(prog, "uOct"), oct);
  g.uniform3fv(g.getUniformLocation(prog, "uViewOff"), viewOff);
  return { ...s, tex };
}
function finish(s, w, h) {
  const { g, tex } = s;
  const px = new Uint8Array(w * h * 4);
  g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px);
  g.deleteTexture(tex);
  g.bindFramebuffer(g.FRAMEBUFFER, null);
  if (g.isContextLost()) return null;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4, dst = y * w;
    for (let x = 0; x < w; x++) out[dst + x] = (px[src + x * 4] * 256 + px[src + x * 4 + 1]) / 65535;
  }
  return out;
}

// ../src/components/Canvas/LinearGradient.js
function LinearGradient(config) {
  let canvas = document.createElement("canvas");
  let context2 = canvas.getContext("2d");
  canvas.width = config.width;
  canvas.height = config.height;
  let gradient = context2.createLinearGradient(
    config.gradientDirection.x1,
    config.gradientDirection.y1,
    config.gradientDirection.x2,
    config.gradientDirection.y2
  );
  for (let i = 0; i < config.colors.length; i++) {
    let color = config.colors[i];
    gradient.addColorStop(i / config.colors.length, color);
  }
  context2.fillStyle = gradient;
  context2.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}

// ../src/render/nebula.js
var NEBULA_PIXELS = 960 * 540;
var NEBULA_PIXELS_LITE = NEBULA_PIXELS / 4;
var NEBULA_OCTAVES = 9;
var AMOUNT_TIERS = [
  { name: "none", share: 0.15 },
  // Floors raised 2026-10-19 (faint was 0.20-0.40, medium 0.45-0.75): on geometry-heavy designs
  // those vanished completely, and a nebula nobody can see is the 'none' tier in disguise.
  { name: "faint", share: 0.2, cover: [0.1, 0.2], strength: [0.35, 0.55] },
  { name: "medium", share: 0.4, cover: [0.2, 0.35], strength: [0.6, 0.85] },
  { name: "full", share: 0.25, cover: [0.35, 0.55], strength: [0.8, 1] }
];
function nebulaAmount(seed) {
  const rng = makeRng(`${seed}-nebula-amount`);
  const u = rng(), v = rng(), w = rng();
  let acc = 0;
  for (const t of AMOUNT_TIERS) {
    acc += t.share;
    if (u < acc || t === AMOUNT_TIERS[AMOUNT_TIERS.length - 1]) {
      if (!t.cover) return { tier: t.name, cover: 0, strength: 0 };
      return { tier: t.name, cover: t.cover[0] + v * (t.cover[1] - t.cover[0]), strength: t.strength[0] + w * (t.strength[1] - t.strength[0]) };
    }
  }
}
var POOL_STRENGTH = 0.6;
var POOL_DOWNSAMPLE = 4;
function nebulaColour(config, linked) {
  const rng = makeRng(`${config.seed}-nebula-colour`);
  rng();
  const angle = rng() * Math.PI * 2, count = 2 + Math.floor(rng() * 4);
  if (linked) return { mode: "stars", gradient: null };
  const palRng = makeRng(`${config.seed}-nebula-palette`);
  const user = (config.colors || []).filter(Boolean);
  let colors;
  if (user.length >= 2) {
    const off = Math.floor(palRng() * user.length);
    colors = user.map((_, i) => user[(i + off) % user.length]);
  } else {
    const bg = config.gradientBackgroundConfig.colors.map((c) => tinycolor3(c).toHsl());
    let sx = 0, sy = 0;
    for (const c of bg) {
      sx += Math.cos(c.h * Math.PI / 180) * c.s;
      sy += Math.sin(c.h * Math.PI / 180) * c.s;
    }
    const bgHue = Math.atan2(sy, sx) * 180 / Math.PI;
    const base = (bgHue + 180 + (palRng() - 0.5) * 100 + 360) % 360;
    colors = randomPalette(palRng, count, { minSpread: 120, maxSpread: 220, baseHue: base, centered: true });
  }
  const W = config.width, H = config.height, r = Math.hypot(W, H) / 2;
  const dx = Math.cos(angle) * r, dy = Math.sin(angle) * r;
  return {
    mode: "own",
    gradient: { width: W, height: H, colors: [...colors, colors[colors.length - 1]], gradientDirection: { x1: W / 2 - dx, y1: H / 2 - dy, x2: W / 2 + dx, y2: H / 2 + dy } }
  };
}
function generateNebula(config, { linked = false } = {}) {
  const amount = nebulaAmount(config.seed);
  if (amount.strength === 0) return { ...amount, colour: null };
  return { ...amount, colour: nebulaColour(config, linked) };
}
function fieldCpu(loc, w, h, oct) {
  return nebula2dRows(loc, w, h, oct, 0, h, new Float32Array(w * h));
}
var PLACEMENTS = /* @__PURE__ */ new Map();
function placement(seed, target) {
  const key = `${seed}:${target}`;
  if (PLACEMENTS.has(key)) return PLACEMENTS.get(key);
  let best = null;
  for (let i = 0; i < 16; i++) {
    const rng = makeRng(`${seed}-nebula-${i}`);
    const loc = [rng() * 400 - 200, rng() * 400 - 200, rng() * 400 - 200];
    const m = fieldCpu(loc, 64, 36, 6);
    let lit = 0;
    for (const v of m) if (v > 0.3) lit++;
    const score = Math.abs(lit / m.length - target);
    if (!best || score < best.score) best = { loc, score };
    if (score < 0.06) break;
  }
  if (PLACEMENTS.size > 64) PLACEMENTS.delete(PLACEMENTS.keys().next().value);
  PLACEMENTS.set(key, best.loc);
  return best.loc;
}
var ALPHAQ = [
  0,
  0.031,
  0.043,
  0.055,
  0.063,
  0.075,
  0.082,
  0.094,
  0.11,
  0.125,
  0.149,
  0.173,
  0.2,
  0.227,
  0.255,
  0.282,
  0.306,
  0.333,
  0.357,
  0.384,
  0.412,
  0.439,
  0.467,
  0.498,
  0.522,
  0.549,
  0.584,
  0.62,
  0.655,
  0.698,
  0.737,
  0.792,
  1
];
function hisCurveKnots(L) {
  const step = Math.max(1, Math.floor(L.length / 2e4)), sample2 = [];
  for (let k = 0; k < L.length; k += step) sample2.push(L[k]);
  sample2.sort((a, b) => a - b);
  const q = (r) => sample2[Math.min(sample2.length - 1, Math.floor(r * (sample2.length - 1)))];
  return Array.from({ length: 33 }, (_, i) => q(i / 32));
}
function toHisCurve(L) {
  return applyHisCurve(L, hisCurveKnots(L));
}
function applyHisCurve(L, knots) {
  const out = new Float32Array(L.length);
  for (let k = 0; k < L.length; k++) {
    const v = L[k];
    let lo = 0, hi = 32;
    while (hi - lo > 1) {
      const m = lo + hi >> 1;
      if (knots[m] <= v) lo = m;
      else hi = m;
    }
    const span = knots[hi] - knots[lo], f = span > 0 ? Math.min(1, Math.max(0, (v - knots[lo]) / span)) : 0;
    out[k] = ALPHAQ[lo] + (ALPHAQ[hi] - ALPHAQ[lo]) * f;
  }
  return out;
}
function blurField(a, w, h, r) {
  const tmp = new Float32Array(a.length), out = Float32Array.from(a);
  for (let it = 0; it < 3; it++) {
    for (let y = 0; y < h; y++) {
      let acc = 0, n = 0;
      for (let x = -r; x < w; x++) {
        if (x + r < w) {
          acc += out[y * w + x + r];
          n++;
        }
        if (x - r - 1 >= 0) {
          acc -= out[y * w + x - r - 1];
          n--;
        }
        if (x >= 0) tmp[y * w + x] = acc / n;
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0, n = 0;
      for (let y = -r; y < h; y++) {
        if (y + r < h) {
          acc += tmp[(y + r) * w + x];
          n++;
        }
        if (y - r - 1 >= 0) {
          acc -= tmp[(y - r - 1) * w + x];
          n--;
        }
        if (y >= 0) out[y * w + x] = acc / n;
      }
    }
  }
  return out;
}
function nebulaRenderSize(width, height, pixels = NEBULA_PIXELS) {
  const aspect = width / height;
  const w = Math.max(16, Math.round(Math.sqrt((pixels || NEBULA_PIXELS) * aspect)));
  const h = Math.max(16, Math.round(w / aspect));
  return { w, h };
}
function nebulaMask(config, { gpu = true, info = null } = {}) {
  const plan = config.nebulaConfig;
  const { w, h } = nebulaRenderSize(config.width, config.height, config.nebulaConfig?.pixels);
  const loc = placement(config.seed, plan.cover);
  let field = gpu ? nebulaFieldGpu(loc, w, h, NEBULA_OCTAVES) : null;
  if (info) info.gpu = !!field;
  if (!field) field = fieldCpu(loc, w, h, NEBULA_OCTAVES);
  return maskFromField(field, w, h, plan);
}
async function nebulaMaskWith(config, fieldFn) {
  const plan = config.nebulaConfig;
  const { w, h } = nebulaRenderSize(config.width, config.height, config.nebulaConfig?.pixels);
  const loc = placement(config.seed, plan.cover);
  const field = await fieldFn(loc, w, h, NEBULA_OCTAVES) || fieldCpu(loc, w, h, NEBULA_OCTAVES);
  return maskFromField(field, w, h, plan);
}
async function prepareNebulaWithField(config, fieldFn) {
  const plan = config?.nebulaConfig;
  if (!plan || !plan.strength) return;
  const key = maskKey(config);
  if (MASKS.has(key)) return;
  const { rgba, w, h } = maskToRGBA(await nebulaMaskWith(config, fieldFn));
  if (!MASKS.has(key)) storeMask(key, rgba, w, h);
}
function maskFromField(field, w, h, plan) {
  const a = toHisCurve(field);
  if (plan.colour.mode === "own") {
    const D = POOL_DOWNSAMPLE, sw = Math.ceil(w / D), sh = Math.ceil(h / D);
    const small = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++)
      for (let x = 0; x < sw; x++) {
        let sum = 0, n = 0;
        for (let yy = y * D; yy < Math.min(h, y * D + D); yy++)
          for (let xx = x * D; xx < Math.min(w, x * D + D); xx++) {
            sum += a[yy * w + xx];
            n++;
          }
        small[y * sw + x] = sum / n;
      }
    const pools = blurField(small, sw, sh, Math.max(1, Math.round(Math.max(w, h) / 24 / D)));
    let mx = 1e-6;
    for (const v of pools) mx = Math.max(mx, v);
    const k0 = POOL_STRENGTH / mx;
    for (let y = 0; y < h; y++) {
      const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) / D - 0.5)), y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) / D - 0.5)), x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
        const top = pools[y0 * sw + x0] + (pools[y0 * sw + x1] - pools[y0 * sw + x0]) * tx;
        const bot = pools[y1 * sw + x0] + (pools[y1 * sw + x1] - pools[y1 * sw + x0]) * tx;
        const k = y * w + x;
        a[k] = Math.max(a[k], (top + (bot - top) * ty) * k0);
      }
    }
  }
  for (let k = 0; k < a.length; k++) a[k] *= plan.strength;
  return { a, w, h };
}
function nebulaRGBA(config, opts) {
  return maskToRGBA(nebulaMask(config, opts));
}
function maskToRGBA(m) {
  const rgba = new Uint8ClampedArray(m.w * m.h * 4);
  for (let k = 0; k < m.a.length; k++) {
    const o = k * 4;
    rgba[o] = 255;
    rgba[o + 1] = 255;
    rgba[o + 2] = 255;
    rgba[o + 3] = Math.round(m.a[k] * 255);
  }
  return { rgba, w: m.w, h: m.h };
}
var MASKS = /* @__PURE__ */ new Map();
function maskKey(config) {
  const plan = config.nebulaConfig;
  const { w, h } = nebulaRenderSize(config.width, config.height, config.nebulaConfig?.pixels);
  return `${config.seed}:${w}x${h}:${plan.cover}:${plan.strength}:${plan.colour.mode}`;
}
function storeMask(key, rgba, w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const x = c.getContext("2d");
  const id = x.createImageData(w, h);
  id.data.set(rgba);
  x.putImageData(id, 0, 0);
  if (MASKS.size > 12) MASKS.delete(MASKS.keys().next().value);
  MASKS.set(key, c);
  return c;
}
function maskCanvas(config) {
  const key = maskKey(config);
  if (MASKS.has(key)) return MASKS.get(key);
  const { rgba, w, h } = nebulaRGBA(config);
  return storeMask(key, rgba, w, h);
}
function drawNebula(ctx, config) {
  const plan = config.nebulaConfig;
  if (!plan || plan.strength === 0) return;
  const mask = maskCanvas(config);
  const tinted = document.createElement("canvas");
  tinted.width = config.width;
  tinted.height = config.height;
  const tx = tinted.getContext("2d");
  tx.imageSmoothingEnabled = true;
  tx.imageSmoothingQuality = "high";
  tx.drawImage(mask, 0, 0, config.width, config.height);
  tx.globalCompositeOperation = "source-in";
  const gradient = LinearGradient(plan.colour.gradient || config.starFieldConfig.gradientConfig);
  tx.drawImage(gradient, 0, 0);
  gradient.width = 0;
  gradient.height = 0;
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(tinted, 0, 0);
  tinted.width = 0;
  tinted.height = 0;
}

// ../src/render/generateArtwork.js
var GENERATOR_VERSION = 15;
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
function generateArtwork(seed = randomSeed(), width, height, colorValues = [], settings = null, {
  includeGeometry = true,
  geometryLayout = null,
  mirrorX = false,
  sizeFrame = null,
  legSymmetry = false,
  geometryScale = 1,
  // Render context like the rest: the nebula field's area (render/nebula.js NEBULA_PIXELS_LITE)
  // for a decorative render. Consumes no rng(); null is the standard fixed area.
  nebulaPixels = null
} = {}) {
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
  config.nebulaConfig = generateNebula(config, { linked: geometry.nebulaLinked });
  if (nebulaPixels && config.nebulaConfig.strength) config.nebulaConfig.pixels = nebulaPixels;
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
  const backgroundHue = paletteColors.length === 0 ? tinycolor4(config.gradientBackgroundConfig.colors[0]).toHsl().h : null;
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
      sizeFrame,
      geometryScale
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
  Object.defineProperty(config, "generatedBy", {
    value: [seed, width, height, colorValues.slice(), settings, { includeGeometry, geometryLayout, mirrorX, sizeFrame, legSymmetry, geometryScale, nebulaPixels }]
  });
  return config;
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
var SMALL_SPRITE = null;
function smallStarSprite() {
  if (!SMALL_SPRITE)
    SMALL_SPRITE = buildSmallStarSprite(SMALL_SPRITE_PX, (w, h) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      return c;
    });
  return SMALL_SPRITE;
}
function StarField(config) {
  let canvas = document.createElement("canvas");
  let context2 = canvas.getContext("2d");
  canvas.width = config.width;
  canvas.height = config.height;
  context2.globalCompositeOperation = "destination-atop";
  let gradient = LinearGradient(config.gradientConfig);
  context2.drawImage(gradient, 0, 0);
  let starCanvas = document.createElement("canvas");
  let starContext = starCanvas.getContext("2d");
  starCanvas.width = config.width;
  starCanvas.height = config.height;
  const smallSprite = smallStarSprite();
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
  context2.drawImage(starCanvas, 0, 0);
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
  stage.enableDOMEvents(false);
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
  drawNebula(ctx, config);
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
  nebula2dRows,
  prepareNebulaWithField,
  renderArtwork
};
