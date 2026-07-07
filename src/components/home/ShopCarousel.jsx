import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { gsap } from 'gsap';
import Card from '../ui/Card';
import FadeImage from '../ui/FadeImage';
import ArrowIcon from '../buttons/ArrowIcon';
import { listCatalogProducts, STARTER_PRODUCT_IDS } from '../../lib/printful';
import { useScrollTriggerReveal } from '../../hooks/useScrollTriggerReveal';

const GAP_PX = 20; // matches gap-5
const PEEK_OPACITY = 0.5;
const PEEK_SCALE = 0.9;
const DURATION = 0.4;
const EASE = 'power2.inOut';

// visibleCount/peekFraction were fixed at 3 actives + a 0.4 peek regardless of viewport --
// fine at desktop widths, but on a phone the stage (after the two fixed-size arrow buttons
// and section padding eat into it) can be under 200px, and forcing 3 cards + 2 peeks into
// that produced genuinely unusable ~25-30px thumbnails. Scaled down by the same measured
// stage width cardWidth already depends on, so it reacts to the same resize/orientation
// changes with no separate breakpoint tracking needed.
function layoutParamsForWidth(available) {
  if (available < 420) return { visibleCount: 1, peekFraction: 0.12 };
  if (available < 700) return { visibleCount: 2, peekFraction: 0.22 };
  return { visibleCount: 3, peekFraction: 0.4 };
}

