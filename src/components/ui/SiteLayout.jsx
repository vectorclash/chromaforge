import React, { Suspense, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import SiteHeader from './SiteHeader';
import SiteFooter from './SiteFooter';
import MiniGenerator from './MiniGenerator';
import PageContainer from './PageContainer';

// Dark site chrome for the store/account/gallery routes -- the same ink base as the studio,
// using solid surfaces rather than glass (see SolidPanel).
//
// This scrolls the DOCUMENT, deliberately: it used to be its own `h-dvh overflow-y-auto`
// viewport, which is what kept iOS Safari's toolbar permanently expanded (it only minimizes
// for document scrolling). `min-h-dvh` so short pages still fill the screen -- a height
// FLOOR, never a fixed height, or the scroller comes back. See tailwind.css.
export default function SiteLayout() {
  const { pathname } = useLocation();

  // Restores the scroll reset a normal document navigation would give us -- React Router
  // changes the URL without unloading anything, so without this, scrolling down the shop
  // and clicking a product opened the product page still scrolled to the list's position.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return (
    <div className="flex min-h-dvh flex-col bg-ink-950 text-text">
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
