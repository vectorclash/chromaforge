import React, { lazy } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';

import { AuthProvider } from './context/AuthContext';
import { StudioProvider } from './context/StudioContext';
import ErrorBoundary from './components/ui/ErrorBoundary';
import SiteLayout from './components/ui/SiteLayout';
import HomePage from './pages/HomePage';
import StudioPage from './pages/StudioPage';

// Lazy: none of these are needed for the initial "/" or "/studio" load, and each pulls in
// its own real weight (Printful catalog/mockup code, Supabase designs/checkout/profiles
// code) that a visitor who only ever looks at the homepage/studio shouldn't have to
// download. HomePage and StudioPage stay eager -- HomePage's Hero statically imports
// StudioPage (it *is* the compact studio), so splitting that pair apart would just
// duplicate the same DisplayCanvas/GSAP/createjs code across two chunks instead of
// removing it from either.
const ShopPage = lazy(() => import('./pages/ShopPage'));
const ProductPage = lazy(() => import('./pages/ProductPage'));
const GalleryPage = lazy(() => import('./pages/GalleryPage'));
const AccountPage = lazy(() => import('./pages/AccountPage'));
const CheckoutSuccessPage = lazy(() => import('./pages/CheckoutSuccessPage'));
const TermsPage = lazy(() => import('./pages/TermsPage'));
const PrivacyPage = lazy(() => import('./pages/PrivacyPage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));

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
