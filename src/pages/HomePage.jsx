import React, { useRef, useState } from 'react';
import SiteHeader from '../components/ui/SiteHeader';
import SiteFooter from '../components/ui/SiteFooter';
import MiniGenerator from '../components/ui/MiniGenerator';
import Hero from '../components/home/Hero';
import AboutSection from '../components/home/AboutSection';
import GallerySection from '../components/home/GallerySection';
import ShopCarousel from '../components/home/ShopCarousel';

// The homepage: a vertically scrolling, multi-module page. The hero IS the live studio tool
// (not a preview -- see components/home/Hero.jsx); about/gallery/shop/footer follow below.
// Its own scroll container, not the document -- html/body are `overflow: hidden` site-wide
// to lock the studio's immersive full-bleed canvas, the same reason SiteLayout manages its
// own scroll viewport for the store routes. The nav lives here (not in SiteLayout) since "/"
// sits outside that layout.
export default function HomePage() {
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
