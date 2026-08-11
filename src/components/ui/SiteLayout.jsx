import React, { Suspense, useEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import SiteHeader from './SiteHeader';
import SiteFooter from './SiteFooter';
import MiniGenerator from './MiniGenerator';
import PageContainer from './PageContainer';

// Dark site chrome for the store/account/gallery routes -- the same ink base as the studio,
// using solid surfaces rather than glass (see SolidPanel). Because html/body are
// `overflow: hidden` (to lock the studio full-screen), this layout is its own scroll
// viewport rather than relying on the document to scroll.
//
// `h-dvh`, NOT `h-screen`: iOS Safari resolves `100vh` against the large viewport (toolbars
// retracted), so with the URL bar showing this container was taller than the visible area
// and Safari panned the layout viewport to compensate -- dragging the container's top, and
// with it SiteHeader's `sticky top-0` bar, up under the toolbar. HomePage never showed this
// because it renders the header with `overlay` (position: fixed, which resolves against the
// visual viewport); every route here uses the sticky variant. See also tailwind.css's
// html/body rule, which needed the same unit for the same reason.
export default function SiteLayout() {
  const scrollRef = useRef(null);
  const { pathname } = useLocation();

  // Because this div (not the document) is the scroll viewport, the browser's own
  // navigation scroll reset never applies -- without this, scrolling down the shop and
  // clicking a product opened the product page still scrolled to wherever the list was.
  useEffect(() => {
    scrollRef.current?.scrollTo(0, 0);
  }, [pathname]);

  return (
    <div ref={scrollRef} className="flex h-dvh flex-col overflow-y-auto bg-ink-950 text-text">
      <SiteHeader />
      {/* Keyed on the path so navigation replays the enter animation (and remounts the
          page, which is what a route change does anyway for distinct routes). */}
      <main key={pathname} className="animate-page-enter mx-auto w-full max-w-6xl flex-1 px-6 py-24">
        {/* Every route rendered here is React.lazy (see App.jsx) -- this Suspense boundary
            is what shows while its chunk downloads. Scoped to just <Outlet />, not the
            whole layout, so the header/footer/mini-generator never flash away mid-navigation. */}
        <Suspense fallback={<PageContainer title="Loading…" />}>
          <Outlet />
        </Suspense>
      </main>
      <SiteFooter />
      {/* Rendered once here (not per-page) so the ambient generator widget is present across
          every light route without each page needing to include it. Hidden below `sm` --
          MobileNav docks its own inline instance in the full-screen nav instead, so mobile
          doesn't get two competing generate/save surfaces on one small screen. */}
      <div className="hidden sm:block">
        <MiniGenerator />
      </div>
    </div>
  );
}
