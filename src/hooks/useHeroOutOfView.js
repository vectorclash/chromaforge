import { useEffect, useState } from 'react';

// True once the page's #hero section (if any) has scrolled out of view -- or immediately,
// if this route has no #hero at all. The homepage's hero IS the studio (see
// components/home/Hero.jsx), so MiniGenerator hides while it's in view (no point floating
// a second, smaller copy of the same tool on screen) and reveals once scrolled past it.
// Every other route (/shop, /gallery, /account) has no #hero, so this resolves to true
// immediately and stays there -- matches the widget's original always-visible behavior
// on those pages.
export function useHeroOutOfView() {
  const [outOfView, setOutOfView] = useState(true);

  useEffect(() => {
    const hero = document.querySelector('#hero');
    if (!hero) {
      setOutOfView(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      setOutOfView(entry.intersectionRatio < 0.85);
    }, {
      threshold: [0.85]
    });
    observer.observe(hero);
    return () => observer.disconnect();
  }, []);

  return outOfView;
}
