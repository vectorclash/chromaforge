import React, { Suspense, useEffect, useMemo } from 'react';
import { openFastWindow } from '../../render/renderQueue';
import { Outlet, useLocation } from 'react-router-dom';
import SiteHeader from './SiteHeader';
import SiteFooter from './SiteFooter';
import MiniGenerator from './MiniGenerator';
import RouteSkeleton from './RouteSkeleton';

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

  // A route change is a load of that page: its surfaces render on the fast pathway, the way
  // they did before stepwise rendering existed (render/renderQueue.js). Opened DURING RENDER,
  // deliberately: every effect -- including a class child's componentDidMount, which is where
  // DisplayCanvas starts its build -- runs before this component's own effects would, so an
  // effect here would open the window after the page had already asked for its renders.
  // Idempotent, so a repeated render (StrictMode, or any re-render) costs nothing.
  // `pathname` is the trigger, not an input -- the window reopens on each route change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useMemo(() => openFastWindow(), [pathname]);

  return (
    <div className="flex min-h-dvh flex-col bg-ink-950 text-text">
      <SiteHeader />
      {/* Keyed on the path so a navigation remounts the page, which is what a route change
          does anyway for distinct routes -- and which is what restarts each route's own
          entrance cascade (PageContainer's .intro-stagger).

          It deliberately carries NO animation of its own any more. It used to run
          --animate-page-enter, and measured on a shop -> product navigation that ran
          59ms -> 306ms on the Suspense fallback below, finishing half a second before the
          real page committed at 810ms: the site's one route transition was spent entirely on
          a loading skeleton, and every content route then arrived unanimated. Animating this
          element AND the sections inside it would also composite two blurs over one another.
          See tailwind.css. */}
      <main key={pathname} className="mx-auto w-full max-w-6xl flex-1 px-6 py-24">
        {/* Every route rendered here is React.lazy (see App.jsx) -- this Suspense boundary
            is what shows while its chunk downloads. Scoped to just <Outlet />, not the
            whole layout, so the header/footer/mini-generator never flash away mid-navigation.
            The fallback is a real per-route placeholder rather than a bare title, because
            `min-h-dvh` + `flex-1` puts the footer at the bottom of the VIEWPORT whenever this
            main is empty: a bare fallback showed the footer for the length of the chunk
            download and then threw it off screen the moment the page mounted. See
            RouteSkeleton. */}
        <Suspense fallback={<RouteSkeleton pathname={pathname} />}>
          <Outlet />
        </Suspense>
      </main>
      <SiteFooter />
      {/* Rendered once here (not per-page) so the ambient generator widget is present across
          every light route without each page needing to include it. Hidden below `sm` (by its own
          `hidden sm:block`) --
          MobileNav docks its own inline instance in the full-screen nav instead, so mobile
          doesn't get two competing generate/save surfaces on one small screen. */}
      <MiniGenerator />
    </div>
  );
}
