import { lazy } from 'react';

// Vite builds each route as its own hashed chunk, and every push to master overwrites
// them on the server (deploy.yml's rsync --delete removes the previous build's chunks the
// moment a new one lands). A tab left open across a deploy that then client-side-navigates
// to a route it hasn't loaded yet fetches a chunk URL that no longer exists -- a 404 that
// surfaces as a render-phase throw during Suspense resolution, which the top-level
// ErrorBoundary (App.jsx) catches as a generic "something went wrong." A hard reload fixes
// it (the fresh page load picks up the current build's chunk references), so retry once
// automatically instead of showing the error screen. The sessionStorage guard caps this at
// one reload per chunk per tab -- if reloading doesn't fix it (a real network failure, not
// a stale chunk), the error re-throws into the ErrorBoundary as normal instead of
// reload-looping forever.
export default function lazyWithReload(importFn, chunkName) {
  return lazy(async () => {
    try {
      return await importFn();
    } catch (error) {
      const key = `cf-chunk-reload-${chunkName}`;
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, '1');
        window.location.reload();
        // Never resolves -- the reload navigates away before this matters.
        return new Promise(() => {});
      }
      sessionStorage.removeItem(key);
      throw error;
    }
  });
}
