// Client-side cache for Printful catalog responses (lib/printful.js's listCatalogProducts /
// getCatalogProduct / getPrintfileSpecs). The catalog is near-static -- a hand-picked set of
// products whose specs change on Printful's timescale, not ours -- but every Shop/Product
// page mount was re-fetching hundreds of kB of variant JSON through the printful-catalog
// Edge Function, twice per mount under dev StrictMode. Confirmed via the function's live
// logs (2026-07-01) to be the dominant source of Supabase free-tier egress, dwarfing the
// actual mockup images (~92 kB each). Two layers:
//
// - in-flight dedupe: concurrent calls for the same key share one request. This is what
//   collapses StrictMode's double-mount fetches (they arrive ~200ms apart, well within one
//   round trip) and ProductPage's parallel product+specs pair staying independent.
// - localStorage with a TTL: survives reloads and dev hot-restarts, where the egress was
//   actually going. Caching is best-effort -- quota errors or unavailable storage degrade
//   to plain fetching, never to a thrown error.

const PREFIX = 'cf-catalog:';
export const DEFAULT_TTL_MS = 30 * 60 * 1000;

const inFlight = new Map();

function readFresh(key, ttlMs) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const { t, data } = JSON.parse(raw);
    if (Date.now() - t > ttlMs) {
      localStorage.removeItem(PREFIX + key);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function write(key, data) {
  const value = JSON.stringify({ t: Date.now(), data });
  try {
    localStorage.setItem(PREFIX + key, value);
  } catch {
    // Quota exceeded (or storage unavailable): drop our own entries and retry once --
    // never evict other features' keys, and never let caching break the actual fetch.
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith(PREFIX))
        .forEach(k => localStorage.removeItem(k));
      localStorage.setItem(PREFIX + key, value);
    } catch {
      /* give up -- caching is best-effort */
    }
  }
}

// Returns cached data for `key` if fresh, otherwise runs `fetcher` (sharing the promise
// with any concurrent caller of the same key) and caches its result.
export async function cachedFetch(key, fetcher, ttlMs = DEFAULT_TTL_MS) {
  const fresh = readFresh(key, ttlMs);
  if (fresh !== null) return fresh;
  if (inFlight.has(key)) return inFlight.get(key);
  const request = fetcher().then(
    data => {
      inFlight.delete(key);
      write(key, data);
      return data;
    },
    err => {
      inFlight.delete(key);
      throw err;
    }
  );
  inFlight.set(key, request);
  return request;
}
