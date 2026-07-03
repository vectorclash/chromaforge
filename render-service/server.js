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

  const { seed, colors, settings, width, height, generatorVersion, isFrontPlacement } = payload;
  if (!seed || !width || !height) {
    send(res, 400, { error: 'Missing required fields: seed, width, height' });
    return;
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
      isFrontPlacement: isFrontPlacement !== false
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
