// Decides whether a `label_outside` mark should be printed in light or dark ink, by looking at the
// artwork it will actually be printed over.
//
// WHY THIS EXISTS (2026-08-29, Aaron: "it would have been good to use the light variant of the logo
// since the label area is so dark"). `label_outside` is printed ON TOP of the front artwork, and it
// has always used one fixed treatment -- transparent, with the greys inverted to dark and the ring
// flipped from white to the dark ink. That is correct only while the artwork underneath is light.
// Measured over six real saved designs at the patch where the shorts' label actually lands, mean
// sRGB luminance was 0.15-0.25 on FOUR of them: the mark was the wrong choice more often than not,
// which is why it kept getting lost on real garments.
//
// This closes a question that was previously answered "impossible", and the reason it is answerable
// now is worth recording. In August the blocker was that nothing in Printful's catalog data maps
// label_outside to a location on the front sheet, so there was no region to sample; inferring one
// from CAD templates would have been the same hand-measured guessing that produced the pocket-crop
// seam defects. The calibration-mockup technique built for the leg wrap reads that mapping straight
// off a real garment instead -- see PRODUCT_MOCKUP_CONFIG's labelOutsideRegion for the measurements
// and how they were taken.
//
// WHAT IS SAMPLED IS THE RENDERED SHEET, NOT THE COMPOSITION. On the two-leg products and the hat
// the printed sheet is a wrap of the composition, so the artwork under a given point of the sheet
// is not the composition at that point. The caller passes whatever wrap applies and it is applied
// here at low resolution.
//
// AND IT IS SAMPLED CLIENT-SIDE IN BOTH PATHS, which is the load-bearing detail. The mockup and the
// print file must reach the IDENTICAL light/dark decision or the preview lies about the garment. At
// checkout the real print render happens on Fly and the browser never sees its pixels -- so this
// re-renders a small copy locally instead. That is safe because generateArtwork is a pure function
// of (seed, colors, settings, size, renderContext): a small render at the same ASPECT is a faithful
// low-resolution version of the print, and a mean over a patch is insensitive to the resolution.

import { generateArtwork } from './generateArtwork';
import renderArtwork from './renderArtwork';
import { drawLegWrap, legWrapSourceSize } from './legWrap';
import { drawHatWrap, hatWrapSourceSize, hatWrapDiscSourceSize } from './hatWrap';

// Long edge of the sampling render. Small on purpose -- this runs before every label upload, and a
// mean luminance over a patch that is at minimum 4% of the sheet is stable well below this.
const SAMPLE_LONG_EDGE = 480;

// Above this the artwork under the patch is bright enough that the existing dark ink reads, so it
// is kept. Deliberately the same constant `starBlendMode` and `contrastPalette` already share
// (prng.js's BRIGHT_BACKDROP), so nothing in the app can drift about what "bright" means.
export const LABEL_BRIGHT_BACKDROP = 0.42;

function relativeLuminance(r, g, b) {
  const f = c => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

// Renders the front sheet small, with whatever wrap the product uses, and returns its canvas.
function renderFrontSample(design, spec, opts) {
  const { includeGeometry = true, geometryLayout = null, sizeFrame = null, legSymmetry = false, legWrap = null, hatWrap = null } = opts;
  const scale = SAMPLE_LONG_EDGE / Math.max(spec.width, spec.height);
  const width = Math.max(2, Math.round(spec.width * scale));
  const height = Math.max(2, Math.round(spec.height * scale));
  const ctx = { includeGeometry, geometryLayout, sizeFrame, legSymmetry };
  // mirrorX is deliberately never applied: the front placement is the unmirrored one, and it is the
  // front the label is printed over.
  if (legWrap) {
    const src = legWrapSourceSize(legWrap, width, height);
    const comp = renderArtwork(generateArtwork(design.seed, src.width, src.height, design.colors, design.settings, ctx));
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    drawLegWrap(out.getContext('2d'), comp, legWrap, width, height, {});
    return out;
  }
  if (hatWrap) {
    const src = hatWrapSourceSize(hatWrap, width);
    const disc = hatWrapDiscSourceSize(hatWrap, width);
    const unrolled = renderArtwork(generateArtwork(design.seed, src.width, src.height, design.colors, design.settings, ctx));
    const discCanvas = renderArtwork(generateArtwork(design.seed, disc.width, disc.height, design.colors, design.settings, ctx));
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    drawHatWrap(out.getContext('2d'), unrolled, discCanvas, hatWrap, width, height, {});
    return out;
  }
  return renderArtwork(generateArtwork(design.seed, width, height, design.colors, design.settings, ctx));
}

// Mean sRGB relative luminance of the artwork under this product's outside label, or null when the
// product declares no region (every product but the five that carry a visible label_outside).
export function sampleLabelBackdrop(design, frontSpec, region, opts = {}) {
  if (!region || !frontSpec || !design?.seed) return null;
  try {
    const canvas = renderFrontSample(design, frontSpec, opts);
    const w = canvas.width;
    const h = canvas.height;
    // Clamped so a region measured slightly generously can never sample outside the sheet.
    const x0 = Math.max(0, Math.min(w - 1, Math.round(region.x * w)));
    const y0 = Math.max(0, Math.min(h - 1, Math.round(region.y * h)));
    const rw = Math.max(1, Math.min(w - x0, Math.round(region.w * w)));
    const rh = Math.max(1, Math.min(h - y0, Math.round(region.h * h)));
    const data = canvas.getContext('2d').getImageData(x0, y0, rw, rh).data;
    let total = 0;
    for (let i = 0; i < data.length; i += 4) total += relativeLuminance(data[i], data[i + 1], data[i + 2]);
    return total / (data.length / 4);
  } catch {
    // Never fail an upload over this: a null result means the caller keeps the existing ink, which
    // is exactly the behaviour that shipped before this existed.
    return null;
  }
}

// True when the mark should use the LIGHT ink (the same ink the inside tag already prints -- white
// ring, light greys -- minus the tag's own dark panel). Null luminance keeps today's dark ink.
export function wantsLightInk(luminance) {
  return luminance != null && luminance < LABEL_BRIGHT_BACKDROP;
}
