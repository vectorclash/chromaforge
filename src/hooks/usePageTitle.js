import { useEffect } from 'react';

// The SPA never changes document.title on its own, so without this every tab/bookmark/
// history entry reads the same site-wide title from index.html. Each page declares its own
// title; unmount restores the base so routes that don't call this (or a page navigating
// away mid-load) never show a stale one.
const BASE_TITLE = 'Chromaforge — generative art studio & print shop';

export function usePageTitle(title) {
  useEffect(() => {
    document.title = title ? `${title} · Chromaforge` : BASE_TITLE;
    return () => {
      document.title = BASE_TITLE;
    };
  }, [title]);
}
