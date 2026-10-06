// Dev-server routes for the local ad builder (ad-builder.html, src/adBuilder). Registered from
// vite.config.mjs with apply: 'serve', so none of this exists in a production build -- the
// builder is a local tool and is never deployed.
//
//   /orrery/*            Orrery's source, served raw from the sibling repo (ORRERY_DIR, default
//                        ../orrery). The builder renders its music with Orrery's own export
//                        renderer in an iframe, so the music code has one home: that repo.
//   POST /__ads/fetch    { url } -> downloads a Printful mockup photo into .ads/media. Printful's
//                        mockup URLs expire after a few days, and an image from another origin
//                        taints the canvas the exporter reads frames from.
//   POST /__ads/upload   raw image or audio bytes -> .ads/media (your own photos, rendered music)
//   GET  /__ads/media/*  those files
//   GET  /__ads/ads      saved ads; GET/POST /__ads/ads/<name> load or save one
//
// Every POST must carry a non-simple Content-Type (JSON, image/*, audio/*), which makes a
// cross-site request preflight -- and nothing here answers a preflight -- so another website
// open in the same browser cannot drive these routes.
import { createHash } from 'node:crypto';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';

const MIME = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.wav': 'audio/wav'
};
const EXT_FOR_TYPE = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'audio/wav': '.wav' };
// Printful's API and CDN, and the S3 bucket its mockup generator writes to.
const FETCHABLE_HOST = /(^|\.)(printful\.com|amazonaws\.com)$/;
const MAX_BYTES = 40 * 1024 * 1024;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

function send(res, status, body, type = 'application/json') {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-store');
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('Too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Resolves `rel` inside `root`, or null if it would escape it.
function inside(root, rel) {
  const full = path.resolve(root, '.' + path.sep + rel);
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

async function serveFile(res, file) {
  try {
    const data = await fs.readFile(file);
    send(res, 200, data, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

async function storeMedia(mediaDir, bytes, type) {
  const ext = EXT_FOR_TYPE[type];
  if (!ext) throw new Error(`Unsupported type ${type}`);
  const name = createHash('sha256').update(bytes).digest('hex').slice(0, 24) + ext;
  await fs.mkdir(mediaDir, { recursive: true });
  const file = path.join(mediaDir, name);
  if (!existsSync(file)) await fs.writeFile(file, bytes);
  return `/__ads/media/${name}`;
}

export default function adBuilderDev({ root = process.cwd() } = {}) {
  const orreryDir = path.resolve(root, process.env.ORRERY_DIR || '../orrery');
  const adsDir = path.join(root, '.ads');
  const mediaDir = path.join(adsDir, 'media');
  const savedDir = path.join(adsDir, 'ads');

  return {
    name: 'chromaforge-ad-builder-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, 'http://localhost');
        const p = decodeURIComponent(url.pathname);
        try {
          if (p.startsWith('/orrery/') && req.method === 'GET') {
            const file = inside(orreryDir, p.slice('/orrery/'.length));
            if (!file) return send(res, 403, { error: 'Forbidden' });
            if (!existsSync(orreryDir)) return send(res, 404, { error: `Orrery not found at ${orreryDir}` });
            return serveFile(res, file);
          }
          if (!p.startsWith('/__ads/')) return next();

          if (p.startsWith('/__ads/media/') && req.method === 'GET') {
            const file = inside(mediaDir, p.slice('/__ads/media/'.length));
            return file ? serveFile(res, file) : send(res, 403, { error: 'Forbidden' });
          }

          if (p === '/__ads/fetch' && req.method === 'POST') {
            if (req.headers['content-type'] !== 'application/json') return send(res, 415, { error: 'JSON only' });
            const { url: target } = JSON.parse((await readBody(req)).toString('utf8'));
            const t = new URL(target);
            if (t.protocol !== 'https:' || !FETCHABLE_HOST.test(t.hostname)) {
              return send(res, 400, { error: `Not a Printful image: ${t.hostname}` });
            }
            const r = await fetch(t);
            if (!r.ok) return send(res, 502, { error: `Printful answered ${r.status}` });
            const type = (r.headers.get('content-type') || '').split(';')[0].trim();
            const bytes = Buffer.from(await r.arrayBuffer());
            return send(res, 200, { url: await storeMedia(mediaDir, bytes, type) });
          }

          if (p === '/__ads/upload' && req.method === 'POST') {
            const type = (req.headers['content-type'] || '').split(';')[0].trim();
            if (!EXT_FOR_TYPE[type]) return send(res, 415, { error: `Unsupported type ${type}` });
            return send(res, 200, { url: await storeMedia(mediaDir, await readBody(req), type) });
          }

          if (p === '/__ads/ads' && req.method === 'GET') {
            const files = existsSync(savedDir) ? await fs.readdir(savedDir) : [];
            const ads = await Promise.all(
              files
                .filter(f => f.endsWith('.json'))
                .map(async f => ({ name: f.slice(0, -5), savedAt: (await fs.stat(path.join(savedDir, f))).mtimeMs }))
            );
            return send(res, 200, ads.sort((a, b) => b.savedAt - a.savedAt));
          }

          const m = /^\/__ads\/ads\/([^/]+)$/.exec(p);
          if (m) {
            if (!NAME.test(m[1])) return send(res, 400, { error: 'Bad name' });
            const file = path.join(savedDir, `${m[1]}.json`);
            if (req.method === 'GET') return serveFile(res, file);
            if (req.method === 'POST') {
              if (req.headers['content-type'] !== 'application/json') return send(res, 415, { error: 'JSON only' });
              const body = await readBody(req);
              JSON.parse(body.toString('utf8'));
              await fs.mkdir(savedDir, { recursive: true });
              await fs.writeFile(file, body);
              return send(res, 200, { ok: true });
            }
          }
          return send(res, 404, { error: 'Not found' });
        } catch (e) {
          return send(res, 500, { error: e.message });
        }
      });
    }
  };
}
