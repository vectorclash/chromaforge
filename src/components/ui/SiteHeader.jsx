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
//
// Transition architecture, after several rounds of real-device jank ("flashes", "pops"):
// the solid bar is forced into its gradient look for as long as the mobile nav panel is
// open, regardless of scroll position (`showGradient`) -- a "bar stays, border fades"
// version was tried first (the bar's dark blur sitting flush against the panel's own dark
// background, only the hairline border fading), but in practice the bar still read as a
// visible band against the panel underneath it; forcing the full gradient look is what
// actually makes the panel look identical no matter where on the page it's opened from.
// Both layers below are always-mounted and animate ONLY opacity -- never toggled classes
// (an earlier `border-b`/`backdrop-blur` class-swap combined with a `transition-colors`
// background fade, so the border/blur snapped instantly while the color kept animating --
// that mismatch, not any timing issue, was the actual cause of an earlier "hard edge
// appears, pops transparent, then fades in" defect). Duration is fast (matching
// MobileNav's own close tween) specifically when reverting to solid after the menu closes,
// base everywhere else (opening the menu, or the scroll-driven crossfade).
const navClass = ({ isActive }) =>
  'font-quicksand text-sm transition ' +
  (isActive ? 'text-text' : 'text-text-muted hover:text-text');

export default function SiteHeader({ transparent = false, overlay = false }) {
  const { user, authResolved, avatarUrl } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const showGradient = transparent || menuOpen;
  const revertDuration = menuOpen ? 'var(--duration-base)' : 'var(--duration-fast)';
  return (
    <>
      <header
        className={
          (overlay ? 'fixed inset-x-0 top-0' : 'sticky top-0') +
          ' z-20 shrink-0'
        }
      >
        {/* Solid scrolled-state bar, crossfaded with the gradient scrim below via opacity
            on two always-mounted layers -- see the header comment above for why opacity,
            not class toggling. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 border-b border-hairline bg-ink-950/80 backdrop-blur transition-opacity"
          style={{ opacity: showGradient ? 0 : 1, transitionDuration: revertDuration }}
        />
        {/* Transparent state has nothing behind it but raw generated artwork, which can be
            any color/brightness -- this scrim guarantees the light nav text stays legible
            regardless, without it the nav is only readable when the art happens to be dark
            at the very top. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/55 via-black/20 to-transparent transition-opacity"
          style={{ opacity: showGradient ? 1 : 0, transitionDuration: revertDuration }}
        />
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
              {/* The word is withheld, not guessed, until auth resolves -- `user` is null both
                  when signed out and when Supabase has simply not answered yet, and a
                  returning visitor's token refresh is a network round trip (see
                  AuthContext's authResolved). Faded rather than unmounted, and both labels
                  are seven characters, so nothing moves either way. The link itself stays
                  live throughout: /account is the right destination in both states. */}
              <span
                className={
                  'transition-opacity duration-200 ' + (authResolved ? 'opacity-100' : 'opacity-0')
                }
              >
                {user ? 'Account' : 'Sign in'}
              </span>
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
