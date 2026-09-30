// Whether the animation's logo mark should be drawn in LIGHT or DARK ink, from the artwork it
// actually appears over (Aaron, 2026-09-30: "it just adds the light logo"). The same decision the
// printed label_outside already makes (render/labelBackdrop), with the same threshold, so nothing in
// the app disagrees about what "bright" means.
//
// The mark shows at the loop SEAM, centred, at LOGO_SCREEN_FRACTION of the short edge, so that
// square of the seam frame is what is measured:
//   2D: the seam is frame 1, which is the design's own artwork -- measured exactly, re-rendered
//       small (a mean over a patch is insensitive to resolution).
//   3D: the seam frame is a WebGL render. The design's 2D artwork is NOT a usable stand-in: over
//       60 designs it agreed with the real seam frame on only 48 (correlation 0.57), because the
//       flight's camera frames the composition differently. So the real seam frame is rendered,
//       at a FIXED small square, which is what makes the studio preview, the export (any ratio) and
//       the gallery modal reach the identical answer.
import { generateArtwork } from './generateArtwork';
import renderArtwork from './renderArtwork';
import { relativeLuminance, wantsLightInk } from './labelBackdrop';
import { LOGO_SCREEN_FRACTION } from '../utils/logoIntro';

const SAMPLE_2D_LONG_EDGE = 480;
const SAMPLE_3D_SIZE = 256;

function centreLuminance(data, width, height) {
  const side = Math.max(1, Math.round(LOGO_SCREEN_FRACTION * Math.min(width, height)));
  const x0 = Math.round((width - side) / 2);
  const y0 = Math.round((height - side) / 2);
  let total = 0;
  for (let y = y0; y < y0 + side; y++) {
    for (let x = x0; x < x0 + side; x++) {
      const i = (y * width + x) * 4;
      total += relativeLuminance(data[i], data[i + 1], data[i + 2]);
    }
  }
  return total / (side * side);
}

// True when the mark should use the dark ink. A failed measurement keeps the light ink, which is
// what every animation used before this existed.
export function darkInkFor(luminance) {
  return luminance != null && !wantsLightInk(luminance);
}

// 2D: `design` is the animation's first frame (compact or resolved), at the frames' own aspect
export function logoBackdrop2D(design, width, height) {
  try {
    const scale = SAMPLE_2D_LONG_EDGE / Math.max(width, height);
    const w = Math.max(2, Math.round(width * scale));
    const h = Math.max(2, Math.round(height * scale));
    const canvas = renderArtwork(generateArtwork(design.seed, w, h, design.colors || [], design.settings ?? null));
    return centreLuminance(canvas.getContext('2d').getImageData(0, 0, w, h).data, w, h);
  } catch {
    return null;
  }
}

// 3D: renders the flight's real seam frame (lazily -- three.js stays out of the main bundle)
export async function logoBackdrop3D(design, duration) {
  try {
    const { render3DStillPixels } = await import('../animation3d/renderStill');
    const img = await render3DStillPixels(design, { duration, width: SAMPLE_3D_SIZE, height: SAMPLE_3D_SIZE, at: 0 });
    return centreLuminance(img.data, img.width, img.height);
  } catch {
    return null;
  }
}