// Homepage preview of the shop -- a real, infinitely-looping carousel: 3 full-opacity
// cards in the middle, a dimmed/scaled-down sliver of the next/prev card peeking at each
// edge, prev/next arrows, no dead end at either side of the catalog.
//
// Looping is done by tripling the product list ([...products, ...products, ...products])
// and walking a `position` ref through the middle third, rather than literally wrapping an
// index -- animating "step past the last card" straight to "the first card" would otherwise
// require either jumping backwards across the whole strip (visually wrong) or faking it.
// With clones flanking the real list, stepping past the end just continues into the next
// copy (which renders pixel-identical content), and once a few steps into a clone third we
// snap the position back into the middle third with gsap.set (no animation, invisible)
// rather than ever rendering more than 3 copies or growing the clone count unboundedly.
//
// Position/animation state lives in refs, not React state -- it's driven by GSAP every
// frame, not by re-renders, matching the rest of the app's imperative-GSAP components
// (DisplayCanvas.jsx) rather than fighting React's render cycle for something React never
// needs to re-render for.
export default function ShopCarousel() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [cardWidth, setCardWidth] = useState(0);
  const [{ visibleCount, peekFraction }, setLayoutParams] = useState({ visibleCount: 3, peekFraction: 0.4 });

  // Depends on cardWidth too, not just loading: cards are sized off cardWidth (aspect-square,
  // so 0 width collapses their height to ~0 too), which only gets measured a tick *after*
  // loading turns false via the layout effect below. Building the ScrollTrigger against
  // that transient, collapsed-height layout made it fire at the wrong scroll position --
  // by the time the stage expanded to its real size, the already-calculated trigger point
  // was stale, so the reveal ended up playing while the section was still off-screen.
  const revealRef = useScrollTriggerReveal([loading, cardWidth]);
  const stageRef = useRef(null);
  const trackRef = useRef(null);
  const positionRef = useRef(0);
  const initializedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    listCatalogProducts()
      .then(all => {
        const byId = new Map(all.map(p => [p.id, p]));
        if (!cancelled) setProducts(STARTER_PRODUCT_IDS.map(id => byId.get(id)).filter(Boolean));
      })
      .catch(err => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const n = products.length;
  // Start in the middle copy, aligned with canonical product 0.
  if (n && !initializedRef.current) {
    positionRef.current = n;
    initializedRef.current = true;
  }

  // Sets (or animates) the track's x and every card's opacity/scale for a given position.
  // `x` is derived so card[position] (the first active slot) lands right after the left
  // peek sliver + a gap; everything else falls out of that by construction.
  function applyLayout(position, { animate, onComplete } = {}) {
    const track = trackRef.current;
    if (!track || !cardWidth) return;
    const step = cardWidth + GAP_PX;
    const peekWidth = peekFraction * cardWidth;
    const x = peekWidth + GAP_PX - position * step;
    if (animate) {
      gsap.to(track, { x, duration: DURATION, ease: EASE, onComplete, overwrite: 'auto' });
    } else {
      // killTweensOf first -- a snap correction (animate: false) runs inside the previous
      // step's onComplete, and gsap.set alone doesn't reliably win against a tween that's
      // still mid-render in the same frame, so the old value can flash back in afterward.
      gsap.killTweensOf(track);
      gsap.set(track, { x });
    }

    // Rapid clicks keep re-targeting the same handful of "near" elements (the window only
    // shifts by one card per step, so most of them stay near across several clicks) --
    // overwrite: 'auto' / killTweensOf is required here, otherwise each click stacks
    // another tween on top of whatever's still running on that element instead of
    // replacing it, and they fight.
    Array.from(track.children).forEach((el, i) => {
      const d = i - position;
      let opacity = 0;
      let scale = PEEK_SCALE;
      if (d >= 0 && d < visibleCount) {
        opacity = 1;
        scale = 1;
      } else if (d === -1 || d === visibleCount) {
        opacity = PEEK_OPACITY;
        scale = PEEK_SCALE;
      }
      // Only animate cards near the visible window -- anything farther out is already at
      // (or snapping to) opacity 0 and doesn't need a tween.
      const near = d >= -2 && d <= visibleCount + 1;
      // .cf-card has its own `transition: transform 0.2s` for its hover-lift effect
      // (components.css) -- since GSAP writes `transform` via inline style every frame,
      // the browser's CSS transition was *also* smoothing those writes on top of GSAP's
      // own easing, dragging scale ~200ms behind opacity/x and causing a visible pop when
      // the snap correction set it instantly. `transition: 'none'` here overrides that for
      // these elements specifically (their hover-lift becomes a snap instead of an ease,
      // an acceptable trade for cards GSAP is already constantly repositioning).
      if (animate && near) {
        gsap.to(el, { opacity, scale, duration: DURATION, ease: EASE, overwrite: 'auto', transition: 'none' });
      } else {
        gsap.killTweensOf(el);
        gsap.set(el, { opacity, scale, transition: 'none' });
      }
    });
  }

  // After a step settles, pull the position back into the middle third if it's drifted
  // into a clone copy -- invisible, since the clone is pixel-identical to the real thing.
  function snapIfDrifted() {
    if (!n) return;
    if (positionRef.current < n) {
      positionRef.current += n;
      applyLayout(positionRef.current, { animate: false });
    } else if (positionRef.current >= 2 * n) {
      positionRef.current -= n;
      applyLayout(positionRef.current, { animate: false });
    }
  }

  function goNext() {
    positionRef.current += 1;
    applyLayout(positionRef.current, { animate: true, onComplete: snapIfDrifted });
  }

  function goPrev() {
    positionRef.current -= 1;
    applyLayout(positionRef.current, { animate: true, onComplete: snapIfDrifted });
  }

  // Measure the stage (its width is CSS-driven via flex-1, not by us, to avoid a circular
  // dependency) and derive a card width that makes the peeks + 3 actives + gaps exactly
  // fill it, re-measuring on resize. Depends on `loading` because the stage <div> doesn't
  // exist (ref is null) until the product fetch resolves and that branch actually renders.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      const available = stage.getBoundingClientRect().width;
      const { visibleCount, peekFraction } = layoutParamsForWidth(available);
      // available = 2*peekFraction*cardWidth + visibleCount*cardWidth + (visibleCount+1)*GAP_PX
      // (visibleCount+1 gaps: peek-to-first-active, one between each pair of actives, last-active-to-peek)
      const w = (available - (visibleCount + 1) * GAP_PX) / (2 * peekFraction + visibleCount);
      setCardWidth(w);
      setLayoutParams({ visibleCount, peekFraction });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [loading]);

  // Snap to the current position whenever the measured card width changes (resize, or the
  // initial measurement) -- a layout correction, not a user-triggered navigation.
  useEffect(() => {
    if (!cardWidth) return;
    applyLayout(positionRef.current, { animate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardWidth, visibleCount, peekFraction, n]);

  if (!loading && !error && n === 0) return null;

  const repeated = n ? [...products, ...products, ...products] : [];
  const peekWidth = peekFraction * cardWidth;

  return (
    <section id="shop" ref={revealRef} className="mx-auto max-w-5xl px-4 py-24 sm:px-6">
      <div className="reveal-item mb-10 flex items-end justify-between gap-4">
        <div>
          <p className="font-quicksand text-xs font-bold uppercase tracking-[0.18em] text-accent">
            Print on demand
          </p>
          <h2 className="mt-3 font-display text-3xl text-text">Garments, printed to order</h2>
        </div>
        <Link to="/shop" className="font-quicksand text-sm text-text-muted transition hover:text-text">
          View full catalog &rarr;
        </Link>
      </div>

      {loading ? (
        <p className="text-text-secondary">Loading&hellip;</p>
      ) : error ? (
        <p className="text-accent">Couldn&rsquo;t load the shop.</p>
      ) : (
        <div className="reveal-item flex items-center gap-2 sm:gap-4">
          <button
            type="button"
            onClick={goPrev}
            aria-label="Previous products"
            className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full border border-hairline text-text-secondary transition hover:border-text-muted hover:text-text sm:h-14 sm:w-14"
          >
            <ArrowIcon direction="left" size={18} />
          </button>

          {/* Stage: wide enough for peek + 3 actives + peek. overflow-hidden lives here,
              sized so its edge falls exactly at the end of each peek sliver -- the
              gradients below cover only that sliver, never the 3 active cards. */}
          <div ref={stageRef} className="relative min-w-0 flex-1 overflow-hidden">
            <div
              className="pointer-events-none absolute inset-y-0 left-0 z-10 bg-gradient-to-r from-ink-950 to-ink-950/0"
              style={{ width: peekWidth || undefined }}
            />
            <div
              className="pointer-events-none absolute inset-y-0 right-0 z-10 bg-gradient-to-l from-ink-950 to-ink-950/0"
              style={{ width: peekWidth || undefined }}
            />

            <div ref={trackRef} className="flex gap-5">
              {repeated.map((product, i) => (
                <Card
                  key={`${i}-${product.id}`}
                  as={Link}
                  to={`/shop/${product.id}`}
                  className="group shrink-0"
                  style={{ width: cardWidth || undefined }}
                >
                  <div className="relative aspect-square overflow-hidden bg-ink-900">
                    <FadeImage
                      src={product.image}
                      alt={product.title}
                      className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.08]"
                    />
                    <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_top,rgba(0,0,0,0.92)_0%,rgba(0,0,0,0.55)_30%,rgba(0,0,0,0.18)_55%,transparent_75%)]" />
                    <div className="absolute inset-x-0 bottom-0 p-4">
                      {/* Hidden-until-hover only on devices with a hover-capable pointer --
                          on touch there's no real `:hover` to reveal this, so without the
                          media-query gate the product title itself (not just the CTA line)
                          would be permanently invisible on mobile instead of just
                          hover-deferred on desktop. */}
                      <div className="[@media(hover:hover)]:translate-y-9 transition-transform duration-300 ease-out [@media(hover:hover)]:group-hover:translate-y-0 [@media(hover:hover)]:group-focus-within:translate-y-0">
                        <h3 className="font-quicksand text-sm font-bold text-text">{product.title}</h3>
                        <p className="mt-1 text-sm text-text-secondary [@media(hover:hover)]:opacity-0 transition-opacity duration-300 ease-out [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100">
                          Apply this design &rarr;
                        </p>
                      </div>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={goNext}
            aria-label="Next products"
            className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full border border-hairline text-text-secondary transition hover:border-text-muted hover:text-text sm:h-14 sm:w-14"
          >
            <ArrowIcon direction="right" size={18} />
          </button>
        </div>
      )}
    </section>
  );
}
