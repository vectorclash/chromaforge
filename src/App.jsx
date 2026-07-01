import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';

import { AuthProvider } from './context/AuthContext';
import { StudioProvider } from './context/StudioContext';
import SiteLayout from './components/ui/SiteLayout';
import HomePage from './pages/HomePage';
import StudioPage from './pages/StudioPage';
import ShopPage from './pages/ShopPage';
import ProductPage from './pages/ProductPage';
import GalleryPage from './pages/GalleryPage';
import AccountPage from './pages/AccountPage';
import CheckoutSuccessPage from './pages/CheckoutSuccessPage';
import NotFoundPage from './pages/NotFoundPage';

// "/" is the multi-module homepage (hero: a simplified Generate/Save view of the studio,
// with a "Go to studio" link; about; gallery/shop previews; footer). "/studio" is the full
// standalone tool (the original immersive canvas -- no site chrome, matches the homepage
// hero's own full-bleed/fixed positioning since it's the same DisplayCanvas underneath, just
// not contained to a 100vh section). The store/account/gallery routes render under
// SiteLayout's dark site chrome. Providers wrap everything so auth + the current design are
// reachable from any route -- see context/AuthContext and context/StudioContext.
export default function App() {
  return (
    <AuthProvider>
      <StudioProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/studio" element={<StudioPage compact={false} />} />
            <Route element={<SiteLayout />}>
              <Route path="/shop" element={<ShopPage />} />
              <Route path="/shop/:productId" element={<ProductPage />} />
              <Route path="/gallery" element={<GalleryPage />} />
              <Route path="/account" element={<AccountPage />} />
              <Route path="/checkout/success" element={<CheckoutSuccessPage />} />
              {/* Path-less parent (no prefix), so this wildcard catches any URL not matched
                  above -- including "/" and "/studio", except those are sibling routes at
                  the top level with more specific paths, which React Router always ranks
                  higher than a wildcard regardless of declaration order. */}
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </StudioProvider>
    </AuthProvider>
  );
}
