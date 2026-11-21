// fetch() that tries again when the server turns a request away rather than failing it.
//
// Hostinger (LiteSpeed) answers a burst of requests from one visitor with 429 Too Many Requests.
// The shop asks for every product's instant-mockup files at once, and on 2026-11-21 two cards'
// manifests came back 429 and the cards stayed empty for the whole visit. So: 429, any 5xx and a
// network error are retried, with a growing, jittered wait (refused requests sent back in
// lockstep are refused again as a burst), honouring Retry-After when the server sends one.
// Any other answer, 404 included, is returned at once. After the last try it returns the last
// response (or throws the last error), exactly as fetch() would have.
//
// Plain module with no imports, so the instant-mockup worker can use it too.
const RETRY_STATUS = status => status === 429 || status >= 500;

export async function fetchRetry(url, { retries = 4, baseMs = 800 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let response = null;
    let error = null;
    try {
      response = await fetch(url);
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
