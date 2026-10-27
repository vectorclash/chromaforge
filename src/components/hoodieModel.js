import { capMockupRenderSize } from '../render/scale';
import { PRODUCT_MOCKUP_CONFIG } from '../lib/printfulMockupConfig';

// The 3D hoodie: model, texture sheet and lighting term. Built 2026-09-28 as a trial for the
// homepage hero (branch `hoodie-hero-preview`; Aaron kept the tee there), and brought back
// 2026-10-26 for the ad builder's explainer, which can wear either garment. The hero still wears
// the tee and does not use this module.
//
// Model: "Apricot printed hooded casual Hoodie"
// (https://sketchfab.com/3d-models/apricot-printed-hooded-casual-hoodie-211f12b2949346e9ab24a20bf15528c8)
// by Style3D CG (https://sketchfab.com/Style3DMeta), CC-BY-4.0 -- public/models/hoodie/, with its
// license.txt alongside, which is a licence obligation exactly as the tee's is.
// scripts/hoodie-model/README.md has how the served .glb was built from the download.
//
// Unlike the tee, the served .glb is not just an optimized copy of the download: its UVs were
// RE-LAID in Blender so that every printed piece sits UPRIGHT and UNMIRRORED as seen from outside
// the garment, i.e. oriented exactly like the piece on Printful's own template. That is what lets
// every draw below be a plain rect-to-rect copy with no flip flags. The two hood linings have
// their own atlas space, because Printful prints the lining too. Every other inside surface is
// UNPRINTED, as on the real garment and the tee (2026-10-27, Aaron): build.py maps it onto its
// piece's rect, then scripts/hoodie-model/unprint-inside.mjs moves it off the atlas to UV + (1, 1),
// where the sheet's edge clamp samples composeHoodieSheet's white margin. That relies on the
// texture keeping three's default ClampToEdge wrap. The cords map to a white patch.
// Served: 23,528 triangles, 509KB (float UVs), no textures (the app supplies the only one).

export const HOODIE_URL = '/models/hoodie/hoodie.glb';

// Every printed piece of this hoodie (product 388) comes from ONE square printfile (200,
// 6000x6000), so a design needs one render, the same one checkout makes.
const HOODIE_PRINTFILE = { width: 6000, height: 6000 };
const hoodieCap = capMockupRenderSize(HOODIE_PRINTFILE.width, HOODIE_PRINTFILE.height);
export const HOODIE_RENDER = { w: hoodieCap.width, h: hoodieCap.height };

// The lighting term TshirtPreview's AMBIENT is derived from. The tee's documented 0.743, plus the
// difference between the two models measured by ONE method (area-weighted mean of max(0, N.L)
// over the camera-visible garment, rendered in Blender with the same key light): 0.666 hoodie
// against 0.504 tee. Applying the DIFFERENCE lands it at the brightness the tee was verified at,
// whatever that method's absolute bias is.
export const HOODIE_MEAN_NDOTL = 0.743 + (0.666 - 0.504);

// How much of the frame's height the tee fills in TshirtPreview (0.6992 tall, radius 0.4951,
// 3.1 radii away, 14 degree half-angle). The hoodie is tall and narrow because of its hood, so it
// is framed by HEIGHT to this fill rather than by its bounding sphere.
export const GARMENT_FRAME_FILL = 0.6992 / (3.1 * 0.4951 * 2 * Math.tan((14 * Math.PI) / 180));

