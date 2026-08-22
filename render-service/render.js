// Renders a design at a given resolution using the render pipeline bundled (by build.js,
// see its header comment) from the main app's actual ../src/render files -- not copied or
// ported by hand, so server-rendered print files can never drift from what a customer's
// mockup showed. shim.js (imported first, for its side effects) is what makes that
// pipeline runnable outside a real browser. Run `npm run build` before starting this
// service (or after any change to ../src/render) to regenerate generated/render-lib.js.
import './shim.js';
import { createCanvas } from '@napi-rs/canvas';
import {
  generateArtwork,
  GENERATOR_VERSION,
  renderArtwork,
  drawHatWrap,
  hatWrapSourceSize,
  hatWrapDiscSourceSize
} from './generated/render-lib.js';

// This used to load the two star sprite PNGs off disk and hand renderArtwork a { getResult }
// shim standing in for StudioContext's createjs LoadQueue. Both star shapes are drawn from
// code now (src/render/starSprite.js), so the pipeline takes no assets at all and the
// Dockerfile no longer copies them. shim.js still loads createjs itself -- GeometricShape.js
// uses EaselJS -- so that is unrelated and stays.

// design = { seed, colors, settings?, generatorVersion }. Caller (server.js) is responsible
// for checking generatorVersion against GENERATOR_VERSION before calling this -- this
// function always renders with whatever code is currently loaded, same as the rest of the
// app. `settings` (the studio's generation settings, e.g. geometry sliders) rides along
// like seed/colors: absent means the generator defaults, exactly like the frontend.
// `includeGeometry` is render context (not design identity, see generateArtwork.js's
// renderContext param) -- whether the geometry layer appears on this specific placement,
// driven by ProductPage.jsx's per-placement checkboxes. `geometryLayout` ('single' |
// 'mirror', optional) is the same idea for products whose front/back printfile is one flat
// canvas cut into two garment legs when sewn -- see GeometricShape.js.
// `regions`/`sourceWidth`/`sourceHeight` (all optional; regions implies the other two):
// placements that physically continue a larger panel's artwork (hoodie/zip-hoodie
// pocket) generate the SOURCE composition at sourceWidth x sourceHeight (the front
// placement's own dims/aspect -- generateArtwork is ratio-aware, so generating at the
// wrong aspect would produce a structurally different, unrelated layout, not a
// continuation of the front) and then composite `regions` (each { src, dest }, fractions
// of the source/output respectively) onto a new width x height output canvas -- that
// output size is the TARGET placement's own printfile dims (which may have a different
// aspect than the source, e.g. the zip hoodie's pocket file vs. its front file).
// Regenerating the source here (rather than reusing another request's pixels) is
// intentional: generateArtwork is a pure function of its inputs, so a second call with
// the same seed/colors/settings/dims reproduces the exact same front composition
// byte-for-byte (see CLAUDE.md's "recompose-per-ratio" design) -- this keeps
// render-service's one-request-one-render model instead of needing cross-request caching.
export async function renderDesign({
  seed,
  colors,
  width,
  height,
  settings = null,
  includeGeometry = true,
  geometryLayout = null,
  mirrorX = false,
  sizeFrame = null,
  legSymmetry = false,
  regions = null,
  sourceWidth = null,
  sourceHeight = null,
  hatWrap = null
}) {
  // Wraps the composition onto a hat's real cut pieces rather than laying it flat across the
  // sheet -- see src/render/hatWrap.js for the geometry and why the crown top is handled
  // differently from the crown wall and brim. Unlike `regions` below, this is NOT mirrored by
  // hand here: drawHatWrap comes through the same bundle as generateArtwork, so the browser and
  // this service run one implementation.
  //
  // mirrorX is deliberately NOT passed to either source generation. For every other placement it
  // reflects the composition inside renderArtwork; here the thing that has to be reflected is the
  // finished SHEET, so that a face's cut pieces meet their partner's across the side seams. Doing
  // both would mirror twice and land back where it started.
  if (hatWrap) {
    const src = hatWrapSourceSize(hatWrap, width);
    const disc = hatWrapDiscSourceSize(hatWrap, width);
    const unrolled = renderArtwork(
      generateArtwork(seed, src.width, src.height, colors, settings, {
        includeGeometry,
        geometryLayout,
        sizeFrame,
        legSymmetry
      })
    );
    const discCanvas = renderArtwork(
      generateArtwork(seed, disc.width, disc.height, colors, settings, {
        includeGeometry,
        geometryLayout,
        sizeFrame,
        legSymmetry
      })
    );
    const output = createCanvas(width, height);
    drawHatWrap(output.getContext('2d'), unrolled, discCanvas, hatWrap, width, height, {
      mirror: mirrorX === true
    });
    return output.toBuffer('image/png');
  }
  if (!regions) {
    const config = generateArtwork(seed, width, height, colors, settings, {
      includeGeometry,
      geometryLayout,
      mirrorX,
      sizeFrame,
      legSymmetry
    });
    const canvas = renderArtwork(config);
    return canvas.toBuffer('image/png');
  }
  // includeGeometry/geometryLayout here are already resolved against the FRONT placement's
  // own choice (see printful.js's includesGeometry/renderAndUploadPrintFiles) -- using them
  // for the source keeps the pocket a true continuation of whatever the front actually shows.
  const sourceConfig = generateArtwork(seed, sourceWidth, sourceHeight, colors, settings, {
    includeGeometry,
    geometryLayout,
    mirrorX,
    sizeFrame,
    legSymmetry
  });
  const sourceCanvas = renderArtwork(sourceConfig);
  const output = createCanvas(width, height);
  drawRegionsComposite(output.getContext('2d'), sourceCanvas, sourceWidth, sourceHeight, width, height, regions);
  return output.toBuffer('image/png');
}

