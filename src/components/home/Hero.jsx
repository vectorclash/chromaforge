import React from 'react';
import StudioPage from '../../pages/StudioPage';

// The hero IS the studio (compact: Generate, Save, and a "Go to studio" link to the full
// tool at /studio -- see StudioPage's `compact` prop). `relative` is what DisplayCanvas's
// root positions against: compact renders it `absolute`, so it fills this 100vh section.
//
// `[contain:layout]` no longer carries that job. It used to: the root was `position: fixed`
// even here, and an ancestor with layout containment becomes the containing block for fixed
// descendants, which kept the tool inside this section instead of pinned over the whole
// document. That was swapped for plain absolute positioning on 2026-08-11 because a
// compositor-managed fixed layer jerked while scrolling on iOS Safari (see DisplayCanvas's
// root). The rule stays for the layout isolation it gives a full-viewport canvas, and
// because it still scopes any OTHER fixed descendant to this section.
export default function Hero() {
  return (
    // No background here -- DisplayCanvas's own root (fixed, fills this section via
    // contain:layout) now carries bg-ink-900 for the generating-state background, since
    // that's needed at /studio too, where there's no wrapping section like this one.
    <section id="hero" className="relative h-screen w-full overflow-hidden [contain:layout]">
      <StudioPage />
    </section>
  );
}
