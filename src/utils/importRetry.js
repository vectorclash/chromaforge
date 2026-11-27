// Loading the 3D code, and telling apart the ways starting the 3D view can fail.
//
// three.js and the tunnel scene are lazy chunks, fetched the first time 3D is used. That fetch
// can fail on a phone for reasons that have nothing to do with WebGL: a dropped connection, the
// CDN answering a burst with a (cached) 429, or a tab opened before a deploy asking for a chunk
// the deploy has since deleted (see lazyWithReload.js). Every one of those used to reach the
// studio as "Animations need WebGL" (Aaron, 2026-11-27: the alert on his phone, gone after a
// couple of refreshes).
//
// importRetry tries a failed chunk load again after a short wait. It retries the SAME import
// rather than a cache-busted URL the way fetchRetry does: three.js is a chunk shared with the
// tunnel scene, and importing it under a second URL would give the page two copies of three
// whose objects do not recognise each other. A stale-deploy 404 cannot be fixed by retrying
// at all; it is tagged 'load' so the studio can say "refresh" instead of blaming WebGL.

const CHUNK_LOAD = [
  /dynamically imported module/i, // Chrome: "Failed to fetch dynamically imported module: ..."
  /importing a module script failed/i, // Safari
  /error loading dynamically imported module/i, // Firefox
  /unable to preload/i, // Vite's __vitePreload (a CSS or modulepreload dependency)
  /loading (css )?chunk/i
];

export function isChunkLoadError(err) {
  const message = String(err?.message ?? err ?? '');
  return CHUNK_LOAD.some(pattern => pattern.test(message));
}

// Records which stage failed on the error itself: 'load' (the code never arrived), 'webgl' (no
// WebGL context could be made) or 'scene' (the scene failed to build). Wraps the error if it
// cannot take the property.
/** @returns {Error & { cfKind?: string }} */
export function tagError(err, kind) {
  /** @type {Error & { cfKind?: string }} */
  const error = err instanceof Error ? err : new Error(String(err));
  try {
    if (!error.cfKind) error.cfKind = kind;
    return error;
  } catch {
    /** @type {Error & { cfKind?: string }} */
    const wrapped = new Error(error.message);
    wrapped.cause = error;
    wrapped.cfKind = kind;
    return wrapped;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function importRetry(load, { retries = 2, baseMs = 700 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await load();
    } catch (err) {
      if (!isChunkLoadError(err)) throw err;
      if (attempt >= retries) throw tagError(err, 'load');
      // Growing and jittered, so a refused burst is not sent back in lockstep
      await sleep(baseMs * 2 ** attempt * (0.7 + Math.random() * 0.6));
    }
  }
}

// What the studio tells someone whose 3D view would not start, by the stage that failed.
export function threeDFailureMessage(err) {
  switch (err?.cfKind) {
    case 'load':
      return 'The 3D view didn’t finish loading. Check your connection, then refresh the page to try again.';
    case 'webgl':
      return 'Your browser couldn’t start WebGL, which animations need. Closing other tabs and refreshing may help.';
    default:
      return 'The animation couldn’t be built. Refresh the page to try again.';
  }
}
