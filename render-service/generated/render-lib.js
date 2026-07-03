// ../src/components/Canvas/GenerateLinearGradient.js
import tinycolor from "tinycolor2";

// ../src/render/prng.js
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

// ../src/components/Canvas/GenerateLinearGradient.js
var GenerateLinearGradient = class {
  constructor(width, height, complexity = 0, colors = [], rng = Math.random) {
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
      if (colors.length === 1) {
        let colorChance = rng();
        if (colorChance > 0.5) {
          let ranGrayScale = Math.round(rng() * 255);
          let newColor = tinycolor({ r: ranGrayScale, g: ranGrayScale, b: ranGrayScale });
          let colorOrderChance = rng();
          if (colorOrderChance > 0.5) {
            config.colors.push(colors[0]);
            config.colors.push(newColor);
          } else {
            config.colors.push(newColor);
            config.colors.push(colors[0]);
          }
        } else {
          let ranSpin = -20 + rng() * 40;
          let newColor = tinycolor(colors[0]).spin(ranSpin).toHexString();
          let colorOrderChance = rng();
          if (colorOrderChance > 0.5) {
            config.colors.push(colors[0]);
            config.colors.push(newColor);
          } else {
            config.colors.push(newColor);
            config.colors.push(colors[0]);
          }
        }
      } else {
        config.colors = colors;
      }
    } else {
      let colorAmount = 2 + complexity;
      let gradientType = rng();
      if (gradientType > 0.5) {
        let colorStart = rng() * 360;
        let colorDistance = rng() * 50;
        for (let i = 0; i < colorAmount; i++) {
          config.colors.push(
            tinycolor("#CCFF00").spin(colorStart + colorDistance * i).toHexString()
          );
        }
      } else {
        let colorType = rng();
        for (let i = 0; i < colorAmount; i++) {
          if (colorType > 0.8) {
            config.colors.push(randomColorHex(rng));
          } else {
            config.colors.push(
              tinycolor("#CCFF00").spin(Math.round(rng() * 360)).toHexString()
            );
          }
        }
      }
    }
    return config;
  }
};

// ../src/components/Canvas/GenerateLargeRadialField.js
import tinycolor2 from "tinycolor2";

// ../src/render/scale.js
var REFERENCE_WIDTH = 3840;
var REFERENCE_HEIGHT = 2160;
var REFERENCE_AREA = REFERENCE_WIDTH * REFERENCE_HEIGHT;
function getCountScale(width, height) {
  return Math.sqrt(width * height / REFERENCE_AREA);
}
function getSizeScale(width, height) {
  return Math.min(width, height);
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
        if (colors.length === 1) {
          let colorChance = rng();
          if (colorChance > 0.5) {
            let ranGrayScale = Math.round(rng() * 255);
            let newColor = tinycolor2({ r: ranGrayScale, g: ranGrayScale, b: ranGrayScale });
            let colorOrderChance = rng();
            if (colorOrderChance > 0.5) {
              radGrad.colors.push(colors[0]);
              radGrad.colors.push(newColor);
            } else {
              radGrad.colors.push(newColor);
              radGrad.colors.push(colors[0]);
            }
          }
        } else {
          radGrad.colors = colors.slice();
        }
      } else {
        let gradientType = rng();
        if (gradientType > 0.5) {
          let colorStart = rng() * 360;
          let colorDistance = rng() * 50;
          for (let i2 = 0; i2 < colorAmount; i2++) {
            radGrad.colors.push(
              tinycolor2("#CCFF00").spin(colorStart + colorDistance * i2).toHexString()
            );
          }
        } else {
          let colorType = rng();
          for (let i2 = 0; i2 < colorAmount; i2++) {
            if (colorType > 0.8) {
              radGrad.colors.push(randomColorHex(rng));
            } else {
              radGrad.colors.push(
                tinycolor2("#CCFF00").spin(Math.round(rng() * 360)).toHexString()
              );
            }
          }
        }
      }
      radGradients.push(radGrad);
    }
    config.radGradients = radGradients.slice(0, keepAmount);
    return config;
  }
};

