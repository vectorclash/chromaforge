import React from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';

// Light site chrome for the store/account/gallery routes. The studio ("/") renders
// outside this layout and keeps its dark full-bleed canvas. Because html/body are
// `overflow: hidden` (to lock the studio full-screen), this layout is its own scroll
// viewport (h-screen + overflow-y-auto) rather than relying on the document to scroll.
//
// This is the Phase 1 skeleton -- a real SiteHeader/SiteFooter and the clean-and-light
// design tokens land in the design-system phase. It exists now so routing is verifiable.
const navClass = ({ isActive }) =>
  'text-sm font-quicksand ' + (isActive ? 'text-neutral-900' : 'text-neutral-500 hover:text-neutral-900');

export default function SiteLayout() {
  return (
    <div className="h-screen overflow-y-auto bg-white text-neutral-900">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-neutral-200 bg-white/90 px-6 py-4 backdrop-blur">
        <Link to="/" className="font-quicksand text-lg font-bold tracking-tight">
          CHROMAFORGE
        </Link>
        <nav className="flex items-center gap-6">
          <NavLink to="/shop" className={navClass}>Shop</NavLink>
          <NavLink to="/gallery" className={navClass}>Gallery</NavLink>
          <NavLink to="/account" className={navClass}>Account</NavLink>
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-10">
        <Outlet />
      </main>
    </div>
  );
}
