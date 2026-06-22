import React from 'react';
import { Outlet } from 'react-router-dom';
import SiteHeader from './SiteHeader';
import SiteFooter from './SiteFooter';

// Light site chrome for the store/account/gallery routes. The studio ("/") renders outside
// this layout and keeps its dark full-bleed canvas. Because html/body are `overflow: hidden`
// (to lock the studio full-screen), this layout is its own scroll viewport rather than
// relying on the document to scroll.
export default function SiteLayout() {
  return (
    <div className="flex h-screen flex-col overflow-y-auto bg-white text-neutral-900">
      <SiteHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
        <Outlet />
      </main>
      <SiteFooter />
    </div>
  );
}
