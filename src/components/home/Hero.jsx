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
    // bg-ink-900, not the page's own bg-ink-950 -- DisplayCanvas's root has no background
    // of its own, so while generating (HexagonLoader, before the canvas paints over it)
    // this section's background shows through. Left at ink-950 it was indistinguishable
    // from AboutSection right below, which inherits the same page-level ink-950.
    <section id="hero" className="relative h-screen w-full overflow-hidden bg-ink-900 [contain:layout]">
      <StudioPage />
    </section>
  );
}
