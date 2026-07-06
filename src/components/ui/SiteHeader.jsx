import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import ShirtIcon from '../buttons/ShirtIcon';
import HexagonIcon from '../buttons/HexagonIcon';
import HamburgerIcon from '../buttons/HamburgerIcon';
import FadeImage from './FadeImage';
import Wordmark from './Wordmark';
import MobileNav from './MobileNav';

// Site-wide sticky nav. Used both inside SiteLayout (store/account/gallery routes, always
// solid) and standalone on the homepage (HomePage.jsx owns scroll tracking on its own
// scroll container -- the document itself can't scroll, see tailwind.css -- and passes
// `transparent` while the hero showcase is still in view).
const navClass = ({ isActive }) =>
  'font-quicksand text-sm transition ' +
  (isActive ? 'text-text' : 'text-text-muted hover:text-text');

export default function SiteHeader({ transparent = false, overlay = false }) {
  const { user, avatarUrl } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <>
      <header
        className={
          (overlay ? 'fixed inset-x-0 top-0' : 'sticky top-0') +
          ' z-20 transition-colors shrink-0 ' +
          (transparent ? 'bg-transparent' : 'border-b border-hairline bg-ink-950/80 backdrop-blur')
        }
      >
        {/* Transparent state has nothing behind it but raw generated artwork, which can be
            any color/brightness -- this scrim guarantees the light nav text stays legible
            regardless, without it the nav is only readable when the art happens to be dark
            at the very top. */}
        {transparent && (
          <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/55 via-black/20 to-transparent" />
        )}
        <div className="relative mx-auto flex max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
          <Wordmark className="text-base sm:text-lg" onClick={() => setMenuOpen(false)} />
          {/* Below `sm`, this whole group collapses into just the hamburger -- Shop/Gallery/
              Account move into MobileNav's full-screen takeover instead. Four+ items at full
              width overlapped the wordmark on a phone-width screen; a small dropdown looked
              like an afterthought bolted onto a desktop nav rather than a real mobile nav. */}
          <nav className="hidden items-center gap-7 sm:flex">
            <NavLink to="/shop" className={({ isActive }) => navClass({ isActive }) + ' inline-flex items-center gap-1.5'}>
              <ShirtIcon size={15} /> Shop
            </NavLink>
            <NavLink to="/gallery" className={navClass}>Gallery</NavLink>
            <NavLink to="/account" className={({ isActive }) => navClass({ isActive }) + ' inline-flex items-center gap-2'}>
              <span className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-ink-700">
                {avatarUrl ? (
                  <FadeImage src={avatarUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <HexagonIcon size={12} className="text-text-secondary" />
                )}
              </span>
              {user ? 'Account' : 'Sign in'}
            </NavLink>
          </nav>
          {/* `sm:hidden` goes on this wrapper, not the button itself -- .cf-btn-icon's own
              unconditional `display: inline-flex` (components.css, imported after
              tailwind.css) wins the cascade over `sm:hidden`'s media-query rule when both
              land on the same element (equal specificity, later source order wins), which
              left the button visible at every width. Confirmed live: without this wrapper
              the hamburger never actually disappeared past the `sm` breakpoint. */}
          <span className="sm:hidden">
            <button
              type="button"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((prev) => !prev)}
              className="cf-btn-icon -mr-2"
            >
              <HamburgerIcon open={menuOpen} />
            </button>
          </span>
        </div>
      </header>
      <MobileNav open={menuOpen} onClose={() => setMenuOpen(false)} />
    </>
  );
}