// Byte-level mirror of lib/printful.js's drawRegionsComposite/drawRegion -- keep the two
// in sync so mockups and print files stay pixel-equivalent. Base layer (a cover-fit of
// the whole source) plus each region on top; a region's `src` window may extend past the
// source (the hoodie's solved window does -- see lib/printful.js's 388 pocketCrop
// comment), edge-clamped rather than left blank since sewing tolerance can pull ~an inch
// of that overhang into view.
function drawRegionsComposite(ctx, source, srcW, srcH, outW, outH, regions) {
  const coverScale = Math.max(outW / srcW, outH / srcH);
  const cw = srcW * coverScale;
  const ch = srcH * coverScale;
  ctx.drawImage(source, (outW - cw) / 2, (outH - ch) / 2, cw, ch);
  for (const { src, dest } of regions) {
    drawRegion(ctx, source, srcW, srcH, src, {
      x: dest.x * outW,
      y: dest.y * outH,
      w: dest.w * outW,
      h: dest.h * outH
    });
  }
}

function drawRegion(ctx, source, srcW, srcH, src, dest) {
  const winX = src.x * srcW;
  const winY = src.y * srcH;
  const winW = src.w * srcW;
  const winH = src.h * srcH;
  const scaleX = dest.w / winW;
  const scaleY = dest.h / winH;
  const cx0 = Math.max(0, Math.round(winX));
  const cy0 = Math.max(0, Math.round(winY));
  const cx1 = Math.min(srcW, Math.round(winX + winW));
  const cy1 = Math.min(srcH, Math.round(winY + winH));
  const cw = cx1 - cx0;
  const ch = cy1 - cy0;
  const offX = (cx0 - winX) * scaleX;
  const offY = (cy0 - winY) * scaleY;
  const ddx = dest.x + offX;
  const ddy = dest.y + offY;
  const cdw = cw * scaleX;
  const cdh = ch * scaleY;
  const px = (sx, sy, sw, sh, ddx0, ddy0, dw, dh) => {
    if (dw > 0.01 && dh > 0.01 && sw > 0 && sh > 0) ctx.drawImage(source, sx, sy, sw, sh, ddx0, ddy0, dw, dh);
  };
  px(cx0, cy0, cw, ch, ddx, ddy, cdw, cdh);
  px(cx0, cy0, cw, 1, ddx, dest.y, cdw, offY);
  px(cx0, cy1 - 1, cw, 1, ddx, ddy + cdh, cdw, dest.h - offY - cdh);
  px(cx0, cy0, 1, ch, dest.x, ddy, offX, cdh);
  px(cx1 - 1, cy0, 1, ch, ddx + cdw, ddy, dest.w - offX - cdw, cdh);
  px(cx0, cy0, 1, 1, dest.x, dest.y, offX, offY);
  px(cx1 - 1, cy0, 1, 1, ddx + cdw, dest.y, dest.w - offX - cdw, offY);
  px(cx0, cy1 - 1, 1, 1, dest.x, ddy + cdh, offX, dest.h - offY - cdh);
  px(cx1 - 1, cy1 - 1, 1, 1, ddx + cdw, ddy + cdh, dest.w - offX - cdw, dest.h - offY - cdh);
}

export { GENERATOR_VERSION };
