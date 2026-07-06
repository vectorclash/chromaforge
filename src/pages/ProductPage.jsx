import React, { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { gsap, TextPlugin } from 'gsap/all';
import PageContainer from '../components/ui/PageContainer';
import Button from '../components/ui/Button';
import FadeImage from '../components/ui/FadeImage';
import HexagonLoader from '../components/HexagonLoader';
import {
  getCatalogProduct,
  getPrintfileSpecs,
  getMockupConfigForProduct,
  getGeometryPlacementOptions,
  hasTwoLegCanvas,
  resolvePlacementEntries,
  renderAndUploadPrintFiles,
  renderPrintFileStrategy
} from '../lib/printful';
import { listMyDesigns, getThumbnailUrl } from '../lib/designs';
import { createCheckoutSession } from '../lib/checkout';
import { useStudio } from '../context/StudioContext';
import { isSameDesign } from '../render/designSettings';
import { useAuth } from '../context/AuthContext';
import { useMockup, BUSY_STATUSES } from '../hooks/useMockup';
import { useHoverScroll } from '../hooks/useHoverScroll';
import { usePageTitle } from '../hooks/usePageTitle';

gsap.registerPlugin(TextPlugin);

const STATUS_LABEL = {
  rendering: 'Rendering design…',
  creating: 'Sending to Printful…',
  polling: 'Generating mockup…'
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
function statusNarration(elapsedSeconds, picks) {
  let idx = 0;
  for (let i = 0; i < STATUS_TIMELINE.length; i++) {
    if (STATUS_TIMELINE[i].at > elapsedSeconds) break;
    idx = i;
  }
  if (!picks.has(idx)) {
    const options = STATUS_TIMELINE[idx].texts;
    picks.set(idx, options[Math.floor(Math.random() * options.length)]);
  }
  return preventOrphan(picks.get(idx));
}

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
  const {
    status,
    error: mockupError,
    images,
    elapsedSeconds,
    generate,
    sync: syncMockup
  } = useMockup();

  const [detail, setDetail] = useState(null); // { product, variants }
  usePageTitle(detail?.product?.title || 'Shop');
  const [printfileSpecs, setPrintfileSpecs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedVariantId, setSelectedVariantId] = useState(null);
  const [qty, setQty] = useState(1);
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [checkoutNotice, setCheckoutNotice] = useState(null);
  const [checkoutBusy, setCheckoutBusy] = useState(false);

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
  // (consumed once on mount, see below) alongside the user's own saved designs.
  const [myDesigns, setMyDesigns] = useState([]);
  const [myDesignsLoading, setMyDesignsLoading] = useState(false);
  const [queuedChoice, setQueuedChoice] = useState(null);
  const [selectedKey, setSelectedKey] = useState('current');
  const consumedQueueRef = useRef(false);

  // Holds off the artwork strip's hover-driven auto-scroll (see useHoverScroll) until the
  // saved-designs fetch has resolved AND the resulting batch of thumbnails has finished its
  // staggered fade-slide-up entrance (up to 500ms delay + 500ms duration, see
  // tailwind.css) -- engaging it any earlier meant a user hovering near an edge right as
  // designs finished loading got the auto-scroll animating scrollLeft at the same time new
  // items were still sliding into the strip, which read as genuinely messy.
  const [artworkStripSettled, setArtworkStripSettled] = useState(!myDesignsLoading);
  useEffect(() => {
    if (myDesignsLoading) {
      setArtworkStripSettled(false);
      return;
    }
    const timer = setTimeout(() => setArtworkStripSettled(true), 1000);
    return () => clearTimeout(timer);
  }, [myDesignsLoading]);
  const artworkStripRef = useHoverScroll(artworkStripSettled);

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

  // The user's own saved (non-animation -- the mockup pipeline expects a flat
  // { seed, colors } design, not a frames array) designs, as artwork choices.
  useEffect(() => {
    if (!user) {
      setMyDesigns([]);
      setMyDesignsLoading(false);
      return;
    }
    let cancelled = false;
    setMyDesignsLoading(true);
    listMyDesigns()
      .then(rows => {
        if (!cancelled) setMyDesigns(rows.filter(d => d.kind !== 'animation'));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setMyDesignsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  // A new mockup batch always starts on its first (front-facing) image.
  useEffect(() => {
    setActiveImageIndex(0);
  }, [images]);

  const choices = [
    { key: 'current', label: 'Current studio design', thumb: studioPreviewUrl, data: currentDesign },
    ...(queuedChoice
      ? [
          {
            key: 'queued',
            label: queuedChoice.title || 'Untitled',
            thumb: getThumbnailUrl(queuedChoice.user_id, queuedChoice.id),
            data: queuedChoice.data
          }
        ]
      : []),
    ...myDesigns
      .filter(d => !queuedChoice || d.id !== queuedChoice.id)
      // Drop a saved design that's identical (seed/colors/settings) to the live studio
      // design already shown as "Current studio design" above -- without this, saving from
      // the studio and landing here straight after showed the same artwork twice: once as
      // the live 480x480 preview (StudioContext's PREVIEW_SIZE), once as the just-uploaded
      // 320x320 stored thumbnail (THUMBNAIL_SIZE). Both are legitimate recompose-per-ratio
      // renders of the identical seed at genuinely different resolutions (see scale.js's
      // getCountScale -- a smaller canvas keeps a smaller slice of the same generated
      // element set), so they're subtly different images of what's actually one design,
      // which read as confusing duplicates rather than the same choice shown twice.
      .filter(d => !isSameDesign(currentDesign, d.data))
      .map(d => ({
        key: d.id,
        label: d.title || 'Untitled',
        thumb: getThumbnailUrl(d.user_id, d.id),
        data: d.data
      }))
  ];
  const selectedChoice = choices.find(c => c.key === selectedKey) || choices[0];
  const selectedDesign = selectedChoice.data;

  const product = detail?.product;
  const variants = detail?.variants;
  // Store-wide purchasing kill switch (see supabase/functions/_shared/storeStatus.ts) --
  // browsing/mockups stay fully operational regardless, only the real purchase is gated.
  const storeEnabled = detail?.storeEnabled ?? true;
  const variant = variants ? variants.find(v => v.id === selectedVariantId) || variants[0] : null;

  // Switching artwork or variant: restore an already-generated mockup for this exact combo
  // instantly (e.g. every size of a t-shirt in the same color shares one print file, so
  // there's nothing new to render -- see useMockup's cache), otherwise drop back to idle so
  // the previous selection's mockup doesn't keep showing as if it were current.
  const geometryPlacementsSignature = [...geometryPlacements].sort().join(',');
  useEffect(() => {
    if (!product || !variant || !printfileSpecs) return;
    syncMockup({ product, printfileSpecs, variant, design: selectedDesign, geometryPlacements, geometryLayout: effectiveGeometryLayout });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, selectedVariantId, product, printfileSpecs, geometryPlacementsSignature, effectiveGeometryLayout]);

  const hasMockup = status === 'completed' && images.length > 0;

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
  const heroImage = hasMockup ? images[activeImageIndex].mockup_url : product.image;

  const onGenerateClick = () =>
    generate({ product, printfileSpecs, variant, design: selectedDesign, geometryPlacements, geometryLayout: effectiveGeometryLayout });

  // Real purchase: render+upload a print file for every placement the variant has (not just
  // the mockup-visible subset useMockup uses -- see lib/printful.js's resolvePlacementEntries
  // for why), then hand off to Stripe's hosted Checkout page. Gated behind a real mockup
  // existing (disabled below), since buying before seeing what you're printing doesn't make
  // sense regardless of payments. geometryPlacements/geometryLayout ride along so the print
  // files match exactly what the approved mockup showed -- the customer could otherwise
  // toggle a checkbox or the layout after generating a mockup and buy something they never
  // previewed.
  const onBuyNowClick = async () => {
    setCheckoutBusy(true);
    setCheckoutNotice(null);
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
        geometryLayout: effectiveGeometryLayout
      });
      const { url, orderId } = await createCheckoutSession({
        productId: product.id,
        productTitle: product.title,
        variantId: variant.id,
        variantLabel: `${variant.size}${hasMultipleColors && variant.color ? ` / ${variant.color}` : ''}`,
        quantity: qty,
        design: selectedDesign,
        printFileUrls,
        productOptions: cfg.productOptions
      });
      // CheckoutSuccessPage reads this rather than looking the order up by Stripe session
      // id -- simpler, and avoids needing a session-id-keyed lookup RPC.
      sessionStorage.setItem('chromaforge:lastOrderId', orderId);
      window.location.href = url;
    } catch (err) {
      setCheckoutNotice(err.message);
      setCheckoutBusy(false);
    }
  };

  return (
    <PageContainer
      title={product.title}
      actions={
        <Link to="/shop" className="font-quicksand text-sm text-text-muted transition hover:text-text">
          ← Shop
        </Link>
      }
    >
      {/* Step 1: artwork. Full-width, above the gallery/purchase columns -- it drives both. */}
      <div className="mb-8">
        <h2 className="font-quicksand text-sm font-bold uppercase tracking-wide text-text-secondary">
          1. Choose artwork
        </h2>
        <div ref={artworkStripRef} className="no-scrollbar mt-3 flex gap-2 overflow-x-auto px-0.5 pb-1">
          {choices.map((c, i) => {
            const selected = c.key === selectedKey;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => setSelectedKey(c.key)}
                aria-pressed={selected}
                title={c.label}
                style={{ animationDelay: `${Math.min(i, 10) * 50}ms` }}
                className={
                  'group relative h-16 w-16 shrink-0 cursor-pointer overflow-hidden rounded-lg border-2 bg-ink-900 transition animate-fade-slide-up focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-interactive ' +
                  (selected ? 'border-accent' : 'border-hairline hover:border-text-muted')
                }
              >
                {c.thumb && (
                  <FadeImage
                    src={c.thumb}
                    alt={c.label}
                    className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.2]"
                  />
                )}
              </button>
            );
          })}
          {/* Saved designs load in after "Current studio design" is already showing -- without
              this, the strip looks complete with just the one choice and there's no hint that
              more are on the way once listMyDesigns() resolves. */}
          {myDesignsLoading &&
            [0, 1, 2].map(i => (
              <div
                key={`loading-${i}`}
                aria-hidden="true"
                className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border-2 border-hairline bg-ink-900"
              >
                <div
                  className="absolute inset-0 animate-pulse bg-ink-700"
                  style={{ animationDelay: `${i * 150}ms` }}
                />
              </div>
            ))}
        </div>
        <p className="mt-2 truncate text-xs text-text-secondary">{selectedChoice.label}</p>
        {!user && (
          <p className="mt-1 text-xs text-text-muted">
            <Link to="/account" className="text-accent underline">Sign in</Link> to choose from your saved designs.
          </p>
        )}
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
                      text={statusNarration(elapsedSeconds, narrationPicksRef.current)}
                      className="max-w-xs animate-reveal-quick text-xs text-text-secondary"
                      style={{ animationDelay: '120ms' }}
                    />
                    <p className="animate-reveal-quick font-mono text-[11px] text-text-muted" style={{ animationDelay: '180ms' }}>
                      {elapsedSeconds}s elapsed
                    </p>
                  </div>
                ) : status === 'failed' ? (
                  <div className="flex animate-pop-in flex-col items-center gap-3 text-center">
                    <p className="max-w-xs text-sm text-accent">{mockupError}</p>
                    <Button onClick={onGenerateClick} disabled={!selectedDesign}>
                      Try again
                    </Button>
                  </div>
                ) : (
                  <Button onClick={onGenerateClick} disabled={!selectedDesign}>
                    Generate mockup
                  </Button>
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
            <div className="mt-4 space-y-1.5">
              {user && !storeEnabled && (
                <p className="text-xs leading-tight text-accent">
                  Store purchasing is temporarily offline. Please check back soon.
                </p>
              )}
              {user && storeEnabled && !hasMockup && (
                <p className="text-xs leading-tight text-text-muted">
                  Generate a mockup above before you check out.
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
    </PageContainer>
  );
}
