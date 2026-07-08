import React, { useRef, useState } from 'react';
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
// Its own scroll container, not the document -- html/body are `overflow: hidden` site-wide
// to lock the studio's immersive full-bleed canvas, the same reason SiteLayout manages its
// own scroll viewport for the store routes. The nav lives here (not in SiteLayout) since "/"
// sits outside that layout.
export default function HomePage() {
  usePageMeta({ path: '/' });
  useJsonLd(HOME_JSON_LD);
  const scrollRef = useRef(null);
  const [scrolled, setScrolled] = useState(false);

  const onScroll = () => setScrolled((scrollRef.current?.scrollTop ?? 0) > 40);

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="h-screen w-full overflow-y-auto bg-ink-950 text-text"
    >
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