// ../src/components/Canvas/GenerateStarField.js
var GenerateStarField = class {
  constructor(width, height, colors = [], rng = Math.random) {
    let config = {};
    config.width = width;
    config.height = height;
    let sizeScale = getSizeScale(width, height);
    let countScale = getCountScale(width, height);
    let gradientComplexity = Math.round(rng() * 4);
    let gradientConfig = new GenerateLinearGradient(
      width,
      height,
      gradientComplexity,
      colors.reverse(),
      rng
    );
    config.gradientConfig = gradientConfig;
    let stars = [];
    let xlStarSizeMax = sizeScale / 4;
    let xlStarSizeMin = sizeScale / 30;
    let xlStars = [];
    for (let i = 0; i < 5; i++) {
      let ranSize = Math.round(xlStarSizeMin + rng() * xlStarSizeMax);
      let ranX = Math.round(-100 + rng() * width + 100);
      let ranY = Math.round(-100 + rng() * height + 100);
      xlStars.push({ x: ranX, y: ranY, size: ranSize, image: "star-large" });
    }
    stars.push(...xlStars.slice(0, Math.max(1, Math.round(5 * countScale))));
    let largeStarSizeMax = sizeScale / 7;
    let largeStarSizeMin = sizeScale / 200;
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
import tinycolor3 from "tinycolor2";

// ../src/render/designSettings.js
var DEFAULT_GEOMETRY_SETTINGS = {
  // Probability the geometry layer appears at all: 0 = never, 1 = always.
  chance: 0.4,
  // Lattice vertex-count range (a "points" value of 6 makes hexagonal lattices). Equal
  // min/max pins the shape: min = max = 6 means every design gets a hexagon.
  pointsMin: 3,
  pointsMax: 12,
  // 0 = fully chaotic (unbounded size, random unrecognizable triangles, panels mostly
  // unfilled); 1 = a clean regular polygon, every lattice cell filled, sized to sit fully
  // inside the canvas with clearance on all sides.
  coherence: 0
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
  constructor(width, height, shapeNum, colors = [], rng = Math.random, settings = null) {
    const geometry = getGeometrySettings(settings);
    let config = {
      width,
      height,
      shapes: []
    };
    this.rng = rng;
    this.colors = colors;
    this.shapeVertices = geometry.pointsMin + Math.round(rng() * (geometry.pointsMax - geometry.pointsMin));
    this.shapeDepth = 2 + Math.round(rng() * 4);
    this.shapeAng = 360 / this.shapeVertices;
    const chaoticSize = 150 + Math.round(rng() * getSizeScale(width, height) / 3);
    const coherentSize = getSizeScale(width, height) * 0.375 / this.shapeDepth;
    this.shapeSize = chaoticSize + (coherentSize - chaoticSize) * geometry.coherence;
    this.points = this.pointsArray(this.shapeSize);
    for (let i = 0; i < shapeNum; i++) {
      config.shapes.push(this.buildShape());
    }
    let keepCount = Math.max(1, Math.round(shapeNum * getCountScale(width, height)));
    if (geometry.coherence > 0) {
      keepCount = Math.min(keepCount, Math.round(shapeNum * (1 - geometry.coherence)));
    }
    config.shapes = config.shapes.slice(0, keepCount);
    if (geometry.coherence > 0) {
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
    const idx = (ring, k) => 1 + (ring - 1) * perRing + k % perRing;
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
        let rad = ang * Math.PI / 180;
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
          tinycolor3({ r: ranGrayScale, g: ranGrayScale, b: ranGrayScale }),
          tinycolor3(this.colors[0]).spin(-40 + this.rng() * 80).toHexString()
        );
      } else if (this.colors.length === 2) {
        shape.colors.push(
          this.colors[0],
          this.colors[1],
          tinycolor3(this.colors[0]).spin(-20 + this.rng() * 40).toHexString()
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
      array[i] = tinycolor3(array[i]).spin(-10 + this.rng() * 20).toHexString();
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
};

// ../src/render/generateArtwork.js
var GENERATOR_VERSION = 3;
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
function generateArtwork(seed = randomSeed(), width, height, colorValues = [], settings = null) {
  const rng = makeRng(seed);
  const config = {
    generatorVersion: GENERATOR_VERSION,
    seed,
    width,
    height,
    colors: colorValues.slice()
  };
  const compactedSettings = compactSettings(settings);
  if (compactedSettings) config.settings = compactedSettings;
  config.gradientBackgroundConfig = new GenerateLinearGradient(
    width,
    height,
    1,
    colorValues.slice(),
    rng
  );
  let radialChance = rng();
  if (radialChance > 0.4) {
    config.firstBlend = randomBlendMode(rng);
    config.radialFieldConfig = new GenerateLargeRadialField(
      width,
      height,
      colorValues.slice(),
      rng
    );
  }
  config.secondBlend = randomBlendMode(rng);
  config.starFieldConfig = new GenerateStarField(width, height, colorValues.slice(), rng);
  let geometryChance = rng();
  const geometry = getGeometrySettings(settings);
  if (geometryChance >= 1 - geometry.chance) {
    config.thirdBlend = randomBlendMode(rng);
    let shapeNum = 10 + Math.round(rng() * 30);
    config.geometryConfig = new GenerateGeometricShape(
      width,
      height,
      shapeNum,
      colorValues.slice(),
      rng,
      settings
    );
  }
  let overlayChance = rng();
  if (overlayChance >= 0.7 && colorValues.length > 0) {
    config.overlayBlend = randomBlendMode(rng);
    config.overlayAlpha = rng().toFixed(2);
    config.overlayConfig = new GenerateLinearGradient(
      width,
      height,
      Math.round(rng() * 2),
      colorValues.slice(),
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
function GeometricShape(config) {
  let canvas = document.createElement("canvas");
  canvas.width = config.width;
  canvas.height = config.height;
  let container = new window.createjs.Stage(canvas);
  container.x = config.width / 2;
  container.y = config.height / 2;
  container.rotation = 90;
  for (let i = 0; i < config.shapes.length; i++) {
    container.addChild(buildShape(config.shapes[i]));
  }
  container.update();
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
  return canvas;
}
export {
  GENERATOR_VERSION,
  generateArtwork,
  renderArtwork
};
