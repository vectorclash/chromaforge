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
import {
  HERO_REVEAL_END,
  heroIntroEnabled,
  heroRevealStarted,
  subscribeHeroReveal
} from '../utils/heroIntro';

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
  // Decided once, on mount, and never updated: the hero's entrance either plays for this
  // page view or it does not, and a scroll a moment later must not retract it mid-animation.
  // See utils/heroIntro.js for why a restored scroll position opts out.
  const [playIntro, setPlayIntro] = useState(heroIntroEnabled);
  // The nav is the hero's entrance too, but the moment it arrives on is owned by DisplayCanvas
  // -- the hero holds until its artwork paints, and that event is three components away with
  // no path up here. utils/heroIntro.js carries the signal, the same way useScrollLock carries
  // a lock to the effects that have to sit one out.
  const [heroRevealed, setHeroRevealed] = useState(heroRevealStarted);
  useEffect(() => subscribeHeroReveal(() => setHeroRevealed(true)), []);

  // Drop the entrance once it has finished, so the header is not left carrying an animation
  // class for the rest of the visit -- the same tidy-up DisplayCanvas does for its own panel.
  // Nothing moves when it goes: fade-slide-up's `backwards` fill holds no end state.
  useEffect(() => {
    if (!heroRevealed || !playIntro) return undefined;
    const timer = setTimeout(() => setPlayIntro(false), HERO_REVEAL_END + 100);
    return () => clearTimeout(timer);
  }, [heroRevealed, playIntro]);

  // A browser back-restore cannot be seen at mount: the document has to have its full height
  // before the engine can scroll to the saved offset, so React renders first and the scroll
  // lands a frame or two later. Measured -- a load that ends up at y=1500 still reads
  // scrollY 0 when HomePage first renders. That matters for the NAV specifically, because it
  // is fixed and therefore on screen at every scroll position: without this it would slide
  // itself in over a mid-page view, which is the exact thing the entrance exists to stop.
  // Withdrawing the flag mid-animation is safe -- the classes come off and the header is left
  // in its resting state, which is where the animation was heading anyway.
  useEffect(() => {
    if (!playIntro) return undefined;
    const cancelIfRestored = () => {
      if (window.scrollY > 40) setPlayIntro(false);
    };
    const raf = requestAnimationFrame(cancelIfRestored);
    // Two checks: the frame after mount catches a same-frame restore, the timeout catches a
    // slower one (an image or font settling the layout first). Both are inside the entrance's
    // own length, so a cancellation always arrives before the sequence would have finished.
    const timer = setTimeout(cancelIfRestored, 250);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [playIntro]);

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
      <SiteHeader
        transparent={!scrolled}
        overlay
        intro={!playIntro ? 'off' : heroRevealed ? 'reveal' : 'hold'}
      />
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
