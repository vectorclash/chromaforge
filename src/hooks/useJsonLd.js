import { useEffect } from 'react';

// Injects a JSON-LD <script> into <head> for the current route (Product schema on
// ProductPage, Organization/WebSite on the homepage) -- these unlock rich results
// (price/availability snippets, sitelinks search box) in search engines that support
// them. `schema` is the plain object to serialize; pass null/undefined to skip (e.g.
// while a product is still loading). Removes the tag on unmount so a route change never
// leaves a stale schema describing the previous page.
export function useJsonLd(schema) {
  useEffect(() => {
    if (!schema) return undefined;
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.textContent = JSON.stringify(schema);
    document.head.appendChild(script);
    return () => script.remove();
  }, [schema]);
}
