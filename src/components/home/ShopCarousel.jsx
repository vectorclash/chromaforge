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

// Drag/flick tuning. DRAG_THRESHOLD_PX is the tap-vs-drag disambiguation distance (same 8px
// TshirtPreview uses) -- below it, a touch is still a tap on the card's <Link>. FLICK_MS is
// how far ahead a release's velocity is projected, and FLICK_MAX_STEPS caps that projection
// so a hard swipe advances a couple of cards rather than an unbounded number.
const DRAG_THRESHOLD_PX = 8;
const FLICK_MS = 180;
const FLICK_MAX_STEPS = 2;

// A release settles on its own terms, NOT with the arrows' DURATION/EASE. Two reasons, and
// both are why a slow drag used to feel like the strip stalled before finishing the move:
// `power2.inOut` eases IN, so a track that was tracking the finger at speed stops dead and
// then has to accelerate again -- a visible velocity discontinuity at exactly the moment the
// motion should be continuous. `power3.out` leaves at the speed the drag had and only
// decelerates. And a fixed 0.4s spent the same time on a 0.1-slot correction as on a
// two-card flick, which is what made the short ones read as slow-motion; the duration now
// scales with how far there actually is to travel.
const SETTLE_EASE = 'power3.out';
const SETTLE_PER_STEP = 0.3;
const SETTLE_MIN = 0.16;
const SETTLE_MAX = 0.42;

