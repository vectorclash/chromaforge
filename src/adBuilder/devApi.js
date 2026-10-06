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
