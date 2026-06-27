import React from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import ShirtIcon from '../buttons/ShirtIcon';

// Site-wide sticky nav. Used both inside SiteLayout (store/account/gallery routes, always
// solid) and standalone on the homepage (HomePage.jsx owns scroll tracking on its own
// scroll container -- the document itself can't scroll, see tailwind.css -- and passes
// `transparent` while the hero showcase is still in view, `sections` to add in-page anchor
// links to the homepage's own modules).
const navClass = ({ isActive }) =>
  'font-quicksand text-sm transition ' +
  (isActive ? 'text-text' : 'text-text-muted hover:text-text');

const sectionLinkClass = 'font-quicksand text-sm text-text-muted transition hover:text-text';

export default function SiteHeader({ transparent = false, sections = false, overlay = false }) {
  const { user } = useAuth();
  return (
    <header
      className={
        (overlay ? 'fixed inset-x-0 top-0' : 'sticky top-0') +
        ' z-20 transition-colors shrink-0 ' +
        (transparent ? 'bg-transparent' : 'border-b border-hairline bg-ink-950/80 backdrop-blur')
      }
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
        <Link to="/" className="font-display text-base tracking-tight text-text sm:text-lg">
          CHROMA<b className="font-black text-accent-soft">FORGE</b>
        </Link>
        <nav className="flex items-center gap-4 sm:gap-7">
          {/* Below `sm`, only the single most useful action (account/sign-in) stays visible
              -- four+ items at full width overlapped the wordmark on a phone-width screen. */}
          <span className="hidden items-center gap-7 sm:flex">
            {sections ? (
              <>
                <a href="#about" className={sectionLinkClass}>About</a>
                <a href="#gallery" className={sectionLinkClass}>Gallery</a>
                <a href="#shop" className={sectionLinkClass}>Shop</a>
              </>
            ) : (
              <>
                <NavLink to="/shop" className={({ isActive }) => navClass({ isActive }) + ' inline-flex items-center gap-1.5'}>
                  <ShirtIcon size={15} /> Shop
                </NavLink>
                <NavLink to="/gallery" className={navClass}>Gallery</NavLink>
              </>
            )}
          </span>
          <NavLink to="/account" className={navClass}>{user ? 'Account' : 'Sign in'}</NavLink>
        </nav>
      </div>
    </header>
  );
}
