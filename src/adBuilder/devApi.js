// The dev server's ad-builder routes (scripts/ad-builder-dev.mjs).

async function json(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

// A Printful mockup photo, downloaded into .ads/media. Returns its local URL.
export async function keepPrintfulImage(url) {
  const res = await fetch('/__ads/fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  });
  return (await json(res)).url;
}

// Your own photo or a rendered track, stored in .ads/media. Returns its local URL.
/** @param {Blob} blob */
export async function keepFile(blob) {
  const res = await fetch('/__ads/upload', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
  return (await json(res)).url;
}

export async function listSavedAds() {
  return json(await fetch('/__ads/ads'));
}

export async function loadAd(name) {
  return json(await fetch(`/__ads/ads/${encodeURIComponent(name)}`));
}

export async function saveAd(name, ad) {
  const res = await fetch(`/__ads/ads/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ad, null, 2)
  });
  return json(res);
}

// Lowercase, hyphenated, what the dev server accepts as a file name.
export function adSlug(s) {
  return (
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'ad'
  );
}

// Stock-video masters (scripts/ad-builder-stock.mjs): 16-bit frames piped into ffmpeg, into .ads/stock.
const stockPost = async (action, body, type, id) =>
  json(
    await fetch(`/__ads/stock/${action}${id ? `?id=${id}` : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': type },
      body
    })
  );
/** @param {{ name: string, width: number, height: number, fps: number, format: string }} o */
export const stockStart = o => stockPost('start', JSON.stringify(o), 'application/json');
/** @param {string} id @param {Uint16Array<ArrayBuffer>} rgb48 */
// Sent as a Blob, not the typed array itself: Chromium uploads a large ArrayBuffer body very slowly
// (a 50 MB 4K frame took 1.85s; the same bytes as a Blob ~35ms -- WebKit is fast either way).
export const stockFrame = (id, rgb48) => stockPost('frame', new Blob([rgb48]), 'application/octet-stream', id);
export const stockFinish = id => stockPost('finish', '{}', 'application/json', id);
export const stockCancel = id => stockPost('cancel', '{}', 'application/json', id);
