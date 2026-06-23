import { useEffect, useState } from 'react';

// Crossfades between successive image URLs instead of popping: `shown` is the fully-visible
// layer, `incoming` fades in over it via CSS opacity, then gets promoted to `shown` once the
// transition finishes. Two stacked <img> layers, not one tag's src/opacity, because swapping
// a single <img>'s src can't visually cross-dissolve between old and new content -- it just
// pops once the new image decodes. Shared by MiniGenerator and SiteFooter so both fade the
// same way off the same StudioContext.previewUrl.
export function useCrossfadeImage(url, fadeMs = 450) {
  const [shown, setShown] = useState(null);
  const [incoming, setIncoming] = useState(null);
  const [fadingIn, setFadingIn] = useState(false);

  useEffect(() => {
    if (!url || url === shown || url === incoming) return;
    if (!shown) {
      // First-ever appearance (nothing to fade from) -- show it immediately.
      setShown(url);
      return;
    }
    setIncoming(url);
    setFadingIn(false);
    const raf = requestAnimationFrame(() => setFadingIn(true));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  useEffect(() => {
    if (!fadingIn || !incoming) return;
    const t = setTimeout(() => {
      setShown(incoming);
      setIncoming(null);
      setFadingIn(false);
    }, fadeMs);
    return () => clearTimeout(t);
  }, [fadingIn, incoming, fadeMs]);

  return { shown, incoming, fadingIn };
}
