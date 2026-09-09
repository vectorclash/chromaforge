import { useEffect } from 'react';

// The SPA never touches <head> on its own, so without this every route -- tab title,
// social share card, search-result snippet -- reads the same site-wide values from
// index.html. Each page declares its own title/description/image/path; unmount restores
// the base values so routes that don't call this (or a page navigating away mid-load)
// never leave a stale one behind for the next route to inherit.
const SITE_URL = 'https://chromaforge.app';
const BASE_TITLE = 'Chromaforge — generative art studio & print shop';
const BASE_DESCRIPTION =
  'A generative art studio in your browser. Craft seed-based artwork, save it to a shared gallery, and wear it — printed on demand.';
const BASE_IMAGE = `${SITE_URL}/og-image.jpg`;

function setMetaContent(selector, content) {
  const el = document.head.querySelector(selector);
  if (el) el.setAttribute('content', content);
}

function applyMeta({ title, description, image, url }) {
  document.title = title;
  setMetaContent('meta[name="description"]', description);
  setMetaContent('meta[property="og:title"]', title);
  setMetaContent('meta[property="og:description"]', description);
  setMetaContent('meta[property="og:image"]', image);
  setMetaContent('meta[property="og:url"]', url);
  setMetaContent('meta[name="twitter:title"]', title);
  setMetaContent('meta[name="twitter:description"]', description);
  setMetaContent('meta[name="twitter:image"]', image);
  let canonical = document.head.querySelector('link[rel="canonical"]');
  if (!canonical) {
    canonical = document.createElement('link');
    canonical.setAttribute('rel', 'canonical');
    document.head.appendChild(canonical);
  }
  canonical.setAttribute('href', url);
}

// `title`/`description`/`image` are page-specific overrides (all optional -- omit any of
// them to fall back to the site-wide default); `path` is the route's own path (e.g.
// '/shop') used to build the canonical/og:url. `noindex` is for auth-gated or transactional
// pages (account, checkout success, 404) that shouldn't show up in search results at all.
// Pass `null` (not just an empty object) to skip entirely -- for a page embedded inside
// another route (e.g. the homepage hero's compact studio) that must leave the parent
// route's own meta untouched rather than resetting it to the site-wide default.
export function usePageMeta(meta) {
  const { title, description, image, path = '/', noindex = false } = meta || {};
  useEffect(() => {
    if (!meta) return undefined;
    applyMeta({
      title: title ? `${title} · Chromaforge` : BASE_TITLE,
      description: description || BASE_DESCRIPTION,
      image: image || BASE_IMAGE,
      url: `${SITE_URL}${path}`
    });

    let robotsMeta;
    if (noindex) {
      robotsMeta = document.head.querySelector('meta[name="robots"]');
      if (!robotsMeta) {
        robotsMeta = document.createElement('meta');
        robotsMeta.setAttribute('name', 'robots');
        document.head.appendChild(robotsMeta);
      }
      robotsMeta.setAttribute('content', 'noindex');
    }

    return () => {
      applyMeta({ title: BASE_TITLE, description: BASE_DESCRIPTION, image: BASE_IMAGE, url: `${SITE_URL}/` });
      if (robotsMeta) robotsMeta.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, description, image, path, noindex]);
}
