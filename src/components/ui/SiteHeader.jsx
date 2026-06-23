import React from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import ShirtIcon from '../buttons/ShirtIcon';

// Persistent header for the light store chrome. The wordmark links back to "/" (the dark
// studio), which doubles as the "back to making art" path. The account link reflects auth
// state (Sign in vs Account) from AuthContext.
const navClass = ({ isActive }) =>
  'font-quicksand text-sm transition ' +
  (isActive ? 'text-neutral-900' : 'text-neutral-500 hover:text-neutral-900');

export default function SiteHeader() {
  const { user } = useAuth();
  return (
    <header className="sticky top-0 z-20 border-b border-neutral-200 bg-white/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link to="/" className="font-display text-lg font-black tracking-tight text-neutral-900">
          CHROMAFORGE
        </Link>
        <nav className="flex items-center gap-7">
          <NavLink to="/shop" className={({ isActive }) => navClass({ isActive }) + ' inline-flex items-center gap-1.5'}>
            <ShirtIcon size={15} /> Shop
          </NavLink>
          <NavLink to="/gallery" className={navClass}>Gallery</NavLink>
          <NavLink to="/account" className={navClass}>{user ? 'Account' : 'Sign in'}</NavLink>
        </nav>
      </div>
    </header>
  );
}
