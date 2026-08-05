// Extracts a small representative palette from a rendered design.
//
// WHY THIS EXISTS: a design's `colors` array is the palette the user explicitly chose, and
// most designs don't have one -- 37 of the 47 rows live at the time of writing are
// auto-palette (an empty array), where the palette is derived from the seed inside the
// generators and never persisted. So anything that wants to SHOW a design's colours can't
// read them off the row for the majority of the gallery; it has to look at the pixels.
//
// Takes raw ImageData rather than a canvas or an image element so it's a pure function over
// a buffer -- no DOM, directly testable, and it can't accidentally depend on where the
// pixels came from.
//
// TAINTING: the caller must only ever pass this pixels from a same-origin source. In
// GalleryModal that's the blob: URL produced by our own renderDesignBlob, so getImageData
// is safe. A remote Storage thumbnail would throw a SecurityError instead -- see the
// caller's guard.

const HUE_BUCKETS = 24; // 15 degrees each -- fine enough to separate adjacent hues, coarse
                        // enough that a smooth gradient doesn't shatter into 30 near-twins
const LIGHT_BANDS = 3; // dark / mid / light, so a design that's one hue at three depths
                       // still yields a readable range instead of a single flat chip

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function toHex(r, g, b) {
  const p = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${p(r)}${p(g)}${p(b)}`;
}

// Perceptual-ish distance, used only to reject near-duplicate swatches. Weighted toward
// hue and lightness because two chips differing only in saturation read as the same colour
// at 15px.
function tooClose(a, b) {
  const dh = Math.min(Math.abs(a.h - b.h), 1 - Math.abs(a.h - b.h)) * 2;
  const dl = Math.abs(a.l - b.l);
  return dh < 0.07 && dl < 0.14;
}

/**
 * @param {{ data: Uint8ClampedArray|number[], width: number, height: number }} imageData
 * @param {number} count how many swatches to return (fewer if the design genuinely has fewer)
 * @returns {string[]} hex strings, most dominant first
 */
export default function samplePalette(imageData, count = 5) {
  const { data, width, height } = imageData;
  if (!data || !width || !height) return [];

  // Cap the work regardless of source size: a 1400x1400 render is ~2M pixels and ~4000
  // samples is already far more than enough to rank 72 buckets.
  const total = width * height;
  const step = Math.max(1, Math.floor(Math.sqrt(total / 4000)));

  const buckets = new Map();
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 128) continue; // transparent -- label marks are the only source with
                                       // alpha, but don't let one leak a black swatch
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const [h, s, l] = rgbToHsl(r, g, b);

      // Near-black is the backdrop of nearly every design in this generator; counting it
      // would make the first swatch of every single design the same dark violet.
      if (l < 0.08) continue;

      const hb = Math.min(HUE_BUCKETS - 1, Math.floor(h * HUE_BUCKETS));
      const lb = Math.min(LIGHT_BANDS - 1, Math.floor(l * LIGHT_BANDS));
      const key = hb * LIGHT_BANDS + lb;

      // Weight by saturation, not just pixel count. Large washes of desaturated mid-tone
      // dominate by area in most of these compositions, but the vivid accents are what a
      // person would name as the design's colours.
      const weight = 0.15 + s;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { r: 0, g: 0, b: 0, w: 0 };
        buckets.set(key, bucket);
      }
      bucket.r += r * weight;
      bucket.g += g * weight;
      bucket.b += b * weight;
      bucket.w += weight;
    }
  }

  const ranked = [...buckets.values()]
    .filter(x => x.w > 0)
    .sort((a, b) => b.w - a.w)
    .map(x => {
      const r = x.r / x.w;
      const g = x.g / x.w;
      const b = x.b / x.w;
      const [h, s, l] = rgbToHsl(r, g, b);
      return { hex: toHex(r, g, b), h, s, l };
    });

  const out = [];
  for (const candidate of ranked) {
    if (out.length >= count) break;
    if (out.some(picked => tooClose(picked, candidate))) continue;
    out.push(candidate);
  }

  // WHICH colours to keep is ranked by dominance above; what ORDER to show them in is a
  // separate question, and dominance is the wrong answer for a swatch rail -- on a smooth
  // gradient it returns the right five hues in a jumbled sequence that reads as noise.
  // Sorting by hue makes a gradient's swatches run in the order they appear in the piece.
  // Nothing downstream reads meaning from the order (the stored-palette path shows the
  // user's own colours in their own order, which is equally arbitrary), so this costs no
  // information.
  return out.sort((a, b) => a.h - b.h || a.l - b.l).map(x => x.hex);
}
