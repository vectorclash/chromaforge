import React from 'react';
import { Outlet } from 'react-router-dom';
import SiteHeader from './SiteHeader';
import SiteFooter from './SiteFooter';
import MiniGenerator from './MiniGenerator';

// Dark site chrome for the store/account/gallery routes -- the same ink base as the studio,
// using solid surfaces rather than glass (see SolidPanel). Because html/body are
// `overflow: hidden` (to lock the studio full-screen), this layout is its own scroll
// viewport rather than relying on the document to scroll.
export default function SiteLayout() {
  return (
    <div className="flex h-screen flex-col overflow-y-auto bg-ink-950 text-text">
      <SiteHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
        <Outlet />
      </main>
      <SiteFooter />
      {/* Rendered once here (not per-page) so the ambient generator widget is present across
          every light route without each page needing to include it. */}
      <MiniGenerator />
    </div>
  );
}
