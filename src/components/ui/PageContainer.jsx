import React, { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { routeIntroClaimed } from '../../utils/routeIntro';

// Standard page wrapper for content routes: an optional display title/subtitle header
// over the page body. Keeps headings consistent across Shop/Gallery/Account.
//
// It is also where the route entrance cascade lives: `.intro-stagger` gives each direct
// child -- breadcrumb, header, then whatever sections the page renders -- its own delay, so
// a route assembles top-to-bottom instead of appearing in one frame. See the long note in
// tailwind.css for why the container is the right place for it and why it needs no trigger.
// A page section that runs its own cascade over a list marks itself `.intro-skip` and takes
// its delays from utils/routeIntro.js instead.
export default function PageContainer({
  title,
  subtitle,
  actions,
  breadcrumb,
  introKind = 'content',
  children
}) {
  const { pathname } = useLocation();
  // Read once, during render, so it still sees a claim the outgoing tree is about to release
  // -- see claimRouteIntro. A route whose fallback already showed this chrome enters nothing:
  // the header is the one already on screen, and the only genuinely new content (a card grid)
  // carries .intro-item and animates on its own regardless. The kind is what keeps that from
  // over-reaching: a placeholder's claim silences a SECOND placeholder, never the real page
  // that replaces it.
  const [alreadyEntered] = useState(() => routeIntroClaimed(pathname, introKind));

  return (
    <div className={alreadyEntered ? undefined : 'intro-stagger'}>
      {breadcrumb && <div className="mb-4">{breadcrumb}</div>}
      {(title || subtitle || actions) && (
        <header className="mb-10 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
          <div>
            {title && (
              <h1 className="font-display text-4xl font-black tracking-tight text-text">
                {title}
              </h1>
            )}
            {subtitle && <p className="mt-2 text-text-secondary">{subtitle}</p>}
          </div>
          {actions && <div className="order-first shrink-0 sm:order-none">{actions}</div>}
        </header>
      )}
      {children}
    </div>
  );
}
