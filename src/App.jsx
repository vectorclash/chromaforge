import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';

import { AuthProvider } from './context/AuthContext';
import { StudioProvider } from './context/StudioContext';
import SiteLayout from './components/ui/SiteLayout';
import StudioPage from './pages/StudioPage';
import ShopPage from './pages/ShopPage';
import ProductPage from './pages/ProductPage';
import GalleryPage from './pages/GalleryPage';
import AccountPage from './pages/AccountPage';

// "/" is the dark, full-bleed generative studio (the original canvas). The store/account/
// gallery routes render under SiteLayout's light site chrome. Providers wrap everything so
// auth + the current design are reachable from any route -- see context/AuthContext and
// context/StudioContext.
export default function App() {
  return (
    <AuthProvider>
      <StudioProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<StudioPage />} />
            <Route element={<SiteLayout />}>
              <Route path="/shop" element={<ShopPage />} />
              <Route path="/shop/:productId" element={<ProductPage />} />
              <Route path="/gallery" element={<GalleryPage />} />
              <Route path="/account" element={<AccountPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </StudioProvider>
    </AuthProvider>
  );
}
