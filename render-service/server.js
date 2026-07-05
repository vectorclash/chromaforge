// POST /render { seed, colors, settings?, width, height, generatorVersion } -> PNG bytes.
//
// Runs on Fly.io, called only by the render-print-file Supabase Edge Function -- this is
// real, paid-for compute, so it's gated by a shared secret (RENDER_SERVICE_KEY), not left
// open to the internet. Hard-fails on a generatorVersion mismatch rather than silently
// rendering an old design with new code (see render.js's header comment for why that
// guarantee matters here).
import http from 'node:http';
import { renderDesign, GENERATOR_VERSION } from './render.js';

const PORT = process.env.PORT || 8080;
const RENDER_SERVICE_KEY = process.env.RENDER_SERVICE_KEY;

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
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
    regions,
    sourceWidth,
    sourceHeight
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
      regions: regions || null,
      sourceWidth: sourceWidth || null,
      sourceHeight: sourceHeight || null
    });
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
    res.end(png);
  } catch (err) {
    console.error('render failed:', err);
    send(res, 500, { error: err.message || 'Render failed' });
  }
});

server.listen(PORT, () => {
  console.log(`render-service listening on :${PORT} (GENERATOR_VERSION=${GENERATOR_VERSION})`);
});