// visibleCount/peekFraction were fixed at 3 actives + a 0.4 peek regardless of viewport --
// fine at desktop widths, but on a phone the stage (after the two fixed-size arrow buttons
// and section padding eat into it) can be under 200px, and forcing 3 cards + 2 peeks into
// that produced genuinely unusable ~25-30px thumbnails. Scaled down by the same measured
// stage width cardWidth already depends on, so it reacts to the same resize/orientation
// changes with no separate breakpoint tracking needed.
// Opacity/scale for a card sitting `d` slots from the first active slot -- a CONTINUOUS
// function of a fractional d, because during a drag the track sits between slots and every
// card is partway between states. Classifying by rounded slot instead made the edge cards
// jump their whole opacity/scale step at the halfway point, which reads as a pop rather
// than the strip sliding.
//
// `t` is how far outside the active window the card is: 0 anywhere inside it, 1 at the peek
// slot on either side, 2+ fully gone. Opacity ramps 1 -> PEEK_OPACITY over the first step
// and PEEK_OPACITY -> 0 over the second; scale ramps 1 -> PEEK_SCALE over the first and then
// holds, since an invisible card's scale doesn't matter and holding it means a card fading
// back in is already at peek size.
//
// The values at whole-number d are identical to the old discrete ones (t = 0 -> 1/1,
// t = 1 -> PEEK_OPACITY/PEEK_SCALE, t = 2 -> 0/PEEK_SCALE), so arrow navigation still tweens
// between exactly the same endpoints it did before.
function edgeFalloff(d, visibleCount) {
  const t = d < 0 ? -d : Math.max(0, d - (visibleCount - 1));
  const first = Math.min(1, t);
  const second = Math.max(0, Math.min(1, t - 1));
  return {
    opacity: (1 - first * (1 - PEEK_OPACITY)) * (1 - second),
    scale: 1 - first * (1 - PEEK_SCALE)
  };
}

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
  const dragRef = useRef(null);
  const draggedRef = useRef(false);

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
  function applyLayout(position, { animate, onComplete, duration = DURATION, ease = EASE } = {}) {
    const track = trackRef.current;
    if (!track || !cardWidth) return;
    const step = cardWidth + GAP_PX;
    const peekWidth = peekFraction * cardWidth;
    const x = peekWidth + GAP_PX - position * step;
    if (animate) {
      gsap.to(track, { x, duration, ease, onComplete, overwrite: 'auto' });
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
      const { opacity, scale } = edgeFalloff(d, visibleCount);
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
        gsap.to(el, { opacity, scale, duration, ease, overwrite: 'auto', transition: 'none' });
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

  // --- Touch/pointer dragging -------------------------------------------------------
  //
  // The track follows the finger 1:1 through a fractional position, then settles on the
  // nearest whole slot on release (plus a velocity projection, so a flick carries). The
  // infinite loop survives because the drift correction runs *during* the drag as well as
  // after it: whenever the live position wanders out of the middle third we shift it (and
  // the drag's own baseline) by a whole copy, which is invisible since the clone thirds
  // render pixel-identical content. Without that, a long drag would run off the end of the
  // tripled strip into empty space -- the arrows never could, since they only ever move one
  // slot before snapping back.
  //
  // Applied to every pointer type, not just touch: a mouse drag on the strip is the same
  // gesture and costs nothing extra, and the tap-vs-drag guard below keeps the cards' own
  // <Link> navigation intact either way.
  function shiftIntoMiddleThird(pos, drag) {
    let p = pos;
    while (p < n) {
      p += n;
      if (drag) drag.basePosition += n;
    }
    while (p >= 2 * n) {
      p -= n;
      if (drag) drag.basePosition -= n;
    }
    return p;
  }

  // Settle from wherever the drag left the track onto `target`, carrying the drag's motion
  // through rather than restarting it (see SETTLE_EASE above).
  function settleTo(target) {
    const distance = Math.abs(target - positionRef.current);
    const duration = Math.max(SETTLE_MIN, Math.min(SETTLE_MAX, distance * SETTLE_PER_STEP));
    positionRef.current = target;
    applyLayout(target, {
      animate: true,
      duration,
      ease: SETTLE_EASE,
      onComplete: snapIfDrifted
    });
  }

  function onPointerDown(e) {
    if (!n || !cardWidth) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    draggedRef.current = false;
    dragRef.current = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastT: e.timeStamp,
      velocity: 0,
      basePosition: positionRef.current,
      active: false
    };
  }

  function onPointerMove(e) {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.active) {
      // Horizontally dominant movement only -- a vertical swipe is the page scrolling
      // (the stage keeps `touch-action: pan-y` so the browser can still handle it).
      if (Math.abs(dx) < DRAG_THRESHOLD_PX || Math.abs(dx) <= Math.abs(dy)) return;
      drag.active = true;
      draggedRef.current = true;
      stageRef.current?.setPointerCapture?.(e.pointerId);
    }
    const dt = e.timeStamp - drag.lastT;
    if (dt > 0) drag.velocity = (e.clientX - drag.lastX) / dt;
    drag.lastX = e.clientX;
    drag.lastT = e.timeStamp;

    const step = cardWidth + GAP_PX;
    const pos = shiftIntoMiddleThird(drag.basePosition - dx / step, drag);
    positionRef.current = pos;
    applyLayout(pos, { animate: false });
  }

  function onPointerUp(e) {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.id) return;
    dragRef.current = null;
    stageRef.current?.releasePointerCapture?.(e.pointerId);
    if (!drag.active) return;

    const step = cardWidth + GAP_PX;
    // Dragging right (positive velocity) walks the position DOWN, hence the negation.
    const projected = -(drag.velocity * FLICK_MS) / step;
    const clamped = Math.max(-FLICK_MAX_STEPS, Math.min(FLICK_MAX_STEPS, projected));
    settleTo(Math.round(positionRef.current + clamped));
  }

  function onPointerCancel(e) {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.id) return;
    dragRef.current = null;
    if (!drag.active) return;
    settleTo(Math.round(positionRef.current));
  }

  // A drag that ends over a card would otherwise fire that card's <Link> click and navigate
  // to the product. Capture phase so it never reaches the Link; the flag resets on the next
  // pointerdown, so a genuine tap still navigates.
  function onClickCapture(e) {
    if (!draggedRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    draggedRef.current = false;
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
      <div className="reveal-item mb-10">
        <p className="font-quicksand text-xs font-bold uppercase tracking-[0.18em] text-accent">
          Print on demand
        </p>
        <h2 className="mt-3 font-display text-3xl font-bold text-text">Garments, printed to order</h2>
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
          <div
            ref={stageRef}
            className="relative min-w-0 flex-1 cursor-grab overflow-hidden active:cursor-grabbing"
            // pan-y: vertical swipes stay the browser's (page scroll), horizontal ones are
            // ours. Without it the browser claims the horizontal gesture too and the
            // pointermove stream stops mid-drag.
            style={{ touchAction: 'pan-y' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onClickCapture={onClickCapture}
            // Product images and the cards' <Link> are both natively draggable, and a mouse
            // drag on either hands the gesture to the browser's drag-and-drop (ghost image,
            // no further pointermove) instead of the carousel.
            onDragStart={e => e.preventDefault()}
          >
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
                    {/* -inset-px, not inset-0: the overlay and the image are the same computed box, but
                        an aspect-square card resolves to a FRACTIONAL height at most widths, and on a
                        high-DPR screen the two can rasterise to different device-pixel extents --
                        leaving a hairline of undarkened image along the bottom edge, intermittently,
                        depending on how each card's width happens to round. Bleeding the overlay a
                        pixel past its box costs nothing (the card's own overflow-hidden clips it) and
                        removes the whole class of mismatch rather than the bottom edge alone. */}
                    <div className="pointer-events-none absolute -inset-px bg-[linear-gradient(to_top,rgba(0,0,0,0.92)_0%,rgba(0,0,0,0.55)_30%,rgba(0,0,0,0.18)_55%,transparent_75%)]" />
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

      <div className="reveal-item mt-8 flex justify-center">
        <Link to="/shop" className="font-quicksand text-sm text-text-muted transition hover:text-text">
          View full catalog &rarr;
        </Link>
      </div>
    </section>
  );
}
