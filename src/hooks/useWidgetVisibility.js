import { useEffect, useState } from 'react';

/**
 * Hook to manage the visibility of the floating mini generator widget.
 * The widget is visible ONLY when:
 * 1. The hero section (#hero) is out of view (or doesn't exist on the page).
 * 2. The footer (footer) is out of view (so the widget "docks" into the footer).
 */
export function useWidgetVisibility() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const hero = document.querySelector('#hero');
    const footer = document.querySelector('footer');

    let heroVisible = !!hero; // Start as true if hero exists, so we don't flash the widget
    let footerVisible = false;

    const updateVisibility = () => {
      setVisible(!heroVisible && !footerVisible);
    };

    const observers = [];

    // Observe Hero
    if (hero) {
      const heroObserver = new IntersectionObserver(
        ([entry]) => {
          heroVisible = entry.intersectionRatio >= 0.85;
          updateVisibility();
        },
        { threshold: [0.85] }
      );
      heroObserver.observe(hero);
      observers.push(heroObserver);
    } else {
      heroVisible = false;
    }

    // Observe Footer
    if (footer) {
      const footerObserver = new IntersectionObserver(
        ([entry]) => {
          footerVisible = entry.isIntersecting;
          updateVisibility();
        },
        { threshold: 0 } // Trigger as soon as the top of the footer enters the viewport
      );
      footerObserver.observe(footer);
      observers.push(footerObserver);
    }

    updateVisibility();

    return () => {
      observers.forEach(obs => obs.disconnect());
    };
  }, []);

  return visible;
}
