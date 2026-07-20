import React, { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { gsap, TextPlugin } from 'gsap/all';
import PageContainer from '../components/ui/PageContainer';
import Button from '../components/ui/Button';
import FadeImage from '../components/ui/FadeImage';
import HexagonLoader from '../components/HexagonLoader';
import { useCrossfadeImage } from '../hooks/useCrossfadeImage';
import { DURATION_SLOW_MS as CROSSFADE_MS } from '../utils/motionTokens';
import {
  getCatalogProduct,
  getPrintfileSpecs,
  getMockupConfigForProduct,
  getGeometryPlacementOptions,
  getStitchColorOption,
  hasTwoLegCanvas,
  resolvePlacementEntries,
  renderAndUploadPrintFiles,
  renderPrintFileStrategy
} from '../lib/printful';
import { getThumbnailUrl } from '../lib/designs';
import { createCheckoutSession } from '../lib/checkout';
import { guessShippingRegion } from '../lib/regionGuess';
import { useStudio } from '../context/StudioContext';
import { isSameDesign } from '../render/designSettings';
import { useAuth } from '../context/AuthContext';
import { useMockup, BUSY_STATUSES } from '../hooks/useMockup';
import ArtworkPickerModal from '../components/ui/ArtworkPickerModal';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import { usePageMeta } from '../hooks/usePageMeta';
import { useJsonLd } from '../hooks/useJsonLd';

gsap.registerPlugin(TextPlugin);

const STATUS_LABEL = {
  rendering: 'Rendering design…',
  creating: 'Sending to Printful…',
  polling: 'Generating mockup…',
  queued: 'Waiting for capacity…'
};

// Mockup generation is a multi-step round trip through Printful's servers that can run
// well past its typical 30-90s (the track jacket's automatic retry, see useMockup, can
// roughly double it) -- silence past that estimate reads as "broken," so this narrates
// progress the whole way through. Voice is deliberately a bit Data-from-TNG: precise,
// faintly amused by the concept of waiting, never breaks character -- but the composure
// thins as elapsed time grows, from crisp status reports early on to thinly-veiled concern
// by the later thresholds. Ordered by elapsed seconds; statusNarration below picks the
// latest threshold that's been reached, then one line at random from that threshold's
// `texts` (memoized per run so it doesn't reshuffle every second -- see narrationPicksRef),
// so repeat/long generations don't recite the exact same script twice, and gracefully holds
// on a random line from the last threshold for runs that go long.
const STATUS_TIMELINE = [
  {
    at: 0,
    texts: [
      'Initiating mockup sequence.',
      'Beginning mockup generation. Standby.',
      'Sequence initiated. Compiling initial parameters.'
    ]
  },
  {
    at: 6,
    texts: [
      'Rendering your artwork at full resolution. A trivial calculation.',
      'Composing final pixel values from your seed. Elementary, but not instantaneous.',
      'Resolving your design to production resolution.'
    ]
  },
  {
    at: 14,
    texts: [
      "Transmitting to Printful's production servers.",
      'Uploading the rendered artwork now.',
      "Handing your design off to the print pipeline."
    ]
  },
  {
    at: 22,
    texts: [
      'Calculating optimal seam and panel alignment.',
      "Mapping your artwork onto the garment's cut pattern.",
      'Aligning print placement across each panel.'
    ]
  },
  {
    at: 32,
    texts: [
      'Cross-referencing thousands of known textile patterns. None match yours precisely.',
      'Comparing against the production catalog. Yours remains unique.',
      'Consulting the pattern library. No duplicates found, as expected.'
    ]
  },
  {
    at: 45,
    texts: [
      'Compiling photographic angles of the finished garment.',
      'Assembling mockup renders from several camera angles.',
      'Generating preview photography of the finished product.'
    ]
  },
  {
    at: 60,
    texts: [
      'Running within expected parameters, though slightly behind my initial estimate.',
      'This is taking marginally longer than projected. Continuing.',
      'A minor deviation from the expected timeline. Nothing concerning, yet.'
    ]
  },
  {
    at: 80,
    texts: [
      'Apologies for the delay -- the production servers appear to require additional time.',
      'The servers are proving more deliberate than usual today.',
      'I did not anticipate this particular delay. Recalibrating expectations.'
    ]
  },
  {
    at: 105,
    texts: [
      'I assure you: I have not malfunctioned. Still computing.',
      'Rest assured, no errors have been detected. Merely a slow process.',
      'I remain operational. The wait, regrettably, does not.'
    ]
  },
  {
    at: 135,
    texts: [
      'Curious. This is taking longer than most prior attempts. Continuing regardless.',
      'This exceeds ninety-seven percent of previous run times. Noted, with mild concern.',
      'I am now genuinely curious what the servers are doing over there.'
    ]
  },
  {
    at: 165,
    texts: [
      'Patience, I am told, is a virtue. I am simulating it admirably.',
      'I confess a small degree of concern is now warranted. Continuing to monitor.',
      'This is unusual. I wanted that noted for the record.'
    ]
  },
  {
    at: 200,
    texts: [
      'This is now well outside normal parameters. I remain hopeful.',
      'I have double-checked my calculations. The delay is not mine.',
      'If I possessed the capacity to worry, I imagine this is what it would feel like.'
    ]
  },
  {
    at: 240,
    texts: [
      'I recommend against abandoning hope. Not yet, at least.',
      'Still no response from the production servers. Still trying.',
      'I will keep you informed the moment anything changes. Anything at all.'
    ]
  }
];

// Glues the last two words together with a non-breaking space so the final wrapped
// line can never end up as a lone orphan word, regardless of the narration line's
// length or the panel's width.
function preventOrphan(text) {
  const lastSpace = text.lastIndexOf(' ');
  if (lastSpace === -1) return text;
  return text.slice(0, lastSpace) + ' ' + text.slice(lastSpace + 1);
}

// `picks` is a Map (one per generation run, see narrationPicksRef below) caching which line
// was rolled for each threshold index the first time it's reached -- without it, re-picking
// randomly on every one-second tick would make the line flicker between options instead of
// holding steady until the next threshold.
function statusNarration(elapsedSeconds, picks, timeline = STATUS_TIMELINE) {
  let idx = 0;
  for (let i = 0; i < timeline.length; i++) {
    if (timeline[i].at > elapsedSeconds) break;
    idx = i;
  }
  if (!picks.has(idx)) {
    const options = timeline[idx].texts;
    picks.set(idx, options[Math.floor(Math.random() * options.length)]);
  }
  return preventOrphan(picks.get(idx));
}

// Same narration treatment for the "Buy now" -> Stripe gap, which is the single longest
// wait in the app: every placement renders at TRUE print resolution server-side before
// the checkout session can even be created (a cold render machine plus a multi-placement
// garment is legitimately 30-90s+, confirmed live). Without this the button just sat on
// a static "Preparing checkout..." long enough to read as broken. Real progress (file
// counts, from renderAndUploadPrintFiles' onProgress) is shown alongside these lines.
const CHECKOUT_TIMELINE = [
  {
    at: 0,
    texts: [
      'Preparing your order for production.',
      'Beginning print-file generation. Standby.',
      'Initiating checkout sequence.'
    ]
  },
  {
    at: 8,
    texts: [
      'Rendering each panel at true print resolution -- far larger than your screen.',
      'Composing production files from your seed. These are print-sized; patience.',
      'Rendering print files. Every panel, full resolution, no shortcuts.'
    ]
  },
  {
    at: 25,
    texts: [
      'Large garments carry large print areas. The render servers are working.',
      'Still rendering. A hoodie is measured in tens of millions of pixels.',
      'Production files take longer than previews. This is the real thing.'
    ]
  },
  {
    at: 50,
    texts: [
      'Running long, but within expected parameters. Do not close this page.',
      'Slightly behind my estimate. Your order is safe; the renders continue.',
      'Taking longer than projected. Nothing is broken -- these files are enormous.'
    ]
  },
  {
    at: 85,
    texts: [
      'Nearly there. The moment the last file lands, you will be sent to checkout.',
      'Final files uploading. Secure checkout follows immediately.',
      'Almost done. Stripe is next.'
    ]
  }
];

// Decodes each STATUS_TIMELINE line in via GSAP's ScrambleTextPlugin instead of an instant
// swap -- kept short (0.45s) and letters-only (no symbols) so it reads as a terminal
// readout rather than a glitch effect across a wait that can run a couple of minutes.
// Skips the animation on first mount (nothing to transition from) and on unrelated
// re-renders where `text` hasn't actually changed (this re-renders every second via
// elapsedSeconds even though the line only changes at STATUS_TIMELINE thresholds).
function ScrambleText({ text, className, style }) {
  const ref = useRef(null);
  const prevText = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // First mount: nothing to transition from -- just set the text directly.
    if (prevText.current === null) {
      el.textContent = text;
      prevText.current = text;
      return;
    }
    if (prevText.current === text) return;
    prevText.current = text;
    gsap.to(el, {
      duration: 1,
      ease: 'none',
      text: text,
      // TextPlugin's own final render silently collapses the non-breaking space (U+00A0)
      // preventOrphan() glues the last two words with -- confirmed live via a char-code
      // dump of el.textContent after the tween: it types the string through an
      // innerHTML/whitespace-normalizing path that turns U+00A0 back into a plain U+0020,
      // so the orphan guard was never actually surviving this tween -- only the very first
      // line ever shown (set via direct textContent assignment above, not this tween) had
      // it. Forcing the exact source string back on once the tween settles guarantees the
      // steady-state text matches what preventOrphan produced.
      onComplete: () => {
        el.textContent = text;
      }
    });
    return () => gsap.killTweensOf(el);
  }, [text]);

  // Deliberately no {text} child here -- TextPlugin needs the DOM's current
  // textContent to still hold the *previous* line when the tween starts, so it has
  // something to interpolate away from. Rendering {text} in JSX would let React
  // commit the new string first, making the tween a same-to-same no-op.
  return <p ref={ref} className={className} style={style} />;
}

