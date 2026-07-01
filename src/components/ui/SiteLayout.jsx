import React, { useEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import SiteHeader from './SiteHeader';
import SiteFooter from './SiteFooter';
import MiniGenerator from './MiniGenerator';

// Dark site chrome for the store/account/gallery routes -- the same ink base as the studio,
// using solid surfaces rather than glass (see SolidPanel). Because html/body are
// `overflow: hidden` (to lock the studio full-screen), this layout is its own scroll
// viewport rather than relying on the document to scroll.
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
    <div ref={scrollRef} className="flex h-screen flex-col overflow-y-auto bg-ink-950 text-text">
      <SiteHeader />
      {/* Keyed on the path so navigation replays the enter animation (and remounts the
          page, which is what a route change does anyway for distinct routes). */}
      <main key={pathname} className="animate-page-enter mx-auto w-full max-w-6xl flex-1 px-6 py-24">
        <Outlet />
      </main>
      <SiteFooter />
      {/* Rendered once here (not per-page) so the ambient generator widget is present across
          every light route without each page needing to include it. */}
      <MiniGenerator />
    </div>
  );
}
