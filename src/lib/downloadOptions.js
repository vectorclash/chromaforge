// What the studio's Download panel can produce, and what the files are called. Pure and
// framework-free so the rules can be checked in Node without a browser.
//
// One rule runs through all of it: every aspect ratio is its own COMPOSITION, not a crop
// (render/scale.js's recompose-per-ratio). So a ratio choice changes what the piece looks
// like, while a size choice within one ratio only changes its resolution -- which is why the
// panel shows a live preview of the ratio and never needs one per size.

// Shared by the image and video pickers. The short edge is what a size names (1080p / 4K),
// so every ratio at "4K" is 2160 on its short side: 3840x2160, 2160x3840, 2160x2700, 2160x2160
// -- exactly the video sizes the studio has always exported.
export const RATIOS = {
  '16:9': [16, 9],
  '9:16': [9, 16],
  '4:5': [4, 5],
  '1:1': [1, 1]
};

export const IMAGE_SIZES = {
  '1080p': 1080,
  '4k': 2160,
  '8k': 4320
};

export const VIDEO_SIZES = {
  '1080p': 1080,
  '4k': 2160
};

export const SIZE_LABELS = { '1080p': '1080p', '4k': '4K', '8k': '8K' };

// What one image render may cost, by TOTAL pixels rather than per side -- the lesson from
// render-print-file, whose per-axis cap rejected legitimately long, thin print files while
// letting larger square ones through. Desktop allows 8K (7680x4320, the largest preset), with
// any one side up to 16384 so a long banner is possible. Phones stop at 4K: iOS refuses a
// single canvas past ~16.7M pixels, and renderArtwork holds several full-size layer canvases
// at once, so the real ceiling is well below that.
export const LIMITS = {
  desktop: { pixels: 7680 * 4320, maxSide: 16384 },
  mobile: { pixels: 3840 * 2160, maxSide: 4096 }
};
export const MIN_SIDE = 32;

export function imageSizesFor(mobile) {
  return mobile ? ['1080p', '4k'] : ['1080p', '4k', '8k'];
}

export function dimsFor(ratio, shortEdge) {
  const [a, b] = RATIOS[ratio] ?? RATIOS['16:9'];
  return a >= b
    ? { width: Math.round((shortEdge * a) / b), height: shortEdge }
    : { width: shortEdge, height: Math.round((shortEdge * b) / a) };
}

function megapixels(pixels) {
  return `${Math.round(pixels / 1e5) / 10} MP`;
}

// Turns whatever was typed into a size the renderer can produce, saying why when it had to
// change it. Sides are clamped first, then the area is scaled down UNIFORMLY, so the shape the
// visitor asked for survives a budget cut (a 20000x2000 request on desktop becomes 16384x1638,
// not 16384x2000 -- the second would change the ratio, and so the composition).
export function clampCustomSize(width, height, mobile) {
  const limit = mobile ? LIMITS.mobile : LIMITS.desktop;
  let w = Math.round(Number(width));
  let h = Math.round(Number(height));
  if (!Number.isFinite(w) || w <= 0) w = MIN_SIDE;
  if (!Number.isFinite(h) || h <= 0) h = MIN_SIDE;
  let note = null;

  if (w > limit.maxSide || h > limit.maxSide) {
    const s = limit.maxSide / Math.max(w, h);
    w = Math.floor(w * s);
    h = Math.floor(h * s);
    note = `Max ${limit.maxSide.toLocaleString('en-US')}px a side`;
  }
  if (w * h > limit.pixels) {
    const s = Math.sqrt(limit.pixels / (w * h));
    w = Math.floor(w * s);
    h = Math.floor(h * s);
    note = `Max ${megapixels(limit.pixels)} on this device`;
  }
  if (w < MIN_SIDE || h < MIN_SIDE) {
    w = Math.max(MIN_SIDE, w);
    h = Math.max(MIN_SIDE, h);
    note = `Min ${MIN_SIDE}px a side`;
  }
  return { width: w, height: h, note };
}

// The image actually produced for a set of panel choices.
export function imageDims({ imageRatio, imageSize, customWidth, customHeight }, mobile) {
  if (imageRatio === 'custom') {
    const { width, height } = clampCustomSize(customWidth, customHeight, mobile);
    return { width, height };
  }
  const sizes = imageSizesFor(mobile);
  const size = sizes.includes(imageSize) ? imageSize : '4k';
  return dimsFor(imageRatio, IMAGE_SIZES[size]);
}

// Phones always export 1080p video: full 4K encoding needs ~500MB+ of GPU/RAM, which iOS
// WebViews refuse (the reason exports have always halved there).
export function videoDims({ exportAspect, exportSize }, mobile) {
  const size = mobile ? '1080p' : VIDEO_SIZES[exportSize] ? exportSize : '4k';
  return dimsFor(RATIOS[exportAspect] ? exportAspect : '16:9', VIDEO_SIZES[size]);
}

// File names carry everything that makes one file different from another made from the same
// piece. Pixel size rather than ratio, since it says the ratio AND the resolution and also
// covers custom sizes with no tidy ratio name. Video adds frame rate and length: two loops of
// one flight at 5s and 10s were otherwise the same name, and the browser numbered them.
export function imageFileName(name, width, height, format) {
  return `${name}_${width}x${height}.${format === 'png' ? 'png' : 'jpg'}`;
}

export function videoFileName(name, width, height, fps, seconds) {
  const s = Math.round(seconds * 100) / 100;
  return `${name}_${width}x${height}_${fps}fps_${s}s.mp4`;
}

// Where the preview is drawn: the chosen shape, long edge `long`, never thinner than 8px so
// an extreme custom strip still shows as something.
export function previewDims(width, height, long = 600) {
  const r = width / height;
  return r >= 1
    ? { width: long, height: Math.max(8, Math.round(long / r)) }
    : { width: Math.max(8, Math.round(long * r)), height: long };
}
