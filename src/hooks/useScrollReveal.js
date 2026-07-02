import { useEffect, useRef, useState } from 'react';

// Fires once, the first time the element scrolls into view -- for homepage sections below
// the hero that currently just "are there" with no entrance at all, unlike the card grids
// (GallerySection/ShopCarousel), whose own animate-fade-slide-up happens to coincide with
// their async data arriving rather than a deliberate scroll trigger. Respects
// prefers-reduced-motion by starting already-revealed, since there's nothing worth
// observing for if the transition would be near-instant anyway.
export function useScrollReveal() {
  const ref = useRef(null);
  const [revealed, setRevealed] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );

  useEffect(() => {
    if (revealed) return; // already revealed (reduced-motion), or already triggered once
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setRevealed(true);
          observer.disconnect();
        }
      },
      { threshold: 0.2 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [revealed]);

  return [ref, revealed];
}