// THE TABLE maps each atlas rect to the region of the print file that lands on that piece. `src`
// names which file the piece is cut from: 'art' is the render, 'back' is it mirrored
// (PRODUCT_MOCKUP_CONFIG[388].mirrorPlacements), 'pocket' is the pocket file, itself a crop of the
// front (pocketCrop). `region` is [x, y, w, h] as fractions of that file, measured off Printful's
// own templates (19360-19365). The pieces are mapped at ONE scale for the whole garment (taken
// from the front's height), so the artwork's features are the same size on every piece, as a
// 150 DPI print is; centred on their template piece, and anchored where a seam makes the position
// matter (the torso and sleeves at their bottom edge, the waistband and cuffs at their top, so
// the art runs on at the hem and the cuffs). Style3D's cut is slimmer than Printful's, so each
// piece shows the middle of its template region rather than all of it.
// A copy of scripts/hoodie-model/layout.json: keep the two in sync.
const ATLAS = 2048;
const HOODIE_POCKET_CROP = PRODUCT_MOCKUP_CONFIG[388].pocketCrop.regions[0].src;
const HOODIE_PIECES = [
  { key: 'front', src: 'art', x: 12, y: 12, w: 683, h: 776, region: [0.15736, 0.0341, 0.68677, 0.7803] },
  { key: 'back', src: 'back', x: 707, y: 12, w: 714, h: 759, region: [0.14168, 0.04628, 0.71815, 0.76382] },
  { key: 'sleeveRight', src: 'art', x: 1433, y: 12, w: 428, h: 713, region: [0.28527, 0.01636, 0.43076, 0.71734] },
  { key: 'sleeveLeft', src: 'art', x: 12, y: 800, w: 428, h: 713, region: [0.28527, 0.01565, 0.43077, 0.71735] },
  { key: 'hoodRightOut', src: 'art', x: 452, y: 800, w: 381, h: 489, region: [0.54683, 0.49979, 0.38303, 0.49212] },
  { key: 'hoodLeftOut', src: 'art', x: 845, y: 800, w: 381, h: 489, region: [0.07218, 0.49979, 0.38303, 0.49213] },
  { key: 'hoodRightIn', src: 'art', x: 1238, y: 800, w: 375, h: 483, region: [0.07441, 0.01168, 0.37708, 0.48595] },
  { key: 'hoodLeftIn', src: 'art', x: 1625, y: 800, w: 375, h: 483, region: [0.54981, 0.01167, 0.37709, 0.48595] },
  { key: 'pocket', src: 'pocket', x: 12, y: 1525, w: 428, h: 299, region: [0.28539, 0.34966, 0.43111, 0.30058] },
  { key: 'bandFront', src: 'art', x: 452, y: 1525, w: 576, h: 135, region: [0.21178, 0.8407, 0.57945, 0.13544] },
  { key: 'bandBack', src: 'back', x: 1040, y: 1525, w: 617, h: 144, region: [0.19047, 0.8363, 0.62066, 0.14508] },
  { key: 'cuffRight', src: 'art', x: 452, y: 1301, w: 272, h: 154, region: [0.36383, 0.7527, 0.27365, 0.15477] },
  { key: 'cuffLeft', src: 'art', x: 736, y: 1301, w: 272, h: 154, region: [0.36323, 0.7533, 0.27365, 0.15477] }
];
// Each piece is drawn this many texels past its rect on every side, at the same mapping, so
// filtering at an island's edge samples artwork rather than the white between rects.
const HOODIE_BLEED = 2;

/**
 * The hoodie's texture sheet, `size` square, from ONE render of the design at HOODIE_RENDER.
 * The back is that render mirrored -- a mirrorX render is a pixel-exact horizontal flip of its
 * unmirrored twin (see renderArtwork), so flipping here is the file checkout uploads.
 * @param {CanvasImageSource & { width: number, height: number }} art
 * @param {number} size
 */
export function composeHoodieSheet(art, size) {
  const sheet = document.createElement('canvas');
  sheet.width = sheet.height = size;
  const ctx = sheet.getContext('2d');
  const back = document.createElement('canvas');
  back.width = art.width;
  back.height = art.height;
  const bctx = back.getContext('2d');
  bctx.translate(art.width, 0);
  bctx.scale(-1, 1);
  bctx.drawImage(art, 0, 0);
  const sc = size / ATLAS;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  for (const p of HOODIE_PIECES) {
    let [sx, sy, sw, sh] = p.region;
    if (p.src === 'pocket') {
      // Pocket-file coordinates into the front render's, through the same crop checkout applies.
      sx = HOODIE_POCKET_CROP.x + sx * HOODIE_POCKET_CROP.w;
      sy = HOODIE_POCKET_CROP.y + sy * HOODIE_POCKET_CROP.h;
      sw *= HOODIE_POCKET_CROP.w;
      sh *= HOODIE_POCKET_CROP.h;
    }
    const img = p.src === 'back' ? back : art;
    const pad = HOODIE_BLEED / sc; // in atlas units
    const fx = sw / p.w;
    const fy = sh / p.h;
    ctx.drawImage(
      img,
      (sx - pad * fx) * img.width,
      (sy - pad * fy) * img.height,
      (sw + 2 * pad * fx) * img.width,
      (sh + 2 * pad * fy) * img.height,
      (p.x - pad) * sc,
      (p.y - pad) * sc,
      (p.w + 2 * pad) * sc,
      (p.h + 2 * pad) * sc
    );
  }
  back.width = 0; // release the copy's backing store now rather than at GC
  return sheet;
}
