// fetch() that tries again when the server turns a request away rather than failing it.
//
// Hostinger answers a burst of requests from one visitor with 429 Too Many Requests -- and its CDN
// (hCDN) then CACHES that 429, per edge server and per Accept-Encoding, under the file's own
// one-hour Cache-Control, and serves it to every visitor routed through that edge. Measured
// 2026-11-21: the shop fetches every product's instant-mockup files at once; some manifests came
// back 429 with an `age` of ~19 minutes, the bare URL stayed 429 for 100+ seconds of polling (with
// `cache: 'no-store'`, so not the browser's cache), while the same file with any query string was
// 200 every time. So a retry of the same URL can never succeed: each retry carries a unique `cb`
// query parameter, which the CDN treats as a different object and fetches from the origin.
//
// 429, any 5xx and a network error are retried, with a growing, jittered wait (refused requests
// sent back in lockstep are refused again as a burst), honouring Retry-After when the server sends
// one. Any other answer, 404 included, is returned at once. After the last try it returns the last
// response (or throws the last error), exactly as fetch() would have.
//
// Plain module with no imports, so the instant-mockup worker can use it too.
const RETRY_STATUS = status => status === 429 || status >= 500;

function bust(url, attempt) {
  const u = new URL(url, globalThis.location?.href);
  u.searchParams.set('cb', `${attempt}-${Math.random().toString(36).slice(2, 8)}`);
  return u.href;
}

export async function fetchRetry(url, { retries = 4, baseMs = 800 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let response = null;
    let error = null;
    try {
      response = await fetch(attempt === 0 ? url : bust(url, attempt));
    } catch (err) {
      error = err;
    }
    if (response && !RETRY_STATUS(response.status)) return response;
    if (attempt >= retries) {
      if (response) return response;
      throw error;
    }
    const after = Number(response?.headers.get('Retry-After'));
    const wait = after > 0 && after <= 30 ? after * 1000 : baseMs * 2 ** attempt;
    await new Promise(resolve => setTimeout(resolve, wait * (0.6 + Math.random() * 0.8)));
  }
}
