import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { gsap } from 'gsap';

import { AuthProvider } from './context/AuthContext';
import { StudioProvider } from './context/StudioContext';
import ErrorBoundary from './components/ui/ErrorBoundary';
import SiteLayout from './components/ui/SiteLayout';
import HomePage from './pages/HomePage';
import StudioPage from './pages/StudioPage';
import lazyWithReload from './utils/lazyWithReload';

// Lazy: none of these are needed for the initial "/" or "/studio" load, and each pulls in
// its own real weight (Printful catalog/mockup code, Supabase designs/checkout/profiles
// code) that a visitor who only ever looks at the homepage/studio shouldn't have to
// download. HomePage and StudioPage stay eager -- HomePage's Hero statically imports
// StudioPage (it *is* the compact studio), so splitting that pair apart would just
// duplicate the same DisplayCanvas/GSAP/createjs code across two chunks instead of
// removing it from either.
//
// lazyWithReload (not React.lazy directly): a stale chunk reference from before a deploy
// otherwise 404s straight into the top-level ErrorBoundary -- see that util's header.
const ShopPage = lazyWithReload(() => import('./pages/ShopPage'), 'ShopPage');
const ProductPage = lazyWithReload(() => import('./pages/ProductPage'), 'ProductPage');
const GalleryPage = lazyWithReload(() => import('./pages/GalleryPage'), 'GalleryPage');
const AccountPage = lazyWithReload(() => import('./pages/AccountPage'), 'AccountPage');
const CheckoutSuccessPage = lazyWithReload(
  () => import('./pages/CheckoutSuccessPage'),
  'CheckoutSuccessPage'
);
const TermsPage = lazyWithReload(() => import('./pages/TermsPage'), 'TermsPage');
const PrivacyPage = lazyWithReload(() => import('./pages/PrivacyPage'), 'PrivacyPage');
const NotFoundPage = lazyWithReload(() => import('./pages/NotFoundPage'), 'NotFoundPage');

// "/" is the multi-module homepage (hero: a simplified Generate/Save view of the studio,
// with a "Go to studio" link; about; gallery/shop previews; footer). "/studio" is the full
// standalone tool (the original immersive canvas -- no site chrome, matches the homepage
// hero's own full-bleed/fixed positioning since it's the same DisplayCanvas underneath, just
// not contained to a 100vh section). The store/account/gallery routes render under
// SiteLayout's dark site chrome (which owns the Suspense boundary for the lazy pages above --
// see SiteLayout.jsx). Providers wrap everything so auth + the current design are
// reachable from any route -- see context/AuthContext and context/StudioContext.
//
// BrowserRouter wraps AuthProvider (not the other way around) so AuthContext can call
// useNavigate itself -- needed to route a landed password-recovery link straight to
// /account regardless of which route it happened to redirect back to (see AuthContext's
// recoveryMode handling).
export default function App() {
  // The CSS-only prefers-reduced-motion rule in tailwind.css doesn't reach GSAP -- it
  // animates inline styles from JS, not via CSS transitions/animations. gsap.matchMedia()
  // is GSAP's own documented mechanism for this: scaling gsap.globalTimeline (a page-wide
  // singleton) instead of editing every individual gsap.to()/from()/fromTo() call's
  // duration across DisplayCanvas's panel morphs, ShopCarousel's loop, and ProductPage's
  // TextPlugin scramble keeps every onComplete-driven sequencing those already rely on
  // intact, while making the motion itself imperceptibly fast -- same "still fires
  // completion, just ~instant" approach the CSS side already takes (0.01ms, not 0).
  // Registered once here, not inside DisplayCanvas -- DisplayCanvas unmounts on most route
  // changes (only "/" and "/studio" render it), but the user's OS-level preference doesn't
  // change with the route, so this needs to outlive any single component's lifecycle.
  useEffect(() => {
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: reduce)', () => {
      gsap.globalTimeline.timeScale(100);
      return () => gsap.globalTimeline.timeScale(1);
    });
    return () => mm.revert();
  }, []);

  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <StudioProvider>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/studio" element={<StudioPage compact={false} />} />
              <Route element={<SiteLayout />}>
                <Route path="/shop" element={<ShopPage />} />
                <Route path="/shop/:productId" element={<ProductPage />} />
                <Route path="/gallery" element={<GalleryPage />} />
                <Route path="/account" element={<AccountPage />} />
                <Route path="/checkout/success" element={<CheckoutSuccessPage />} />
                <Route path="/terms" element={<TermsPage />} />
                <Route path="/privacy" element={<PrivacyPage />} />
                {/* Path-less parent (no prefix), so this wildcard catches any URL not matched
                    above -- including "/" and "/studio", except those are sibling routes at
                    the top level with more specific paths, which React Router always ranks
                    higher than a wildcard regardless of declaration order. */}
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
          </StudioProvider>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
