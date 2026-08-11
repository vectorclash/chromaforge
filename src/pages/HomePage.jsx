import React, { useEffect, useState } from 'react';
import SiteHeader from '../components/ui/SiteHeader';
import SiteFooter from '../components/ui/SiteFooter';
import MiniGenerator from '../components/ui/MiniGenerator';
import Hero from '../components/home/Hero';
import AboutSection from '../components/home/AboutSection';
import GallerySection from '../components/home/GallerySection';
import ShopCarousel from '../components/home/ShopCarousel';
import { usePageMeta } from '../hooks/usePageMeta';
import { useJsonLd } from '../hooks/useJsonLd';

// WebSite (unlocks a sitelinks search box in results, though there's no on-site search yet
// to back it) + Organization (ties the brand name/logo to the domain for knowledge-panel-
// style results) -- the two schema types that make sense for a homepage with no single
// "product" of its own.
const HOME_JSON_LD = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      name: 'Chromaforge',
      url: 'https://chromaforge.app/'
    },
    {
      '@type': 'Organization',
      name: 'Chromaforge',
      url: 'https://chromaforge.app/',
      logo: 'https://chromaforge.app/apple-touch-icon.png'
    }
  ]
};

// The homepage: a vertically scrolling, multi-module page. The hero IS the live studio tool
// (not a preview -- see components/home/Hero.jsx); about/gallery/shop/footer follow below.
// The nav lives here (not in SiteLayout) since "/" sits outside that layout.
//
// Scrolls the DOCUMENT. This used to be its own `h-screen overflow-y-auto` viewport, which
// is why iOS Safari's toolbar never minimized here; see tailwind.css before reintroducing a
// container scroller. Hero stays `h-screen` (i.e. `lvh`) rather than `dvh` on purpose -- it
// is the height the hero settles at once that toolbar retracts, and it does not resize
// mid-scroll the way `dvh` would.
export default function HomePage() {
  usePageMeta({ path: '/' });
  useJsonLd(HOME_JSON_LD);
  const [scrolled, setScrolled] = useState(false);

  // Drives SiteHeader's transparent -> solid crossfade. On the document now, not a
  // container's onScroll: scroll events do not bubble, so nothing would reach a React
  // handler on this div once the document is what moves.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener('scroll', onScroll, { passive: true });
    // The page can already be scrolled on mount (a back-navigation restore, or a reload
    // partway down), in which case no scroll event is coming to set the initial state.
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="w-full bg-ink-950 text-text">
      <SiteHeader transparent={!scrolled} overlay />
      <Hero />
      <AboutSection />
      <GallerySection />
      <ShopCarousel />
      <SiteFooter />
      {/* Hidden below `sm` -- MobileNav docks its own inline instance in the full-screen
          nav instead (same reasoning as SiteLayout's own copy of this). Without this, the
          floating widget's z-30 sat above MobileNav's z-10 and showed through on top of
          the open nav panel on mobile. */}
      <div className="hidden sm:block">
        <MiniGenerator />
      </div>
    </div>
  );
}
