import { useEffect, useState } from 'react';

/**
 * Whether the floating mini generator should show: only once the page's #hero (the full
 * studio, homepage only) is out of view, or immediately on a route without one.
 *
 * The footer used to hide it too, because the footer carried a second MiniGenerator of its
 * own. It no longer does -- the floating widget flies into the footer's dock slot itself (see
 * useDockMorph in MiniGenerator) -- so the footer is no longer this hook's business.
 */
export function useWidgetVisibility() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const hero = document.querySelector('#hero');
    if (!hero) {
      setVisible(true);
      return undefined;
    }
    // Start hidden when a hero exists, so the widget doesn't flash before the first report.
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.intersectionRatio < 0.85),
      { threshold: [0.85] }
    );
    observer.observe(hero);
    return () => observer.disconnect();
  }, []);

  return visible;
}
