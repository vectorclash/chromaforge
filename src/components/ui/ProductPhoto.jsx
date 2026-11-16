import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DURATION_SLOW } from '../../utils/motionTokens';
import { sweepIn } from '../../utils/printSweep';
import FadeImage from './FadeImage';
import { useStudio } from '../../context/StudioContext';
import { useInstantBlank, useInstantMockup } from '../../hooks/useInstantMockup';
import { useCrossfadeImage } from '../../hooks/useCrossfadeImage';
import { stableDefaultMockupOptions } from '../../lib/mockupDefaults';
import {
  hasInstantMockup,
  instantContentKey,
  instantMockupKey,
  peekInstantMockup,
  requestInstantBlank
} from '../../lib/instantMockupStore';
import FacetSwap from './FacetSwap';

// A product photo wearing the current design (an instant mockup, see lib/instantMockup.js) where
// the product has been calibrated, else Printful's stock photo.
//
// WHEN THE DESIGN CHANGES, ONLY THE PRINT CHANGES (Aaron, 2026-11-15: "it's weird that the shirt
// block just goes dark"). The model, the background and the shirt itself stay put: under the photo
// sits the same view with no print at all (the blank shirt, made from the calibration), so the print
// lifts off to that rather than the whole photo going dark; a band of the spectrum passes over the
// fabric while the new design is being made; and the new print is laid down top to bottom, like a
// print pass (Aaron's pick, 2026-11-15, over a plain fade and over facets). The first print arrives
// the same way, onto the blank garment. The timing is still the shared beat (CLAUDE.md, "Every
// surface showing the current active artwork reveals on the SAME shared timing"): the print starts
// leaving on the change itself.
//
// CHEAP ENOUGH FOR A GRID OF TWENTY (Aaron: the shop "kind of slows down a little bit"). Every
// animation here is a transform or an opacity (utils/printSweep.js, .fabric-shimmer), the shimmer
// exists only while it shows, and a card off the screen does not follow the design at all: it keeps
// the photo it has, makes nothing, and catches up -- with the ordinary transition -- when it next
// comes near the screen. Before, every card that had ever been on screen re-rendered and animated on
// every Generate, all twenty at once.
//
// `className` goes on the box that holds every layer, so a hover transform moves them together.
// Fills its nearest positioned ancestor (the card's aspect-square box).
//
// The shop cards pass only `product`. A product page passes the design it is showing, its live
// print options, whether a new print is on its way (`pending` -- there, until every view of the
// new design is made, so the photo and its thumbnails change together), `background={false}` (it
// is the thing the visitor is looking at, so its renders do not wait behind everything else), the
// `view` its filmstrip has selected, `lazy={false}`, and `facetOrigin`: a selector for the selected
// thumbnail, from which a change of ANGLE assembles in facets (FacetSwap), the transition this slot
// has always used between photos. Thumbnails pass `shimmer={false}`: at 64px the band is noise.
// Decoded images kept alive by URL, so the browser keeps their pixels (a blank garment the hero may
// switch to; see `warm`).
const DECODED = new Map();
function decodeAhead(url) {
  if (!url || DECODED.has(url)) return;
  const img = new Image();
  img.src = url;
  img.decode?.().catch(() => {});
  DECODED.set(url, img);
  if (DECODED.size > 24) DECODED.delete(DECODED.keys().next().value);
}

