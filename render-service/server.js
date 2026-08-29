// POST /render { seed, colors, settings?, width, height, generatorVersion } -> PNG bytes.
//
// Runs on Fly.io, called only by the render-print-file Supabase Edge Function -- this is
// real, paid-for compute, so it's gated by a shared secret (RENDER_SERVICE_KEY), not left
// open to the internet. Hard-fails on a generatorVersion mismatch rather than silently
// rendering an old design with new code (see render.js's header comment for why that
// guarantee matters here).
import http from 'node:http';
import { renderDesign, GENERATOR_VERSION } from './render.js';
import { hatWrapSourceSize, hatWrapDiscSourceSize, legWrapSourceSize } from './generated/render-lib.js';

const PORT = process.env.PORT || 8080;
const RENDER_SERVICE_KEY = process.env.RENDER_SERVICE_KEY;

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  // Pre-warm hook: Fly wakes a scaled-to-zero machine on ANY incoming request, so the
  // frontend fires a throttled no-cors ping here the moment purchase intent appears
  // (first mockup render -- see lib/printful.js's warmRenderService) and the cold-start
  // is already paid by the time Buy Now actually needs /render. Deliberately unauthed:
  // it does zero work, and an unauthenticated request already woke the machine anyway
  // (auth is checked in here, after Fly has started us) -- this adds no new surface.
  if (req.method === 'GET' && req.url === '/warmup') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'POST' || req.url !== '/render') {
    send(res, 404, { error: 'Not found' });
    return;
  }

  if (!RENDER_SERVICE_KEY || req.headers['x-render-key'] !== RENDER_SERVICE_KEY) {
    send(res, 401, { error: 'Unauthorized' });
    return;
  }

  let body = '';
  for await (const chunk of req) body += chunk;

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    send(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const {
    seed,
    colors,
    settings,
    width,
    height,
    generatorVersion,
    includeGeometry,
    geometryLayout,
    mirrorX,
    sizeFrame,
    legSymmetry,
    regions,
    sourceWidth,
    sourceHeight,
    hatWrap,
    legWrap
  } = payload;
  if (!seed || !width || !height) {
    send(res, 400, { error: 'Missing required fields: seed, width, height' });
    return;
  }
  // Optional regions composite (see render.js), for placements that continue a larger
  // panel's artwork (hoodie/zip-hoodie pocket). A region's src window may overhang the
  // source canvas slightly (the hoodie's solved window does; overhang is edge-clamped --
  // see render.js), but only slightly: bounds here are sanity limits, not [0,1].
  // Validated because this is paid compute: reject rather than render something
  // malformed, and keep both the source and output canvases from exceeding what this
  // machine is sized for. Same MAX_AXIS/MAX_PIXELS reasoning as render-print-file's own
  // width/height check below (a real bug there: a per-axis-only cap rejected several real
  // Printful printfiles that are legitimately elongated but not actually huge in total
  // pixels) -- kept in sync here even though no current pocketCrop product (388, 717) is
  // anywhere near either limit, so a future one doesn't quietly hit the same flaw.
  const MAX_AXIS = 15000;
  const MAX_PIXELS = 90_000_000;
  if (regions != null) {
    const isFrac = n => typeof n === 'number' && Number.isFinite(n) && n >= -0.5 && n <= 1.5;
    const validRect = r =>
      r && isFrac(r.x) && isFrac(r.y) && typeof r.w === 'number' && typeof r.h === 'number' && r.w > 0 && r.h > 0;
    const valid =
      Array.isArray(regions) &&
      regions.length > 0 &&
      regions.length <= 8 &&
      regions.every(r => validRect(r.src) && validRect(r.dest)) &&
      Number.isInteger(sourceWidth) &&
      Number.isInteger(sourceHeight) &&
      sourceWidth > 0 &&
      sourceHeight > 0 &&
      sourceWidth <= MAX_AXIS &&
      sourceHeight <= MAX_AXIS &&
      width <= MAX_AXIS &&
      height <= MAX_AXIS &&
      sourceWidth * sourceHeight <= MAX_PIXELS &&
      width * height <= MAX_PIXELS;
    if (!valid) {
      send(res, 400, {
        error: 'Invalid regions/sourceWidth/sourceHeight: expected an array of { src, dest } fraction rects and valid source dims'
      });
      return;
    }
  }
  // Optional hat-piece wrap (see render.js and src/render/hatWrap.js). Validated for the same
  // reason regions is -- this is paid compute, and the geometry drives the size of two SOURCE
  // canvases this machine has to hold alongside the output, so a malformed radius is a memory
  // question, not just a wrong picture. Fractions of the printfile's WIDTH: cy legitimately runs
  // past 1 (the crown's arc centre sits far above the sheet) and radii legitimately exceed 1 (the
  // crown's arc is wider than the sheet), so the bounds here are generous sanity limits rather
  // than [0,1]. The half-angles are radians and cannot exceed a half turn.
  if (hatWrap != null) {
    const num = (n, lo, hi) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
    const sector = p =>
      p && num(p.cx, -1, 2) && num(p.cy, -20, 20) && num(p.rIn, 0, 20) && num(p.rOut, 0, 20) &&
      p.rOut > p.rIn && num(p.half, 0.01, Math.PI);
    const valid =
      hatWrap.disc && num(hatWrap.disc.cx, -1, 2) && num(hatWrap.disc.cy, -20, 20) &&
      num(hatWrap.disc.r, 0.001, 5) && sector(hatWrap.crown) && sector(hatWrap.brim) &&
      width <= MAX_AXIS && height <= MAX_AXIS && width * height <= MAX_PIXELS;
    if (!valid) {
      send(res, 400, {
        error: 'Invalid hatWrap: expected { disc: { cx, cy, r }, crown, brim } as fractions of the printfile width'
      });
      return;
    }
    // The sources are derived from this geometry rather than sent, so their cost has to be
    // checked after resolving it -- a plausible-looking radius can still ask for a canvas this
    // machine cannot hold.
    const src = hatWrapSourceSize(hatWrap, width);
    const disc = hatWrapDiscSourceSize(hatWrap, width);
    if (
      src.width < 1 || src.height < 1 || disc.width < 1 ||
      src.width > MAX_AXIS || src.height > MAX_AXIS || disc.width > MAX_AXIS ||
      src.width * src.height > MAX_PIXELS || disc.width * disc.height > MAX_PIXELS
    ) {
      send(res, 400, { error: 'Invalid hatWrap: the implied source canvases exceed this service\'s limits' });
      return;
    }
  }
  // Optional leg wrap (see render.js and src/render/legWrap.js). Validated for the same reason
  // hatWrap is: it drives the size of a SOURCE canvas this machine has to hold alongside the
  // output, so a malformed fraction is a memory question and not just a wrong picture. Both are
  // fractions of the printfile's width; shift is bounded below 0.5 because a half-sheet slide
  // would carry each half clean past the centre.
  if (legWrap != null) {
    const num = (n, lo, hi) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
    const valid =
      num(legWrap.shift, 0, 0.49) && num(legWrap.width, 0.05, 2) &&
      width <= MAX_AXIS && height <= MAX_AXIS && width * height <= MAX_PIXELS;
    if (!valid) {
      send(res, 400, {
        error: 'Invalid legWrap: expected { shift, width } as fractions of the printfile width'
      });
      return;
    }
    const src = legWrapSourceSize(legWrap, width, height);
    if (
      src.width < 1 || src.height < 1 || src.width > MAX_AXIS || src.height > MAX_AXIS ||
      src.width * src.height > MAX_PIXELS
    ) {
      send(res, 400, { error: 'Invalid legWrap: the implied source canvas exceeds this service\'s limits' });
      return;
    }
  }
  if (generatorVersion !== GENERATOR_VERSION) {
    send(res, 422, {
      error: `generatorVersion mismatch: design is v${generatorVersion}, this service renders v${GENERATOR_VERSION}`
    });
    return;
  }

  try {
    const png = await renderDesign({
      seed,
      colors: colors || [],
      width,
      height,
      settings: settings || null,
      includeGeometry: includeGeometry !== false,
      geometryLayout: geometryLayout || null,
      mirrorX: mirrorX === true,
      sizeFrame: sizeFrame || null,
      legSymmetry: legSymmetry === true,
      regions: regions || null,
      sourceWidth: sourceWidth || null,
      sourceHeight: sourceHeight || null,
      hatWrap: hatWrap || null,
      legWrap: legWrap || null
    });
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
    res.end(png);
  } catch (err) {
    console.error('render failed:', err);
    send(res, 500, { error: err.message || 'Render failed' });
  } finally {
    // Real OOM traced (2026-07-05) to a warm machine handling two large sequential renders
    // (mesh shorts' front then back placement, both ~49Mpx) back to back -- @napi-rs/canvas's
    // buffers are native (external) memory that V8's own GC heuristics don't reliably collect
    // between requests on their own, so the first render's buffers could still be resident
    // when the second one's peak hit. Forcing a collection right after every response (this
    // request's own canvases are now unreachable, nothing else references them) trades a
    // small per-request pause for not carrying a large render's memory into the next one.
    // Requires --expose-gc (see Dockerfile).
    if (global.gc) global.gc();
  }
});

server.listen(PORT, () => {
  console.log(`render-service listening on :${PORT} (GENERATOR_VERSION=${GENERATOR_VERSION})`);
});
