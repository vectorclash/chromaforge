import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '../tailwind.css';
import '../styles/components.css';
import './adBuilder.css';
import { AuthProvider } from '../context/AuthContext';
import { StudioProvider } from '../context/StudioContext';
import AdBuilder from './AdBuilder';

// The app's own providers, so the builder uses the real pieces: your signed-in session (on this
// origin -- sign in at /account on the same dev server), your saved designs, and the product
// page's mockup pipeline. AuthProvider needs a router for its redirects.
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <StudioProvider>
          <AdBuilder />
        </StudioProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