export default function ProductPhoto({
  product,
  className = '',
  design = undefined,
  options = undefined,
  pending = undefined,
  background = true,
  view = 'card',
  facetOrigin = null,
  shimmer = true,
  // The calibration configuration to show (the selected variant and stitch colour's); null is the
  // product's default, which is what the shop shows; false means none -- a selection with no
  // calibration, which shows Printful's stock photo.
  config = null,
  // Follow the design only while near the screen (the shop grid, the homepage carousel). The
  // product page passes false.
  lazy = true,
  // The product page's hero: the other views' photos and view ids, so switching to one has
  // nothing left to decode (FacetSwap's `warm`, and the blank garment under each).
  warm = null
}) {
  const calibrated = config !== false && hasInstantMockup(product.id);
  const { currentDesign, designChanging } = useStudio();
  const liveDesign = design === undefined ? currentDesign : design;
  const shownOptions = options === undefined ? stableDefaultMockupOptions(product.id) : options;
  const boxRef = useRef(null);
  // Whether the card is on or near the screen, kept up to date for as long as it is mounted. A photo
  // already made (the shop starts its first screenful before showing the grid) counts as near.
  const [near, setNear] = useState(
    () => !lazy || (calibrated && !!peekInstantMockup(instantMockupKey(product.id, liveDesign, shownOptions, view, config || null, !lazy)))
  );
  const [everNear, setEverNear] = useState(near);
  useEffect(() => {
    if (!lazy || !calibrated || !boxRef.current) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      setEverNear(true);
      return undefined;
    }
    const io = new IntersectionObserver(
      entries => {
        const on = entries.some(e => e.isIntersecting);
        setNear(on);
        if (on) setEverNear(true);
      },
      { rootMargin: '400px' }
    );
    io.observe(boxRef.current);
    return () => io.disconnect();
  }, [lazy, calibrated]);
  // The design this card shows: the live one while near, else the one it last showed.
  const heldDesignRef = useRef(liveDesign);
  if (near) heldDesignRef.current = liveDesign;
  const shownDesign = heldDesignRef.current;
  const productId = calibrated && everNear ? product.id : null;
  // The product page (the only caller that is not lazy) shows its photos at full detail.
  const { url, supported, settled } = useInstantMockup(productId, shownDesign, shownOptions, {
    view,
    background,
    config: config || null,
    detail: !lazy
  });
  const warmViews = warm?.views?.join('\n') || '';
  useEffect(() => {
    if (!warmViews || !productId) return;
    for (const v of warmViews.split('\n')) {
      requestInstantBlank(productId, v, config || null).then(b => decodeAhead(b?.blank));
    }
    // `warmViews` covers the views; config and product are fixed for one hero.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warmViews, productId]);
  // What the most recent change was: the same design and options from another angle ('view'), or
  // anything else ('content'). Kept across renders, because the new view's photo can land a render
  // or more after the view itself changed.
  //
  // A change of view counts as an angle switch only once THIS content has been shown (`shown`).
  // Picked before that -- right after a size change on the bandana, whose sizes are photographed
  // separately, before the new size's photos are made -- it is still the arrival of the new
  // content, and arrives the same way: the old photo leaves, the new view's blank garment waits,
  // the print sweeps on. Treated as an angle switch it showed the photo still in hand for the
  // last view (the OLD size's), and then the facets assembled the new one out of it (Aaron,
  // 2026-11-15: "the model shot from the different size will be there first then switch").
  const contentKey = `${config}|${instantContentKey(shownDesign, shownOptions)}`;
  const lastChangeRef = useRef({ contentKey, view, change: 'content', shown: false });
  if (lastChangeRef.current.contentKey !== contentKey) lastChangeRef.current = { contentKey, view, change: 'content', shown: false };
  else if (lastChangeRef.current.view !== view) {
    const { shown } = lastChangeRef.current;
    lastChangeRef.current = { contentKey, view, change: shown ? 'view' : 'content', shown };
  }
  const angleSwitch = lastChangeRef.current.change === 'view';
  const blank = useInstantBlank(supported ? productId : null, view, config || null);
  // A new print is on its way: from the change itself until THIS photo has landed (the design
  // changing ends when the studio's own small preview lands, before a product photo, which is two
  // or three more renders), or for as long as the caller says. An angle switch is not that: it
  // swaps in place, under the facets. Off the screen, nothing is on its way.
  const changing = near && (pending === undefined ? designChanging : pending);
  const waiting = supported && (changing || (!settled && !angleSwitch));
  const fade = useCrossfadeImage(url, { instant: angleSwitch, pending: waiting, reveal: 'sweep' });
  // Shown means ON SCREEN, settled: not merely made. A size whose photos were already made (cached
  // from an earlier visit) is ready the moment it is picked, while the old size's photo is still
  // fading out; counted as shown then, the next pick became an angle switch, which snapped that
  // fading photo back to full and assembled the new view out of it.
  if (settled && url && fade.shown === url && !fade.incoming && !fade.holding) lastChangeRef.current.shown = true;
  // The FIRST print arrives the same way: onto the blank garment, swept on. A photo already made
  // when the card mounted just appears.
  const [firstSweep, setFirstSweep] = useState(() => (url ? 'done' : 'pending'));
  useLayoutEffect(() => {
    const el = fade.shownRef.current;
    if (!fade.shown || !el || firstSweep !== 'pending') return undefined;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setFirstSweep('done');
      return undefined;
    }
    setFirstSweep('sweeping');
    return sweepIn(el, DURATION_SLOW * 1600, () => setFirstSweep('done'));
    // Once, on the first photo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fade.shown]);
  // The shimmer: while a print is leaving or being made (and before the first one), mounted only
  // then, and kept a moment after so it fades out rather than vanishing.
  const shimmerWanted =
    shimmer && !!blank?.mask && (fade.holding || (supported && firstSweep === 'pending' && !fade.shown));
  const [shimmerMounted, setShimmerMounted] = useState(false);
  const [shimmerOn, setShimmerOn] = useState(false);
  useEffect(() => {
    if (shimmerWanted) {
      setShimmerMounted(true);
      const raf = requestAnimationFrame(() => setShimmerOn(true));
      return () => cancelAnimationFrame(raf);
    }
    setShimmerOn(false);
    const t = setTimeout(() => setShimmerMounted(false), 300);
    return () => clearTimeout(t);
  }, [shimmerWanted]);
  if (!calibrated) return <FadeImage src={product.image} alt={product.title} className={`h-full w-full object-cover ${className}`} />;
  return (
    <div ref={boxRef} className={`absolute inset-0 ${className}`}>
      {/* The blank garment, from the first frame: what the first print is laid onto and what a
          leaving print reveals. A skeleton until it is made (FadeImage's own). */}
      <FadeImage src={blank?.blank} alt={fade.shown ? '' : product.title} draggable={false} className="h-full w-full object-cover" />
      {/* Both photo layers are print-pass wrappers (utils/printSweep.js); the crossfade hook fades
          the wrapper, and sweeps the incoming one in. */}
      {fade.shown && (
        <div ref={fade.shownRef} className="sweep-wrap">
          <img src={fade.shown} alt={product.title} draggable={false} />
        </div>
      )}
      {fade.incoming && (
        <div ref={fade.incomingRef} className="sweep-wrap">
          <img src={fade.incoming} alt="" draggable={false} />
        </div>
      )}
      {shimmerMounted && blank?.mask && (
        <div
          aria-hidden
          className={`fabric-shimmer ${shimmerOn ? 'is-on' : ''}`}
          style={{ WebkitMaskImage: `url(${blank.mask})`, maskImage: `url(${blank.mask})` }}
        >
          <span />
        </div>
      )}
      {facetOrigin && <FacetSwap src={fade.shown} enabled={angleSwitch} originSelector={facetOrigin} warm={warm?.urls} />}
    </div>
  );
}
