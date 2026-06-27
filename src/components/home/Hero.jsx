import React from 'react';
import StudioPage from '../../pages/StudioPage';

// The hero IS the studio (compact: Generate, Save, and a "Go to studio" link to the full
// tool at /studio -- see StudioPage's `compact` prop). `[contain:layout]` makes this section
// the containing block for DisplayCanvas's `position: fixed` root (a CSS containment quirk:
// an ancestor with `contain: layout` becomes the containing block for fixed-position
// descendants), so the tool fills this 100vh section instead of escaping to pin itself over
// the whole document regardless of scroll -- which is what `fixed` would otherwise do,
// breaking the rest of the homepage below it.
export default function Hero() {
  return (
    <section id="hero" className="relative h-screen w-full overflow-hidden [contain:layout]">
      <StudioPage />
    </section>
  );
}