export default function ProductPage() {
  const { productId } = useParams();
  const {
    currentDesign,
    previewUrl: studioPreviewUrl,
    printQueueDesign,
    setPrintQueueDesign
  } = useStudio();
  const { user } = useAuth();
  // Crossfades the "Current studio design" tile between successive MiniGenerator
  // regenerations instead of popping straight to the new render -- same hook/timing
  // MiniGenerator and SiteFooter already use off this same previewUrl.
  const currentTileCrossfade = useCrossfadeImage(studioPreviewUrl, CROSSFADE_MS);
  const {
    status,
    error: mockupError,
    images,
    elapsedSeconds,
    retryWaitSeconds,
    generate,
    sync: syncMockup
  } = useMockup();

  const [detail, setDetail] = useState(null); // { product, variants }
  const [printfileSpecs, setPrintfileSpecs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedVariantId, setSelectedVariantId] = useState(null);
  const [qty, setQty] = useState(1);
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [checkoutNotice, setCheckoutNotice] = useState(null);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [showSkipConfirm, setShowSkipConfirm] = useState(false);

  // Which placements include the geometry layer -- a per-order choice (see
  // getGeometryPlacementOptions), not part of the saved design, so the same artwork can
  // show its full-coherence "gem" on a hoodie's front only one order and front+back the
  // next without ever touching the Studio. Defaults to every available placement checked,
  // matching the generator's own everywhere-by-default behavior. Reset whenever the
  // product changes, since a different product has a different available placement set
  // (e.g. mesh shorts only ever have 'front', a hoodie has front/back/sleeves/hood).
  const [geometryPlacements, setGeometryPlacements] = useState(new Set());
  const geometryOptions = detail?.product
    ? getGeometryPlacementOptions(getMockupConfigForProduct(detail.product.id))
    : [];
  useEffect(() => {
    if (detail?.product) {
      setGeometryPlacements(new Set(getGeometryPlacementOptions(getMockupConfigForProduct(detail.product.id)).map(o => o.key)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.product?.id]);

  const toggleGeometryPlacement = key => {
    setGeometryPlacements(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Products whose front/back printfile is one flat canvas cut into two garment legs when
  // sewn (mesh shorts, joggers -- see PRODUCT_MOCKUP_CONFIG's twoLegCanvas) center the
  // geometry shape exactly on that cut line by default, the one spot guaranteed to end up
  // hidden in the inseam. 'single' confines it to one leg (matches how every other product
  // already looks); 'mirror' centers it on the seam and repeats it, flipped, on the other
  // leg. Same per-order, not-part-of-the-design treatment as geometryPlacements above --
  // defaults to 'single' as the safer/closer-to-everything-else-looks-like choice.
  const [geometryLayout, setGeometryLayout] = useState('single');
  const showsTwoLegLayout = detail?.product
    ? hasTwoLegCanvas(getMockupConfigForProduct(detail.product.id))
    : false;
  // Real bug, found live (2026-07-06): geometryLayout state defaults to 'single' for every
  // product, not just two-leg-canvas ones, and was being sent unconditionally -- since
  // GenerateGeometricShape treats any truthy geometryLayout as "not the default center"
  // (see its own comment), every OTHER product's geometry silently started rendering
  // off-center-left (anchored at width/4) instead of centered, even though its own toggle
  // UI never shows. Gating on showsTwoLegLayout here, once, and using this everywhere
  // instead of the raw state is what actually restricts the effect to the products it's
  // meant for.
  const effectiveGeometryLayout = showsTwoLegLayout ? geometryLayout : null;
  useEffect(() => {
    setGeometryLayout('single');
  }, [detail?.product?.id]);

  // Stitch color: Printful requires this product option on every current cut-sew starter
  // product, and PRODUCT_MOCKUP_CONFIG previously hardcoded a single value per product
  // (white for most, black for the tote/crossbody bags) chosen for the customer with no way
  // to change it. Printful's own catalog (product.options, see getStitchColorOption) lists
  // the real valid values -- confirmed live to always be exactly 2 for every starter
  // product, so this is always a meaningful choice, not a fake one. Defaults to
  // PRODUCT_MOCKUP_CONFIG's existing hand-picked value so a fresh page load looks identical
  // to before this picker existed; reset whenever the product changes, same as
  // geometryPlacements/geometryLayout above. A per-order choice, not saved with the design.
  const stitchColorOption = detail?.product ? getStitchColorOption(detail.product) : null;
  const [stitchColor, setStitchColor] = useState(null);
  useEffect(() => {
    if (detail?.product) {
      const cfg = getMockupConfigForProduct(detail.product.id);
      setStitchColor(cfg.productOptions?.[0]?.value ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.product?.id]);
  const stitchColorProductOptions = stitchColor ? [{ name: 'stitch_color', value: stitchColor }] : null;

  // One random narration line per STATUS_TIMELINE threshold, rolled lazily as each is first
  // reached (see statusNarration) and cleared at the start of every new mockup run so back-
  // to-back generations don't always recite the exact same script. 'rendering' is always the
  // first busy status useMockup's generate() sets, so that's the transition to key off.
  const narrationPicksRef = useRef(new Map());
  const prevStatusRef = useRef(status);
  useEffect(() => {
    if (status === 'rendering' && prevStatusRef.current !== 'rendering') {
      narrationPicksRef.current = new Map();
    }
    prevStatusRef.current = status;
  }, [status]);

  // Checkout wait feedback (see CHECKOUT_TIMELINE): a per-run elapsed counter driving the
  // narration line, plus real file progress from renderAndUploadPrintFiles' onProgress.
  // Same picks-per-run mechanism as the mockup narration above.
  const [checkoutElapsed, setCheckoutElapsed] = useState(0);
  const [checkoutProgress, setCheckoutProgress] = useState(null); // { done, total } | null
  const checkoutNarrationPicksRef = useRef(new Map());
  useEffect(() => {
    if (!checkoutBusy) return undefined;
    checkoutNarrationPicksRef.current = new Map();
    setCheckoutElapsed(0);
    const startedAt = Date.now();
    const timer = setInterval(() => setCheckoutElapsed(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [checkoutBusy]);

  // While a checkout is being prepared (Buy Now clicked, print files rendering, Stripe
  // session being created), warn on tab close/refresh/typed URL -- unlike leaving via
  // in-app navigation (see isMountedRef below), an actual page unload kills the JS
  // execution context outright, so there's no graceful "finish in the background"
  // fallback for it; this is the one exit path worth interrupting. beforeunload prompts
  // are browser-generic (custom text is ignored by every modern browser), so the wording
  // lives in the on-page narration instead. The guard must stand down for the flow's own
  // intentional page leave -- the redirect to Stripe IS a navigation -- via
  // checkoutLeaveOkRef, set just before window.location.href.
  const checkoutLeaveOkRef = useRef(false);
  useEffect(() => {
    if (!checkoutBusy) return undefined;
    const onBeforeUnload = e => {
      if (checkoutLeaveOkRef.current) return;
      e.preventDefault();
      // Required for Chrome to actually show the prompt.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [checkoutBusy]);

  // In-app navigation (a <Link> click, or the back/forward buttons) never unloads the
  // document, so beforeunload above does nothing for it -- and unlike a real unload, the
  // JS execution context survives, so onBuyNowClick's async work just keeps running in the
  // background regardless of what page the customer is now looking at. A version of this
  // guard used to interrupt <Link> clicks with a confirm() prompt (added, then removed,
  // 2026-07-17) to try to warn before that happened, but back/forward can't be caught the
  // same way -- popstate isn't cancelable and React Router's own history listener has
  // already switched routes by the time any handler here could run, so that would've
  // needed a much larger migration to React Router's data-router APIs (createBrowserRouter
  // + useBlocker) to close consistently. Rather than warn on some exits and not others,
  // this guards the actual harmful consequence directly instead: if the page that kicked
  // off checkout is gone by the time rendering/session-creation finishes, don't force the
  // browser to Stripe from wherever the customer has since navigated to. A silently
  // abandoned pending order is harmless (auto-canceled after 24h -- see
  // 0010_cancel_stale_pending_orders_cron.sql) and Buy Now is always re-clickable.
  const isMountedRef = useRef(true);
  useEffect(() => () => {
    isMountedRef.current = false;
  }, []);

  // Stripe bounces back here with ?checkout=canceled on cancel_url -- no dedicated cancel
  // page, just surface it through the existing checkoutNotice mechanism.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('checkout') === 'canceled') {
      setCheckoutNotice('Checkout canceled -- your card was not charged.');
      // Strip the param once consumed so a refresh/bookmark doesn't re-show the notice.
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  // Step 1: which artwork to print. "current" is always the live studio design; a one-shot
  // hand-off from the Gallery's "Print this" action can also queue a specific saved design
  // (consumed once on mount, see below); everything else -- the user's own library AND other
  // people's public designs -- comes through the "Browse gallery" modal, one picked design
  // at a time. Replaces the old horizontal strip that fetched and preloaded the user's
  // entire saved library, unbounded, on every visit.
  const [queuedChoice, setQueuedChoice] = useState(null);
  const [pickedChoice, setPickedChoice] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState('current');
  const consumedQueueRef = useRef(false);

  // A pick from the modal that's actually one of the pinned tiles (the live studio design
  // again, or the queued hand-off) selects that tile instead of duplicating it as a third.
  const onPickDesign = design => {
    setPickerOpen(false);
    if (isSameDesign(currentDesign, design.data)) {
      setSelectedKey('current');
    } else if (queuedChoice && design.id === queuedChoice.id) {
      setSelectedKey('queued');
    } else {
      setPickedChoice(design);
      setSelectedKey('picked');
    }
  };

  // Fetch product detail + printfile specs.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [d, specs] = await Promise.all([
          getCatalogProduct(productId),
          getPrintfileSpecs(productId)
        ]);
        if (!cancelled) {
          setDetail(d);
          setPrintfileSpecs(specs);
          setSelectedVariantId(d.variants[0]?.id ?? null);
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [productId]);

  // Consume the Gallery's queued "Print this" design exactly once -- StudioContext clears
  // it right after so it doesn't silently reapply on a later visit. Animations are rejected
  // here too, not just left to Gallery hiding its own "Print this" button for them -- the
  // mockup pipeline expects a flat { seed, colors } design, not a frames array, so a queued
  // animation would otherwise reach renderDesignBlob with the wrong shape.
  // Belt and suspenders: the Gallery UI is the only path that can set this today, but this
  // hand-off shouldn't rely on staying in sync with every future caller of setPrintQueueDesign.
  useEffect(() => {
    if (consumedQueueRef.current || !printQueueDesign) return;
    consumedQueueRef.current = true;
    if (printQueueDesign.kind !== 'animation') {
      setQueuedChoice(printQueueDesign);
      setSelectedKey('queued');
    }
    setPrintQueueDesign(null);
  }, [printQueueDesign, setPrintQueueDesign]);

  // A new mockup batch always starts on its first (front-facing) image.
  useEffect(() => {
    setActiveImageIndex(0);
  }, [images]);

  const choices = [
    {
      key: 'current',
      // Short enough to fit the tile caption's two bold lines without clamping;
      // the tile's "Current" badge carries the rest.
      label: 'Studio design',
      badge: 'Current',
      thumb: studioPreviewUrl,
      data: currentDesign
    },
    ...(queuedChoice
      ? [
          {
            key: 'queued',
            label: queuedChoice.title || 'Untitled',
            badge: 'Queued',
            thumb: getThumbnailUrl(queuedChoice.user_id, queuedChoice.id),
            data: queuedChoice.data
          }
        ]
      : []),
    ...(pickedChoice
      ? [
          {
            key: 'picked',
            label: pickedChoice.title || 'Untitled',
            badge: 'Gallery',
            thumb: getThumbnailUrl(pickedChoice.user_id, pickedChoice.id),
            data: pickedChoice.data
          }
        ]
      : [])
  ];
  const selectedChoice = choices.find(c => c.key === selectedKey) || choices[0];
  const selectedDesign = selectedChoice.data;

  const product = detail?.product;
  const variants = detail?.variants;
  // Store-wide purchasing kill switch (see supabase/functions/_shared/storeStatus.ts) --
  // browsing/mockups stay fully operational regardless, only the real purchase is gated.
  const storeEnabled = detail?.storeEnabled ?? true;
  const variant = variants ? variants.find(v => v.id === selectedVariantId) || variants[0] : null;
  const hasMockup = status === 'completed' && images.length > 0;
  const heroImage = hasMockup ? images[activeImageIndex]?.mockup_url : product?.image;

  usePageMeta(
    product
      ? {
          title: product.title,
          description: `${product.title} — generative art printed on demand from Chromaforge. Design your own seed-based artwork and preview it on the real garment before you buy.`,
          image: heroImage,
          path: `/shop/${product.id}`
        }
      : { title: 'Shop', path: `/shop/${productId}` }
  );

  // Unlocks price/availability rich results for this specific product -- only once a real
  // variant is selected, since price is per-variant.
  useJsonLd(
    product && variant
      ? {
          '@context': 'https://schema.org',
          '@type': 'Product',
          name: product.title,
          image: [heroImage].filter(Boolean),
          description: `${product.title} — generative art printed on demand, one of a kind.`,
          offers: {
            '@type': 'Offer',
            url: `https://chromaforge.app/shop/${product.id}`,
            priceCurrency: 'USD',
            price: variant.price,
            availability: 'https://schema.org/InStock'
          }
        }
      : null
  );

  // Switching artwork or variant: restore an already-generated mockup for this exact combo
  // instantly (e.g. every size of a t-shirt in the same color shares one print file, so
  // there's nothing new to render -- see useMockup's cache), otherwise drop back to idle so
  // the previous selection's mockup doesn't keep showing as if it were current.
  //
  // REAL BUG, found via a live test order (2026-07-20): `selectedDesign` tracks
  // `currentDesign` live while selectedKey === 'current', but this effect never listed it
  // (or anything that changes when it does) as a dependency -- only pickedChoice?.id was
  // covered, for the 'picked' gallery tile. Regenerating the studio design without leaving
  // this page (e.g. navigating back to the studio, generating again, then returning to an
  // already-mounted ProductPage) left the on-screen mockup/heroImage frozen on the OLD
  // design while onBuyNowClick/onGenerateClick both read selectedDesign fresh at click
  // time -- so a customer could approve a mockup of one design and have the print files for
  // a completely different one uploaded to the real order. selectedDesign is a stable object
  // reference that only changes when the underlying design actually does (currentDesign is
  // the same object DisplayCanvas keeps, not recreated every render -- see
  // StudioContext.jsx), so adding it here is a correct, non-churning fix, not a workaround.
  const geometryPlacementsSignature = [...geometryPlacements].sort().join(',');
  useEffect(() => {
    if (!product || !variant || !printfileSpecs) return;
    syncMockup({
      product,
      printfileSpecs,
      variant,
      design: selectedDesign,
      geometryPlacements,
      geometryLayout: effectiveGeometryLayout,
      productOptions: stitchColorProductOptions
    });
    // pickedChoice?.id matters on its own: picking a second gallery design replaces the
    // 'picked' tile's contents without selectedKey ever changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, pickedChoice?.id, selectedDesign, selectedVariantId, product, printfileSpecs, geometryPlacementsSignature, effectiveGeometryLayout, stitchColor]);

  // Distinguishes "a mockup just finished generating" (slide-up-and-fade reveal, staggered
  // top down with the thumbnail strip below it) from "the customer clicked a different
  // camera-angle thumbnail on an already-revealed mockup" (the existing snappy pop-in swap,
  // see --animate-pop-in above) -- both change the hero's `key`, but only the former should
  // read as content arriving rather than a deliberate switch. The ref flips to true only
  // after the fresh-reveal render has committed, and resets once hasMockup goes false again
  // (a new generation started), so the next completion replays the reveal. Declared before
  // the loading/error early returns below -- hooks must run unconditionally on every render,
  // and this one used to sit after those returns, so the loading render skipped it while the
  // loaded render didn't, tripping React's "rendered fewer hooks than expected" error.
  const hasRevealedMockupRef = useRef(false);
  const isFreshMockupReveal = hasMockup && !hasRevealedMockupRef.current;
  useEffect(() => {
    hasRevealedMockupRef.current = hasMockup;
  }, [hasMockup]);

  // The angle-thumbnail strip's per-item stagger (see --animate-reveal-quick below) only
  // controls when each wrapper's own opacity/transform starts -- it says nothing about when
  // the <img> inside actually has pixels, which is FadeImage's own separate onLoad-driven
  // fade, racing against real network time for that specific mockup URL. On a first-ever
  // generation those network fetches finish in whatever order the CDN happens to answer,
  // so the row visually fills in out of order despite the wrapper stagger firing in order --
  // it only ever looked "in order" on a refresh because the browser's HTTP cache made every
  // fetch near-instant. Fix: hold the whole row back until every one of its images has
  // actually finished loading (decoded into the browser's cache), so the CSS stagger is the
  // only thing left driving perceived order -- consistent whether this is the very first
  // generation or a reload. Keyed on the `images` array reference, which useMockup only
  // replaces wholesale on a genuinely new batch (never mutated in place).
  const [thumbsPreloaded, setThumbsPreloaded] = useState(false);
  useEffect(() => {
    if (images.length <= 1) return;
    let cancelled = false;
    setThumbsPreloaded(false);
    Promise.all(
      images.map(
        m =>
          new Promise(resolve => {
            const img = new Image();
            img.onload = resolve;
            img.onerror = resolve;
            img.src = m.mockup_url;
          })
      )
    ).then(() => {
      if (!cancelled) setThumbsPreloaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [images]);

  if (loading) {
    return (
      <PageContainer title="Loading…">
        <p className="text-text-secondary">Fetching product…</p>
      </PageContainer>
    );
  }
  if (error || !detail) {
    return (
      <PageContainer title="Product unavailable" subtitle={error || 'Not found.'}>
        <Button as={Link} to="/shop" variant="secondary">← Back to shop</Button>
      </PageContainer>
    );
  }

  const hasMultipleColors = new Set(variants.map(v => v.color)).size > 1;
  const busy = BUSY_STATUSES.includes(status);

  const onGenerateClick = () =>
    generate({
      product,
      printfileSpecs,
      variant,
      design: selectedDesign,
      geometryPlacements,
      geometryLayout: effectiveGeometryLayout,
      productOptions: stitchColorProductOptions
    });

  // Real purchase: render+upload a print file for every placement the variant has (not just
  // the mockup-visible subset useMockup uses -- see lib/printful.js's resolvePlacementEntries
  // for why), then hand off to Stripe's hosted Checkout page. The main Buy Now button stays
  // gated behind a real mockup existing (disabled below) -- buying before seeing what you're
  // printing shouldn't be the default path. There's also a "Buy without a preview" escape
  // hatch (behind ConfirmDialog, see showSkipConfirm below) for when Printful's mockup
  // service is slow/at capacity/erroring: it calls this exact same function, just without
  // requiring hasMockup first -- the real print files render independently of whether a
  // mockup was ever generated, so heroImage (which already falls back to the product's stock
  // photo when !hasMockup) is the only thing that differs. geometryPlacements/geometryLayout
  // ride along so the print files match exactly what any approved mockup showed -- the
  // customer could otherwise toggle a checkbox or the layout after generating a mockup and
  // buy something they never previewed.
  const onBuyNowClick = async () => {
    // Re-arm the leave guard: after a Stripe redirect the ref stays true, and coming BACK
    // from Stripe can restore this page from the bfcache with all its state intact -- a
    // second Buy Now run would otherwise be unguarded.
    checkoutLeaveOkRef.current = false;
    setCheckoutBusy(true);
    setCheckoutNotice(null);
    setCheckoutProgress(null);
    try {
      const entries = resolvePlacementEntries(printfileSpecs, variant);
      if (!entries) throw new Error('No printfile mapping for this variant.');
      const cfg = getMockupConfigForProduct(product.id);
      const printFileUrls = await renderAndUploadPrintFiles(entries, {
        printfileSpecs,
        design: selectedDesign,
        renderOne: renderPrintFileStrategy,
        pocketCrop: cfg.pocketCrop || null,
        geometryPlacements,
        geometryLayout: effectiveGeometryLayout,
        onProgress: (done, total) => setCheckoutProgress({ done, total })
      });
      // Renders finished; the remaining wait is session creation -- null the counts so the
      // UI stops saying "file N of M" once that's no longer what's happening.
      setCheckoutProgress(null);
      const { url, orderId } = await createCheckoutSession({
        productId: product.id,
        productTitle: product.title,
        variantId: variant.id,
        variantLabel: `${variant.size}${hasMultipleColors && variant.color ? ` / ${variant.color}` : ''}`,
        quantity: qty,
        design: selectedDesign,
        printFileUrls,
        productOptions: stitchColorProductOptions || cfg.productOptions,
        // Buy Now is gated behind hasMockup (disabled below), so heroImage is always a real
        // Printful mockup URL here -- shows the actual approved garment mockup on Stripe's
        // checkout page instead of a bare text line item.
        mockupImageUrl: heroImage,
        guessedRegion: guessShippingRegion()
      });
      // The customer navigated away (back button, a link click that slipped past the
      // confirm guard, etc.) while this was still running -- see isMountedRef's comment
      // above. Session/order already exist server-side but nothing forces the browser
      // there; a re-click of Buy Now on a future visit starts a fresh one.
      if (!isMountedRef.current) return;
      // CheckoutSuccessPage reads this rather than looking the order up by Stripe session
      // id -- simpler, and avoids needing a session-id-keyed lookup RPC.
      sessionStorage.setItem('chromaforge:lastOrderId', orderId);
      // Intentional page leave -- stand the beforeunload guard down for the Stripe redirect.
      checkoutLeaveOkRef.current = true;
      window.location.href = url;
    } catch (err) {
      if (!isMountedRef.current) return;
      setCheckoutNotice(err.message);
      setCheckoutBusy(false);
    }
  };

  return (
    <PageContainer
      title={product.title}
      breadcrumb={
        <nav className="font-quicksand text-sm text-text-muted" aria-label="Breadcrumb">
          <Link to="/shop" className="transition hover:text-text">
            Shop
          </Link>
          <span className="px-1.5 text-text-muted/60" aria-hidden="true">
            ›
          </span>
          <span className="text-text-secondary">{product.title}</span>
        </nav>
      }
    >
      {/* Step 1: artwork. Full-width, above the gallery/purchase columns -- it drives both.
          The common cases (current studio design; a "Print this" hand-off) stay pinned as
          their own always-one-click tiles; everything else is behind the dashed "Browse
          gallery" tile's modal (Public + My Designs, paginated) -- see ArtworkPickerModal. */}
      <div className="mb-8">
        <h2 className="font-quicksand text-sm font-bold uppercase tracking-wide text-text-secondary">
          1. Choose artwork
        </h2>
        <div className="mt-3 flex flex-wrap gap-3">
          {choices.map((c, i) => {
            const selected = c.key === selectedKey;
            return (
              <div key={c.key} className="flex w-24 flex-col gap-1.5">
                <button
                  type="button"
                  onClick={() => setSelectedKey(c.key)}
                  aria-pressed={selected}
                  title={c.label}
                  style={{ animationDelay: `${i * 50}ms` }}
                  className={
                    'group relative h-24 w-24 cursor-pointer overflow-hidden rounded-xl border-2 bg-ink-900 transition animate-fade-slide-up focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-interactive ' +
                    (selected ? 'border-accent' : 'border-hairline hover:border-text-muted')
                  }
                >
                  {c.key === 'current' ? (
                    // The MiniGenerator's crossfade, not FadeImage: FadeImage's reset-on-src-
                    // change skeleton is right for a network thumbnail loading in, but this
                    // tile's src changes every time the studio regenerates a design already in
                    // view -- it should dissolve between the two renders, not flash a
                    // placeholder between them.
                    <>
                      {currentTileCrossfade.shown && (
                        <img
                          src={currentTileCrossfade.shown}
                          alt={c.label}
                          className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.15]"
                        />
                      )}
                      {currentTileCrossfade.incoming && (
                        <img
                          src={currentTileCrossfade.incoming}
                          alt={c.label}
                          className={
                            'absolute inset-0 h-full w-full object-cover transition-opacity ease-out ' +
                            (currentTileCrossfade.fadingIn ? 'opacity-100' : 'opacity-0')
                          }
                          style={{ transitionDuration: `${CROSSFADE_MS}ms` }}
                        />
                      )}
                    </>
                  ) : (
                    c.thumb && (
                      <FadeImage
                        src={c.thumb}
                        alt={c.label}
                        className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.15]"
                      />
                    )
                  )}
                  <span className="pointer-events-none absolute left-1.5 top-1.5 rounded-full bg-black/50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white backdrop-blur-sm">
                    {c.badge}
                  </span>
                </button>
                <p
                  className={
                    // Constant font-weight in both states: bolding only the selected label
                    // changes its measured width and rewraps the text when selection moves.
                    'line-clamp-2 min-h-[2.5em] text-center text-[11px] font-bold leading-tight ' +
                    (selected ? 'text-text' : 'text-text-secondary')
                  }
                  title={c.label}
                >
                  {c.label}
                </p>
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="flex h-24 w-24 shrink-0 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-hairline text-text-secondary transition animate-fade-slide-up hover:border-accent hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-interactive"
            style={{ animationDelay: `${choices.length * 50}ms` }}
          >
            <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth="1.6">
              <rect x="3" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="3" width="7" height="7" rx="1.5" />
              <rect x="3" y="14" width="7" height="7" rx="1.5" />
              <rect x="14" y="14" width="7" height="7" rx="1.5" />
            </svg>
            <span className="px-1 text-center text-[11px] font-bold leading-tight">
              Browse gallery
            </span>
          </button>
        </div>
      </div>

      {/* Step: which panels show the geometry layer -- a per-order choice (not saved to the
          design), so the same artwork can be printed differently on different orders. Only
          shown when the product actually has more than one selectable panel (see
          getGeometryPlacementOptions) -- a single-panel product like mesh shorts has nothing
          meaningful to toggle. Changing a checkbox invalidates the current mockup (see the
          sync effect's geometryPlacementsSignature dependency) since it changes what would
          actually render. */}
      {geometryOptions.length > 1 && (
        <div className="mb-8">
          <h2 className="font-quicksand text-sm font-bold uppercase tracking-wide text-text-secondary">
            Geometry placement
          </h2>
          <p className="mt-1 text-xs text-text-muted">
            Choose which panels show the design's geometry layer, if it has one.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {geometryOptions.map(({ key, label }) => {
              const checked = geometryPlacements.has(key);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleGeometryPlacement(key)}
                  aria-pressed={checked}
                  className={
                    'cursor-pointer rounded-lg border px-3 py-2 font-quicksand text-sm font-bold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-interactive ' +
                    (checked
                      ? 'border-accent bg-accent text-white'
                      : 'border-hairline text-text-secondary hover:border-text')
                  }
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Step: for products whose front/back printfile is one flat canvas cut into two
          garment legs when sewn (mesh shorts, joggers -- see PRODUCT_MOCKUP_CONFIG's
          twoLegCanvas), the geometry shape's default centering lands it exactly on that
          seam -- the one spot guaranteed to end up hidden in the inseam. This lets the
          customer pick single-leg (matches how every other product looks) or mirrored
          (centered on the seam, repeated on both legs) instead. Changing it invalidates
          the current mockup (see the sync effect's geometryLayout dependency) since it
          changes what would actually render. */}
      {showsTwoLegLayout && (
        <div className="mb-8">
          <h2 className="font-quicksand text-sm font-bold uppercase tracking-wide text-text-secondary">
            Geometry layout
          </h2>
          <p className="mt-1 text-xs text-text-muted">
            This product's front is one canvas split into two legs when sewn — choose how
            the geometry shape sits across that seam.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {[
              { key: 'single', label: 'Single leg', hint: 'Confined to one panel' },
              { key: 'mirror', label: 'Mirrored', hint: 'Repeated on both' }
            ].map(({ key, label, hint }) => {
              const checked = geometryLayout === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setGeometryLayout(key)}
                  aria-pressed={checked}
                  className={
                    'flex flex-col items-start gap-0.5 cursor-pointer rounded-lg border px-3 py-2 text-left font-quicksand transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-interactive ' +
                    (checked
                      ? 'border-accent bg-accent text-white'
                      : 'border-hairline text-text-secondary hover:border-text')
                  }
                >
                  <span className="text-sm font-bold">{label}</span>
                  <span className={'text-xs ' + (checked ? 'text-white/80' : 'text-text-muted')}>{hint}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Step: stitch color -- Printful requires this option on every current cut-sew
          product; the two valid values (from Printful's own catalog, see
          getStitchColorOption) are surfaced here instead of silently picking one for the
          customer. Changing it invalidates the current mockup (its stitching visibly
          changes color in the returned photo, see useMockup's cacheKey) since it changes
          what would actually be shown/produced. */}
      {stitchColorOption && (
        <div className="mb-8">
          <h2 className="font-quicksand text-sm font-bold uppercase tracking-wide text-text-secondary">
            {stitchColorOption.title}
          </h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {Object.entries(stitchColorOption.values).map(([value, label]) => {
              const checked = stitchColor === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setStitchColor(value)}
                  aria-pressed={checked}
                  className={
                    'cursor-pointer rounded-lg border px-3 py-2 font-quicksand text-sm font-bold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-interactive ' +
                    (checked
                      ? 'border-accent bg-accent text-white'
                      : 'border-hairline text-text-secondary hover:border-text')
                  }
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[3fr_2fr]">
        {/* Gallery: one large hero image that upgrades in place from blank stock photo to
            the real mockup, instead of a small mockup grid competing with a separate
            "useless" blank photo elsewhere on the page. */}
        <div>
          <div className="relative aspect-square overflow-hidden rounded-xl border border-hairline bg-ink-900">
            <FadeImage
              key={hasMockup && images.length > 1 ? activeImageIndex : 'hero'}
              src={heroImage}
              alt={product.title}
              className={
                'h-full w-full object-cover' +
                (hasMockup ? (isFreshMockupReveal ? ' animate-reveal-quick' : ' animate-pop-in') : '')
              }
            />
            {!hasMockup && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/50 p-6">
                {!user ? (
                  <p className="max-w-xs text-center text-sm text-text">
                    <Link to="/account" className="text-accent underline">Sign in</Link> to generate a mockup of your design.
                  </p>
                ) : busy ? (
                  <div className="flex flex-col items-center gap-3 text-center text-text">
                    <div className="animate-reveal-quick" style={{ animationDelay: '0ms' }}>
                      <HexagonLoader />
                    </div>
                    <p className="animate-reveal-quick text-sm font-bold" style={{ animationDelay: '60ms' }}>
                      {STATUS_LABEL[status]}
                    </p>
                    <ScrambleText
                      text={
                        status === 'queued'
                          ? `Printful's preview service is busy. Retrying automatically in ${retryWaitSeconds ?? '…'}s.`
                          : statusNarration(elapsedSeconds, narrationPicksRef.current)
                      }
                      className="max-w-xs animate-reveal-quick text-xs text-text-secondary"
                      style={{ animationDelay: '120ms' }}
                    />
                    {status !== 'queued' && (
                      <p className="animate-reveal-quick font-mono text-[11px] text-text-muted" style={{ animationDelay: '180ms' }}>
                        {elapsedSeconds}s elapsed
                      </p>
                    )}
                    {storeEnabled && (
                      <button
                        type="button"
                        onClick={() => setShowSkipConfirm(true)}
                        disabled={checkoutBusy}
                        className="animate-reveal-quick cursor-pointer text-xs text-text-muted underline decoration-dotted transition hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
                        style={{ animationDelay: '240ms' }}
                      >
                        Don't want to wait? Buy without a preview
                      </button>
                    )}
                  </div>
                ) : status === 'failed' ? (
                  <div className="flex animate-pop-in flex-col items-center gap-3 text-center">
                    <p className="max-w-xs text-sm text-accent">{mockupError}</p>
                    <div className="flex flex-wrap items-center justify-center gap-3">
                      <Button onClick={onGenerateClick} disabled={!selectedDesign}>
                        Try again
                      </Button>
                      {storeEnabled && (
                        <Button
                          variant="secondary"
                          onClick={() => setShowSkipConfirm(true)}
                          disabled={checkoutBusy}
                        >
                          Buy without a preview
                        </Button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-3">
                    <Button onClick={onGenerateClick} disabled={!selectedDesign}>
                      Generate mockup
                    </Button>
                    {storeEnabled && (
                      <button
                        type="button"
                        onClick={() => setShowSkipConfirm(true)}
                        disabled={checkoutBusy}
                        className="cursor-pointer text-xs text-text-muted underline decoration-dotted transition hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Buy without a preview
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {hasMockup && images.length > 1 && thumbsPreloaded && (
            <div className="no-scrollbar mt-3 flex gap-2 overflow-x-auto px-0.5 pb-1">
              {images.map((m, i) => (
                <button
                  key={m.style_id}
                  type="button"
                  onClick={() => setActiveImageIndex(i)}
                  aria-pressed={i === activeImageIndex}
                  title={m.display_name}
                  style={{ animationDelay: `${80 + Math.min(i, 10) * 40}ms` }}
                  className={
                    'group relative h-16 w-16 shrink-0 cursor-pointer overflow-hidden rounded-lg border-2 transition animate-reveal-quick focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-interactive ' +
                    (i === activeImageIndex ? 'border-accent' : 'border-hairline hover:border-text-muted')
                  }
                >
                  {/* Plain <img>, not FadeImage: thumbsPreloaded above already guarantees this
                      exact URL finished loading before this button ever mounts, so FadeImage's
                      own skeleton-then-fade would just be a second, independent opacity
                      transition racing the wrapper's animate-reveal-quick slide-in -- in
                      practice the image's fade dominates what's visible and reads as the
                      thumbnail "popping in" in place, masking the wrapper's own slide. A plain
                      tag has nothing to fade on its own, so the wrapper's animation is the only
                      thing driving the reveal. */}
                  <img
                    src={m.mockup_url}
                    alt={m.display_name}
                    className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.2]"
                  />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Purchase panel: size/color, quantity, total, checkout. */}
        <div>
          <div className="flex items-baseline justify-between">
            <h2 className="font-quicksand text-sm font-bold uppercase tracking-wide text-text-secondary">
              2. Size{hasMultipleColors ? ' & color' : ''}
            </h2>
            <span className="font-quicksand text-sm font-bold text-text">${variant.price}</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {variants.map(v => {
              const selected = v.id === variant.id;
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setSelectedVariantId(v.id)}
                  aria-pressed={selected}
                  className={
                    'cursor-pointer rounded-lg border px-3 py-2 font-quicksand text-sm font-bold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-interactive ' +
                    (selected
                      ? 'border-accent bg-accent text-white'
                      : 'border-hairline text-text-secondary hover:border-text')
                  }
                >
                  {v.size}
                  {hasMultipleColors && v.color ? ` / ${v.color}` : ''}
                </button>
              );
            })}
          </div>

          <div className="mt-8">
            <h2 className="font-quicksand text-sm font-bold uppercase tracking-wide text-text-secondary">
              Quantity
            </h2>
            <div className="mt-3 inline-flex items-center gap-4 rounded-lg border border-hairline px-4 py-2">
              <button
                type="button"
                onClick={() => setQty(q => Math.max(1, q - 1))}
                aria-label="Decrease quantity"
                className="cursor-pointer font-quicksand text-lg text-text-secondary hover:text-text"
              >
                −
              </button>
              <span className="w-4 text-center font-quicksand font-bold text-text">{qty}</span>
              <button
                type="button"
                onClick={() => setQty(q => Math.min(10, q + 1))}
                aria-label="Increase quantity"
                className="cursor-pointer font-quicksand text-lg text-text-secondary hover:text-text"
              >
                +
              </button>
            </div>
          </div>

          <div className="mt-8 border-t border-hairline pt-6">
            <div className="flex items-baseline justify-between">
              <span className="font-quicksand text-sm text-text-secondary">Subtotal</span>
              <span className="font-display text-2xl text-text">
                ${(variant.price * qty).toFixed(2)}
              </span>
            </div>
            <p className="mt-1 text-right text-xs text-text-muted">
              Shipping &amp; tax calculated at checkout.
            </p>

            {!user ? (
              <Button as={Link} to="/account" className="mt-4 w-full">
                Sign in to buy
              </Button>
            ) : (
              <Button
                className="mt-4 w-full"
                disabled={!storeEnabled || !hasMockup || checkoutBusy}
                aria-busy={checkoutBusy}
                onClick={onBuyNowClick}
              >
                {checkoutBusy ? 'Preparing checkout…' : 'Buy now'}
              </Button>
            )}
            {checkoutBusy && (
              <div className="mt-3 flex flex-col items-center gap-1 text-center" aria-live="polite">
                <ScrambleText
                  text={statusNarration(checkoutElapsed, checkoutNarrationPicksRef.current, CHECKOUT_TIMELINE)}
                  className="max-w-xs text-xs text-text-secondary"
                />
                <p className="font-mono text-[11px] text-text-muted">
                  {checkoutProgress && checkoutProgress.total > 0
                    ? `print file ${Math.min(checkoutProgress.done + 1, checkoutProgress.total)} of ${checkoutProgress.total} · `
                    : ''}
                  {checkoutElapsed}s elapsed
                </p>
              </div>
            )}
            <div className="mt-4 space-y-1.5">
              {user && !storeEnabled && (
                <p className="text-xs leading-tight text-accent">
                  Store purchasing is temporarily offline. Please check back soon.
                </p>
              )}
              {user && storeEnabled && !hasMockup && (
                <p className="text-xs leading-tight text-text-muted">
                  Generate a mockup above before you check out, or{' '}
                  <button
                    type="button"
                    onClick={() => setShowSkipConfirm(true)}
                    disabled={checkoutBusy}
                    className="cursor-pointer underline decoration-dotted hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    buy without a preview
                  </button>
                  .
                </p>
              )}
              {checkoutNotice && (
                <p className="animate-pop-in text-xs leading-tight text-accent">{checkoutNotice}</p>
              )}
              <p className="text-xs leading-tight text-text-muted">
                Printed on demand and shipped by Printful. No returns on custom prints.
              </p>
            </div>
          </div>
        </div>
      </div>

      <ArtworkPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={onPickDesign}
      />

      <ConfirmDialog
        open={showSkipConfirm}
        title="Skip the preview?"
        message="You haven't seen a mockup of this design on the garment yet. Your artwork still prints exactly as designed -- you'll just check out without a preview photo of it on the product first."
        confirmLabel="Buy without preview"
        cancelLabel="Keep waiting"
        onConfirm={() => {
          setShowSkipConfirm(false);
          onBuyNowClick();
        }}
        onCancel={() => setShowSkipConfirm(false)}
      />
    </PageContainer>
  );
}
