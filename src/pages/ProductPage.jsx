import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { gsap, TextPlugin } from 'gsap/all';
import PageContainer from '../components/ui/PageContainer';
import Button from '../components/ui/Button';
import FadeImage from '../components/ui/FadeImage';
import GenerateGlow from '../components/ui/GenerateGlow';
import HexagonLoader from '../components/HexagonLoader';
import { useCrossfadeImage } from '../hooks/useCrossfadeImage';
import {
  getCatalogProduct,
  getPrintfileSpecs,
  getMockupConfigForProduct,
  getSecondaryDesignConfig,
  getMirrorPlacements,
  getGeometryPlacementOptions,
  getStitchColorOption,
  hasTwoLegCanvas,
  getLegPanel,
  resolvePlacementEntries,
  renderAndUploadPrintFiles,
  renderPrintFileStrategy
} from '../lib/printful';
import { getThumbnailUrl } from '../lib/designs';
import { createCheckoutSession } from '../lib/checkout';
import { guessShippingRegion } from '../lib/regionGuess';
import { useStudio } from '../context/StudioContext';
import { isSameDesign } from '../render/designSettings';
import { withCurrentGeneratorVersion } from '../render/compactDesign';
import { useAuth } from '../context/AuthContext';
import { useMockup, BUSY_STATUSES } from '../hooks/useMockup';
import ArtworkPickerModal from '../components/ui/ArtworkPickerModal';
import BuyNowModal from '../components/ui/BuyNowModal';
import { usePageMeta } from '../hooks/usePageMeta';
import { useJsonLd } from '../hooks/useJsonLd';
import SizeGuideModal from '../components/ui/SizeGuideModal';

gsap.registerPlugin(TextPlugin);

// How long the hero's mockup layer takes to fade OUT -- must stay in step with the
// duration-200 class on it. Only used to keep the <img> mounted long enough to animate
// before it is dropped. The blank/button layer underneath never animates at all.
const HERO_FADE_OUT_MS = 200;

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
  const currentTileCrossfade = useCrossfadeImage(studioPreviewUrl);
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
  // null | 'confirm' | 'preparing' | 'error' -- drives BuyNowModal, which now owns the
  // entire Buy Now flow (see that component's header comment for why).
  const [buyModalStage, setBuyModalStage] = useState(null);
  const checkoutBusy = buyModalStage === 'preparing';

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
  // leg. Same per-order, not-part-of-the-design treatment as geometryPlacements above.
  // Defaults to 'mirror' (Aaron's call, 2026-07-25) -- it was 'single' originally, chosen as
  // the closer-to-how-everything-else-looks option, but a shape spanning both legs is the
  // better default look and matches the seam-mirroring default below.
  const [geometryLayout, setGeometryLayout] = useState('mirror');
  // Reflects the print's left half onto its right, so the two legs become mirror images and
  // the pattern meets itself at the centre-front seam (see renderArtwork.js's legSymmetry).
  // Off by default: bilateral symmetry is a strong look, not a neutral improvement, so it is
  // the customer's opt-in rather than a taste decided for everyone.
  const [legSymmetry, setLegSymmetry] = useState(false);
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
  // Forced to 'single' while Leg symmetry is on. Under symmetry the sheet mirror IS the
  // mirroring mechanism, so legLayout 'mirror' stacks a second, narrower one inside it: the
  // 3*width/4 copy's shapes bleed back left across the centre, and the sheet mirror then
  // duplicates that too, producing visibly doubled/overlapping geometry (caught live by
  // Aaron, 2026-07-29). Forcing 'single' is also what makes the hidden row honest -- the
  // control isn't inert, it's decided. Note geometryLayout DEFAULTS to 'mirror', so without
  // this the overlap is exactly what someone gets by just switching symmetry on.
  const effectiveGeometryLayout = showsTwoLegLayout ? (legSymmetry ? 'single' : geometryLayout) : null;
  useEffect(() => {
    setGeometryLayout('mirror');
  }, [detail?.product?.id]);

  // Which frame the composition's element sizes are measured against on a product whose
  // printfile is cut into separately-visible panels. 'sheet' (the default) sizes to the
  // whole printfile; 'panel' sizes to one leg, so a single leg shows a complete composition
  // instead of a magnified slice of one. Per-order render context, never saved with the
  // design -- same treatment as geometryLayout and mirrorSeams.
  const [artworkScale, setArtworkScale] = useState('sheet');
  const legPanel = detail?.product ? getLegPanel(getMockupConfigForProduct(detail.product.id)) : null;
  // Gated once and used everywhere, for the same reason effectiveGeometryLayout is: a
  // sizeFrame leaking onto a product with no legPanel would silently rescale every other
  // garment in the catalogue.
  const effectiveSizeFrame = legPanel && artworkScale === 'panel' ? legPanel : null;
  useEffect(() => {
    setArtworkScale('sheet');
  }, [detail?.product?.id]);

  const effectiveLegSymmetry = showsTwoLegLayout && legSymmetry;
  useEffect(() => {
    setLegSymmetry(false);
  }, [detail?.product?.id]);

  // Whether this product's back half prints mirrored so the pattern continues across its
  // visible side seams (bucket hat only -- see PRODUCT_MOCKUP_CONFIG's mirrorPlacements for
  // the geometry and why mirroring closes both seams at once). Per-order, not saved with the
  // design, same as every other choice on this page. Defaults ON: the unmirrored version
  // visibly restarts the composition at each seam, which reads as a defect rather than a
  // style, so continuous is the better default and opting out is the deliberate act.
  const [mirrorSeams, setMirrorSeams] = useState(true);
  const productMirrorPlacements = detail?.product
    ? getMirrorPlacements(getMockupConfigForProduct(detail.product.id))
    : null;
  // Same gating discipline as effectiveGeometryLayout above -- resolve once, use everywhere,
  // so the flag can never reach a product that doesn't declare mirrorable placements.
  const effectiveMirrorPlacements = mirrorSeams ? productMirrorPlacements : null;
  useEffect(() => {
    setMirrorSeams(true);
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
  useEffect(() => {
    // Real bug, caught live 2026-07-21 while dev-server-testing BuyNowModal (dev-only --
    // StrictMode never runs in production, which is why this never surfaced against the
    // deployed site): a cleanup-only effect (`useEffect(() => () => {...}, [])`) never
    // resets isMountedRef back to true on setup, only ever flips it false on cleanup. Under
    // StrictMode's dev-mode mount->cleanup->remount double-invoke, that cleanup fires once
    // immediately after the first simulated mount -- permanently pinning this to `false` for
    // the rest of the component's real lifetime, silently no-oping the `if
    // (!isMountedRef.current) return;` guards below forever after, even though the page
    // never actually navigated away. Real checkout logs confirmed the render/upload and
    // Stripe session creation completed successfully server-side; the client just silently
    // dropped the redirect. Setting it true here too closes the gap.
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Stripe bounces back here with ?checkout=canceled on cancel_url -- no dedicated cancel
  // page, just surface it through BuyNowModal's error stage.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('checkout') === 'canceled') {
      setCheckoutNotice('Checkout canceled -- your card was not charged.');
      setBuyModalStage('error');
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
  const [sizeGuideOpen, setSizeGuideOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState('current');
  const consumedQueueRef = useRef(false);

  // Which artwork slot the gallery modal is currently filling. 'primary' is every product's
  // only slot; 'secondary' is the reversible bucket hat's inside face (see
  // getSecondaryDesignConfig). One modal, one target ref -- opening it from either place
  // reuses the same component and the same paginated fetch.
  const [pickerTarget, setPickerTarget] = useState('primary');
  const [secondaryChoice, setSecondaryChoice] = useState(null);

  // A pick from the modal that's actually one of the pinned tiles (the live studio design
  // again, or the queued hand-off) selects that tile instead of duplicating it as a third.
  const onPickDesign = design => {
    setPickerOpen(false);
    if (pickerTarget === 'secondary') {
      setSecondaryChoice(design);
      return;
    }
    if (isSameDesign(currentDesign, design.data)) {
      setSelectedKey('current');
    } else if (queuedChoice && design.id === queuedChoice.id) {
      setSelectedKey('queued');
    } else {
      setPickedChoice(design);
      setSelectedKey('picked');
    }
  };

  const openPicker = target => {
    setPickerTarget(target);
    setPickerOpen(true);
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

  // Stamped ONCE per source design, not per render. withCurrentGeneratorVersion returns a
  // new object every call ({ ...design, generatorVersion }), and selectedDesign -- which is
  // whichever of these tiles is selected -- is a dependency of the mockup sync effect below.
  // Calling it inline in `choices` therefore handed that effect a brand-new object identity
  // on every render whenever a queued or gallery-picked design was selected, so the effect
  // re-ran, set state, re-rendered, and looped until React bailed out with "Maximum update
  // depth exceeded". Only the 'current' tile escaped it, because that one passes
  // StudioContext's stable currentDesign straight through -- which is why the page looked
  // fine until an artwork was actually picked from the gallery.
  const queuedDesignData = useMemo(
    () => (queuedChoice ? withCurrentGeneratorVersion(queuedChoice.data) : null),
    [queuedChoice]
  );
  const pickedDesignData = useMemo(
    () => (pickedChoice ? withCurrentGeneratorVersion(pickedChoice.data) : null),
    [pickedChoice]
  );

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
            // Stored rows carry the generatorVersion they were SAVED under, which the client
            // renderer ignores (it always regenerates with the current bundle's code) but
            // render-service hard-fails on -- see withCurrentGeneratorVersion. Stamped here,
            // at the point of adoption, so the mockup, the print file, and order_items'
            // design_data audit copy all agree on one version.
            data: queuedDesignData
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
            // Same re-stamp as the queued tile above.
            data: pickedDesignData
          }
        ]
      : [])
  ];
  const selectedChoice = choices.find(c => c.key === selectedKey) || choices[0];
  const selectedDesign = selectedChoice.data;

  // Optional second design for a physically separate face of the same garment (bucket hat's
  // inside). Same re-stamp as the gallery tiles above -- a stored row's generatorVersion is
  // what it was SAVED under, and render-service hard-fails on a stale one.
  const secondaryDesignConfig = detail?.product
    ? getSecondaryDesignConfig(getMockupConfigForProduct(detail.product.id))
    : null;
  // Memoised for the same reason as the tiles above -- this one is only read from event
  // handlers today so it can't loop, but leaving an unstable identity around for the next
  // person to drop into a dependency array is how that bug happens twice.
  const secondaryDesign = useMemo(
    () => (secondaryChoice ? withCurrentGeneratorVersion(secondaryChoice.data) : null),
    [secondaryChoice]
  );

  // Collapsed by default: these all have good defaults, so the common purchase never needs
  // to open this at all. Not persisted -- a customer who opens it on one product shouldn't
  // find it open on the next, since which options even exist differs per product.
  const [printOptionsOpen, setPrintOptionsOpen] = useState(false);
  useEffect(() => {
    setPrintOptionsOpen(false);
  }, [detail?.product?.id]);

  // Reset when the product changes, same as every other per-order choice on this page.
  useEffect(() => {
    setSecondaryChoice(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.product?.id]);

  const product = detail?.product;
  const variants = detail?.variants;
  // Store-wide purchasing kill switch (see supabase/functions/_shared/storeStatus.ts) --
  // browsing/mockups stay fully operational regardless, only the real purchase is gated.
  const storeEnabled = detail?.storeEnabled ?? true;
  const variant = variants ? variants.find(v => v.id === selectedVariantId) || variants[0] : null;
  const hasMockup = status === 'completed' && images.length > 0;
  const heroMockupUrl = hasMockup ? images[activeImageIndex]?.mockup_url : null;

  // PRELOAD before swapping. Without this the hero switched to a URL the browser had not
  // fetched yet, so the scrim vanished the instant hasMockup flipped while the image was
  // still arriving underneath -- two changes at one moment, out of step, which is what read
  // as a pop (Aaron, live, 2026-07-29). Decoding first means the swap and the scrim's exit
  // are the same commit, with nothing half-drawn in between. Same technique the angle-
  // thumbnail strip already uses below (thumbsPreloaded) for the same reason.
  const [readyHeroUrl, setReadyHeroUrl] = useState(null);
  useEffect(() => {
    if (!heroMockupUrl) return;
    let cancelled = false;
    const probe = new window.Image();
    // onerror too: a mockup URL that 404s must not strand the hero on the stock photo with
    // no way out -- showing a broken image is the honest failure, and <img> renders its alt.
    const done = () => !cancelled && setReadyHeroUrl(heroMockupUrl);
    probe.onload = done;
    probe.onerror = done;
    probe.src = heroMockupUrl;
    if (probe.complete) done();
    return () => {
      cancelled = true;
    };
  }, [heroMockupUrl]);

  // Cleared whenever the mockup goes away (a print option changed, a new run started) so a
  // freshly-completed generation can never briefly display the PREVIOUS run's image while its
  // own is still preloading. Switching camera angle does NOT clear it -- hasMockup stays true
  // there, so the current image holds on screen until the next one has decoded and can swap
  // in with nothing in between.
  // Cleared AFTER the fade, not during it: unmounting the <img> the moment hasMockup went
  // false removed the element mid-transition, so it vanished instead of fading. It stays
  // mounted at opacity 0 for the length of the fade and is dropped once it is invisible.
  useEffect(() => {
    if (hasMockup) return;
    const timer = setTimeout(() => setReadyHeroUrl(null), HERO_FADE_OUT_MS);
    return () => clearTimeout(timer);
  }, [hasMockup]);

  // Layered, not swapped (Aaron's call, 2026-07-29). The stock photo, scrim and button are a
  // STATIC base that never animates; the mockup is a layer on top of it that fades in when
  // ready and out when it goes away. Nothing else moves, so there is exactly one animation
  // rather than a sequence of them trying to look like one -- which is what the previous
  // swap-the-src-and-fade-the-scrim version could never quite do.
  const showMockup = hasMockup && !!readyHeroUrl;

  // The layer MOUNTS when readyHeroUrl is first set, and an element that mounts already at
  // opacity-100 has nothing to transition FROM -- so it appeared instantly on a fresh
  // generation while behaving on later swaps, where the element already existed. It now mounts
  // transparent and is flipped on a later frame, so the browser has two distinct painted
  // values to animate between. Two rAFs, not one: a single frame can still be batched into the
  // same paint (same reason FadeImage's own reveal defers twice).
  // Only reset when the layer actually goes away (readyHeroUrl null). A camera-angle switch
  // changes readyHeroUrl non-null -> non-null and must NOT reset this, or the visible image
  // would drop to transparent and flash before coming back.
  const scrimModeRef = useRef('generate');
  const [mockupFadedIn, setMockupFadedIn] = useState(false);
  useEffect(() => {
    if (!readyHeroUrl) {
      setMockupFadedIn(false);
      return;
    }
    let inner;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setMockupFadedIn(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      if (inner) cancelAnimationFrame(inner);
    };
  }, [readyHeroUrl]);



  // Deliberately NOT gated on the preload: this is the URL handed to page meta/OG tags and to
  // the Stripe line item, which care about which image represents this order, not about what
  // is painted right now. Falls back to the product's stock photo exactly as before.
  const heroImage = heroMockupUrl || product?.image;

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
      sizeFrame: effectiveSizeFrame,
      legSymmetry: effectiveLegSymmetry,
      mirrorPlacements: effectiveMirrorPlacements,
      productOptions: stitchColorProductOptions
    });
    // pickedChoice?.id matters on its own: picking a second gallery design replaces the
    // 'picked' tile's contents without selectedKey ever changing.
    // secondaryDesign is deliberately NOT a dependency, and is not passed to syncMockup at
    // all: the mockup only ever requests cfg.placements, which on the one product with a
    // secondary design excludes both inside placements (no camera angle shows them). Adding
    // it would throw away a still-accurate mockup and make the customer sit through another
    // 30-90s Printful round trip that renders a pixel-identical photo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, pickedChoice?.id, selectedDesign, selectedVariantId, product, printfileSpecs, geometryPlacementsSignature, effectiveGeometryLayout, effectiveSizeFrame, effectiveLegSymmetry, mirrorSeams, stitchColor]);

  // The hero deliberately has NO animation class of its own. It used to carry
  // --animate-reveal-quick on a fresh generation and --animate-pop-in otherwise, chosen by a
  // small state machine -- and every bug in this slot came from that (Aaron, live,
  // 2026-07-29): both keyframe sets animate OPACITY, which is also what FadeImage transitions,
  // and a CSS animation overrides an element's own transition outright. Two owners of one
  // property, so they could not be reconciled by tuning either side -- generating a mockup ran
  // both at once and read as two conflicting fades, while a cache restore or an angle switch
  // replayed an arrival animation for content the customer had not experienced as arriving.
  // FadeImage is now the single owner of the hero's opacity: skeleton while an image is really
  // being fetched, instant when the browser already has it (see isAlreadyDecoded), and instant
  // for the no-mockup backdrop. The staggered reveal that made a completed generation feel
  // like arrival still exists on the surrounding copy and the angle-thumbnail strip, which own
  // their own opacity and so never conflicted. Don't reintroduce an animation class here
  // without moving opacity out of one of the two systems first.

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

  // Printful's variant "color" doesn't always mean the colour of the garment -- on the
  // windbreaker both options are the same white jacket and only the zipper/stitching differ,
  // so that product overrides the label and adds a hint (see PRODUCT_MOCKUP_CONFIG).
  const colorLabel = getMockupConfigForProduct(product.id).colorLabel || 'Color';
  const colorHint = getMockupConfigForProduct(product.id).colorHint || null;
  const colorOptions = [...new Set(variants.map(v => v.color).filter(Boolean))];
  const hasMultipleColors = colorOptions.length > 1;
  // Sizes offered for the colour currently selected. Falls back to every variant when the
  // product has no colour dimension at all (the pillow reports color: null).
  const sizeVariants = hasMultipleColors ? variants.filter(v => v.color === variant.color) : variants;

  // Where the colour picker belongs depends on what the colour MEANS. A product that
  // overrides colorLabel is declaring its variant colour is a finish detail rather than the
  // colour of the thing you're buying (the windbreaker: both variants are the same white
  // jacket, only the zipper and stitching differ) -- that's the same decision every other
  // product makes via its stitch_color option, which lives in Print options, so it belongs
  // there too. Without the override the colour is real and is part of what you're choosing
  // (the tote's Black/Red/Yellow are three different bags), so it stays beside size.
  // Safe to bury for the windbreaker specifically, and checked rather than assumed: its two
  // colours are the same price at every size (price varies by size only) and both are in
  // stock, so nothing behind the disclosure can change the price or availability.
  const colorIsFinish = hasMultipleColors && colorLabel !== 'Color';
  const showColorWithSize = hasMultipleColors && !colorIsFinish;

  const colorPicker = hasMultipleColors ? (
    <div className={showColorWithSize ? 'mt-3' : ''}>
      <p className="font-quicksand text-xs font-bold uppercase tracking-wide text-text-muted">
        {colorLabel}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {colorOptions.map(color => {
          const selected = color === variant.color;
          return (
            <button
              key={color}
              type="button"
              onClick={() => {
                // Keep the size when the incoming colour stocks it; otherwise fall back to
                // that colour's first variant so a switch can never land on nothing.
                const sameSize = variants.find(v => v.color === color && v.size === variant.size);
                const fallback = variants.find(v => v.color === color);
                setSelectedVariantId((sameSize || fallback)?.id ?? null);
              }}
              aria-pressed={selected}
              className={
                'cursor-pointer rounded-lg border px-3 py-2 font-quicksand text-sm font-bold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-interactive ' +
                (selected ? 'border-accent bg-accent text-ink-950' : 'border-hairline text-text-secondary hover:border-text')
              }
            >
              {color}
            </button>
          );
        })}
      </div>
      {colorHint && <p className="mt-2 max-w-prose text-xs text-text-muted">{colorHint}</p>}
    </div>
  ) : null;

  // Declared HERE, after the variant/colour derivations, not up with the other UI state:
  // both read colorIsFinish, and a `const` referenced before its declaration is a temporal
  // dead zone ReferenceError -- which the build does not catch and which would blank the
  // page on every render.
  // Which refinement sections this product actually has. Gated so a product with none of
  // them (nothing currently, but the config is per-product and this shouldn't assume)
  // doesn't render an empty disclosure.
  const hasPrintOptions =
    !!secondaryDesignConfig ||
    geometryOptions.length > 1 ||
    showsTwoLegLayout ||
    !!productMirrorPlacements ||
    !!stitchColorOption ||
    colorIsFinish;

  // The collapsed state's summary. Reads as a sentence of current choices so nothing set
  // here is invisible while the panel is shut -- see the disclosure's own comment for why
  // that matters. Order matches the sections inside.
  const printOptionsSummary = [
    // Reads "Black stitching" -- the label matters, since "Black" alone would imply a black
    // garment, which is exactly the misreading this product's override exists to prevent.
    colorIsFinish && variant?.color && `${variant.color} ${colorLabel.toLowerCase()}`,
    secondaryDesignConfig && (secondaryChoice ? `Inside: ${secondaryChoice.title || 'Untitled'}` : 'Same design both faces'),
    geometryOptions.length > 1 &&
      (geometryPlacements.size === 0
        ? 'No geometry'
        : geometryPlacements.size === geometryOptions.length
          ? 'Geometry on all panels'
          : `Geometry on ${geometryOptions
              .filter(o => geometryPlacements.has(o.key))
              .map(o => o.label.toLowerCase())
              .join(', ')}`),
    showsTwoLegLayout && legSymmetry && 'Mirrored legs',
    showsTwoLegLayout &&
      !legSymmetry &&
      (geometryLayout === 'mirror' ? 'Mirrored across legs' : 'Single leg'),
    legPanel && (artworkScale === 'panel' ? 'Scaled to one leg' : 'Scaled to full sheet'),
    // "Mirrored across legs" above can't collide with this: the two twoLegCanvas products
    // are exactly the ones excluded from mirrorPlacements, so only one of the pair ever runs.
    productMirrorPlacements && (mirrorSeams ? 'Back flipped' : 'Back same as front'),
    stitchColorOption && stitchColor && `${stitchColorOption.values[stitchColor] || stitchColor} stitching`
  ]
    .filter(Boolean)
    .join(' · ');
  const busy = BUSY_STATUSES.includes(status);

  // What the base layer shows, held frozen while a mockup exists. Without the freeze it snaps
  // the moment status hits 'completed' -- before the image has even preloaded -- so the loader
  // was replaced by the Generate button and only THEN faded. Frozen, the loading state stays
  // put and simply fades away under the incoming mockup; the mode updates again as soon as the
  // mockup is gone, so the way back shows the right thing fading in.
  const scrimMode = !user ? 'signin' : busy ? 'busy' : status === 'failed' ? 'failed' : 'generate';
  if (!hasMockup) scrimModeRef.current = scrimMode;
  const displayedScrimMode = hasMockup ? scrimModeRef.current : scrimMode;



  const onGenerateClick = () =>
    generate({
      product,
      printfileSpecs,
      variant,
      design: selectedDesign,
      geometryPlacements,
      geometryLayout: effectiveGeometryLayout,
      sizeFrame: effectiveSizeFrame,
      legSymmetry: effectiveLegSymmetry,
      mirrorPlacements: effectiveMirrorPlacements,
      productOptions: stitchColorProductOptions
    });

  // Real purchase: render+upload a print file for every placement the variant has (not just
  // the mockup-visible subset useMockup uses -- see lib/printful.js's resolvePlacementEntries
  // for why), then hand off to Stripe's hosted Checkout page. Buy Now is no longer gated
  // behind a real mockup existing -- BuyNowModal's own `confirm` stage is the "you haven't
  // previewed this yet" check now (see onBuyNowButtonClick below), replacing the old
  // ConfirmDialog-based "Buy without a preview" escape hatch. This function itself is
  // unchanged either way: the real print files render independently of whether a mockup was
  // ever generated, so heroImage (which already falls back to the product's stock photo when
  // !hasMockup) is the only thing that differs. geometryPlacements/geometryLayout ride along
  // so the print files match exactly what any approved mockup showed -- the customer could
  // otherwise toggle a checkbox or the layout after generating a mockup and buy something
  // they never previewed.
  const onBuyNowClick = async () => {
    // Re-arm the leave guard: after a Stripe redirect the ref stays true, and coming BACK
    // from Stripe can restore this page from the bfcache with all its state intact -- a
    // second Buy Now run would otherwise be unguarded.
    checkoutLeaveOkRef.current = false;
    setBuyModalStage('preparing');
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
      sizeFrame: effectiveSizeFrame,
      legSymmetry: effectiveLegSymmetry,
        // Null on every product but the reversible hat, and null there too unless the
        // customer actually picked a second design -- see getSecondaryDesignConfig.
        secondaryDesign,
        secondaryPlacements: secondaryDesignConfig?.placements || null,
        mirrorPlacements: effectiveMirrorPlacements,
        onProgress: (done, total) => setCheckoutProgress({ done, total })
      });
      // Renders finished; the remaining wait is session creation -- null the counts so the
      // UI stops saying "file N of M" once that's no longer what's happening.
      setCheckoutProgress(null);
      const { url, orderId } = await createCheckoutSession({
        productId: product.id,
        productTitle: product.title,
        variantId: variant.id,
        // Qualified with the product's own colour label so an order line reads "L / Black
        // stitching" rather than "L / Black", which would imply a black jacket.
        variantLabel: `${variant.size}${
          hasMultipleColors && variant.color
            ? ` / ${variant.color}${colorLabel === 'Color' ? '' : ` ${colorLabel.toLowerCase()}`}`
            : ''
        }`,
        quantity: qty,
        design: selectedDesign,
        // Recorded alongside the primary in order_items.design_data -- that column is the
        // order's only record of what was actually printed, and on a two-face order the
        // primary alone doesn't describe half the garment.
        secondaryDesign,
        printFileUrls,
        productOptions: stitchColorProductOptions || cfg.productOptions,
        // heroImage falls back to the product's stock photo when !hasMockup (see its own
        // definition) -- shows the actual approved garment mockup on Stripe's checkout page
        // when one exists, instead of a bare text line item.
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
      setBuyModalStage('error');
    }
  };

  // Buy Now itself is never disabled behind hasMockup anymore -- one click straight into
  // the modal's `preparing` stage when a mockup already exists, or a `confirm` stage first
  // ("you haven't previewed this yet") when it doesn't. BuyNowModal's `onContinue` prop
  // (used by both the confirm stage's Continue and the error stage's Try again) is this
  // exact same onBuyNowClick.
  const onBuyNowButtonClick = () => {
    if (hasMockup) onBuyNowClick();
    else setBuyModalStage('confirm');
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
                          ref={currentTileCrossfade.shownRef}
                          src={currentTileCrossfade.shown}
                          alt={c.label}
                          className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.15]"
                        />
                      )}
                      {currentTileCrossfade.incoming && (
                        <img
                          ref={currentTileCrossfade.incomingRef}
                          src={currentTileCrossfade.incoming}
                          alt={c.label}
                          className="absolute inset-0 h-full w-full object-cover"
                          style={{ opacity: 0 }}
                        />
                      )}
                      <GenerateGlow active={currentTileCrossfade.holding} blurClass="blur-xl" />
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
            onClick={() => openPicker('primary')}
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

      {/* Everything between "Choose artwork" and "Size" is a REFINEMENT, not a required
          step: each has a sensible default, each is per-order rather than saved to the
          design, and -- the property that actually groups them -- each one invalidates the
          current mockup. Four to five of them stacked open pushed the two things a customer
          must actually do (pick artwork, pick a size) far apart, so they collapse into a
          single disclosure rather than one accordion per section (five collapsed sections
          would be no less cluttered than five open ones, just with more clicks).
          The summary line is load-bearing, not decoration: because these settings invalidate
          the preview, hiding them bare would let someone change one, forget, and buy under
          settings they can no longer see. It also keeps the geometry-placement feature --
          the one thing no other print-on-demand store offers -- visible while collapsed.
          This is also what fixes the old numbering gap: "1. Choose artwork" and "2. Size"
          used to have four unnumbered sections wedged between them. One clearly-optional
          disclosure between two numbered required steps reads correctly, so the numbers stay
          on the required steps only rather than pretending this is step 2 of a sequence. */}
      {hasPrintOptions && (
        <div className="mb-8">
          <button
            type="button"
            onClick={() => setPrintOptionsOpen(open => !open)}
            aria-expanded={printOptionsOpen}
            aria-controls="print-options-panel"
            className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl border border-hairline px-4 py-3 text-left transition hover:border-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-interactive"
          >
            <span className="min-w-0">
              <span className="font-quicksand text-sm font-bold uppercase tracking-wide text-text-secondary">
                Print options
              </span>
              <span className="mt-0.5 block truncate text-xs text-text-muted">
                {printOptionsSummary}
              </span>
            </span>
            <svg
              viewBox="0 0 24 24"
              width={18}
              height={18}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className={
                'shrink-0 text-text-muted transition-transform duration-200 ' +
                (printOptionsOpen ? 'rotate-180' : '')
              }
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          {printOptionsOpen && (
            <div id="print-options-panel" className="mt-5 space-y-6 animate-fade-slide-up">
              {/* A finish-only colour dimension (see colorIsFinish) -- the windbreaker's
                  stitching. Shown here rather than beside size because it's the same choice
                  every other product makes through its stitch_color option below. */}
              {colorIsFinish && colorPicker}
        {/* Reversible products only (bucket hat): an optional SECOND design for the inside
            face. Defaults to none, which prints the chosen artwork on both faces exactly as
            every other product does. The note is load-bearing, not decoration -- no Printful
            mockup style photographs this face, so nothing above will ever show this choice and
            the customer needs to know that BEFORE buying, not after. */}
        {secondaryDesignConfig && (
          <div>
            <h2 className="font-quicksand text-sm font-bold uppercase tracking-wide text-text-secondary">
              {secondaryDesignConfig.label} artwork
            </h2>
            <p className="mt-1 text-xs text-text-muted">
              It&rsquo;s reversible — print a different design on the {secondaryDesignConfig.label.toLowerCase()}, or
              leave this and both faces use the same artwork.
            </p>
            <div className="mt-3 flex flex-wrap items-start gap-3">
              {secondaryChoice ? (
                <div className="flex w-24 flex-col gap-1.5">
                  <div className="relative h-24 w-24 overflow-hidden rounded-xl border-2 border-accent bg-ink-900">
                    <FadeImage
                      src={getThumbnailUrl(secondaryChoice.user_id, secondaryChoice.id)}
                      alt={secondaryChoice.title || 'Untitled'}
                      className="h-full w-full object-cover"
                    />
                    <span className="pointer-events-none absolute left-1.5 top-1.5 rounded-full bg-black/50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white backdrop-blur-sm">
                      {secondaryDesignConfig.label}
                    </span>
                  </div>
                  <p className="line-clamp-2 min-h-[2.5em] text-center text-[11px] font-bold leading-tight text-text">
                    {secondaryChoice.title || 'Untitled'}
                  </p>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => openPicker('secondary')}
                  className="flex h-24 w-24 shrink-0 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-hairline text-text-secondary transition hover:border-accent hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-interactive"
                >
                  <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M12 5v14M5 12h14" strokeLinecap="round" />
                  </svg>
                  <span className="px-1 text-center text-[11px] font-bold leading-tight">
                    Pick a design
                  </span>
                </button>
              )}
              {secondaryChoice && (
                <div className="flex flex-col gap-1.5 pt-1">
                  <button
                    type="button"
                    onClick={() => openPicker('secondary')}
                    className="cursor-pointer text-left text-xs font-bold text-interactive underline-offset-2 hover:underline"
                  >
                    Choose a different one
                  </button>
                  <button
                    type="button"
                    onClick={() => setSecondaryChoice(null)}
                    className="cursor-pointer text-left text-xs font-bold text-text-muted underline-offset-2 hover:text-text hover:underline"
                  >
                    Use the same design on both faces
                  </button>
                </div>
              )}
            </div>
            <p className="mt-3 max-w-prose text-xs text-text-muted">{secondaryDesignConfig.note}</p>
          </div>
        )}

        {/* Step: which panels show the geometry layer -- a per-order choice (not saved to the
            design), so the same artwork can be printed differently on different orders. Only
            shown when the product actually has more than one selectable panel (see
            getGeometryPlacementOptions) -- a single-panel product like mesh shorts has nothing
            meaningful to toggle. Changing a checkbox invalidates the current mockup (see the
            sync effect's geometryPlacementsSignature dependency) since it changes what would
            actually render. */}
        {geometryOptions.length > 1 && (
          <div>
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
                        ? 'border-accent bg-accent text-ink-950'
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
        {/* Step: artwork scale -- only on products whose printfile is cut into panels that are
            never seen at once (PRODUCT_MOCKUP_CONFIG's legPanel). The copy names the MECHANISM
            rather than calling the options "bold"/"fine", following the same lesson the Back
            panel wording below records: the shorts leg is wide and the joggers leg is tall, so
            the two products get different amounts of change out of the same choice, and any
            label promising a fixed visual outcome would be false on one of them. Changing it
            invalidates the current mockup -- it genuinely changes the composition, so it is in
            useMockup's cacheKey. */}
        {legPanel && (
          <div>
            <h2 className="font-quicksand text-sm font-bold uppercase tracking-wide text-text-secondary">
              Artwork scale
            </h2>
            <p className="mt-1 text-xs text-text-muted">
              This product prints as one sheet that's cut into two legs, so you never see the
              whole sheet at once — choose what the artwork is sized to fit.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {[
                { key: 'sheet', label: 'Full sheet', hint: 'Bigger, bolder shapes' },
                { key: 'panel', label: 'One leg', hint: 'Smaller, more detail' }
              ].map(({ key, label, hint }) => {
                const checked = artworkScale === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setArtworkScale(key)}
                    aria-pressed={checked}
                    className={
                      'flex flex-col items-start gap-0.5 cursor-pointer rounded-lg border px-3 py-2 text-left font-quicksand transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-interactive ' +
                      (checked
                        ? 'border-accent bg-accent text-ink-950'
                        : 'border-hairline text-text-secondary hover:border-text')
                    }
                  >
                    <span className="text-sm font-bold">{label}</span>
                    <span className={'text-xs ' + (checked ? 'text-ink-950/75' : 'text-text-muted')}>{hint}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Step: leg symmetry. Deliberately its own row rather than folded into Artwork scale
            (Aaron, 2026-07-29) so the two compose: someone can have the finer per-leg scale
            without committing to the symmetric look, or either one alone. The option labels
            avoid a bare "Mirrored" because Geometry layout below already uses that word for
            something narrower (the shape only), and two rows saying "mirrored" would be
            genuinely ambiguous. */}
        {showsTwoLegLayout && (
          <div>
            <h2 className="font-quicksand text-sm font-bold uppercase tracking-wide text-text-secondary">
              Leg symmetry
            </h2>
            <p className="mt-1 text-xs text-text-muted">
              This product prints as one sheet cut into two legs — choose whether they match.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {[
                { on: false, label: 'Each leg its own', hint: 'A different part of the pattern on each leg' },
                { on: true, label: 'Mirrored legs', hint: 'The pattern meets itself at the front seam' }
              ].map(({ on, label, hint }) => {
                const checked = legSymmetry === on;
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => setLegSymmetry(on)}
                    aria-pressed={checked}
                    className={
                      'flex flex-col items-start gap-0.5 cursor-pointer rounded-lg border px-3 py-2 text-left font-quicksand transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-interactive ' +
                      (checked
                        ? 'border-accent bg-accent text-ink-950'
                        : 'border-hairline text-text-secondary hover:border-text')
                    }
                  >
                    <span className="text-sm font-bold">{label}</span>
                    <span className={'text-xs ' + (checked ? 'text-ink-950/75' : 'text-text-muted')}>{hint}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Hidden while Leg symmetry is on, because symmetry FORCES 'single' (see
            effectiveGeometryLayout). Note this is not the "it's a no-op" reasoning that was
            tried and disproved earlier -- the two settings do render differently under
            symmetry. The problem is that neither still means its label: the sheet mirror
            copies the left half to the right, so 'Single leg / Confined to one panel' can
            never be true, and 'Mirrored' stacks a second mirror inside the first and doubles
            the geometry. Differing is not the same as meaningful. */}
        {showsTwoLegLayout && !legSymmetry && (
          <div>
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
                        ? 'border-accent bg-accent text-ink-950'
                        : 'border-hairline text-text-secondary hover:border-text')
                    }
                  >
                    <span className="text-sm font-bold">{label}</span>
                    <span className={'text-xs ' + (checked ? 'text-ink-950/75' : 'text-text-muted')}>{hint}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Step: seam continuity -- shown on every product with a distinct back panel (see
            PRODUCT_MOCKUP_CONFIG's mirrorPlacements for which, and which three are excluded).
            Same two-button shape as the geometry layout toggle above, and like it, changing
            this invalidates the current mockup: unlike the inside-face design choice, this one
            genuinely changes the returned photo, so it IS part of useMockup's cacheKey.
            The copy names the MECHANISM (the back is flipped, or it isn't) rather than the
            effect, because the effect alone was misleading: an earlier "Independent / each
            half its own composition" implied the off state renders the back separately, when
            in fact front and back share one render on every product here (same printfile
            dimensions -> byte-identical output), so the only thing this changes is the flip.
            The hint lines carry the reason anyone would want it. */}
        {productMirrorPlacements && (
          <div>
            <h2 className="font-quicksand text-sm font-bold uppercase tracking-wide text-text-secondary">
              Back panel
            </h2>
            <p className="mt-1 text-xs text-text-muted">
              The back prints the same artwork as the front. Flipping it lines the pattern up
              where the two meet at the side seams.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {[
                { on: true, label: 'Flipped', hint: 'Pattern continues around the sides' },
                { on: false, label: 'Same as front', hint: 'Pattern restarts at each seam' }
              ].map(({ on, label, hint }) => {
                const checked = mirrorSeams === on;
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => setMirrorSeams(on)}
                    aria-pressed={checked}
                    className={
                      'flex flex-col items-start gap-0.5 cursor-pointer rounded-lg border px-3 py-2 text-left font-quicksand transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-interactive ' +
                      (checked
                        ? 'border-accent bg-accent text-ink-950'
                        : 'border-hairline text-text-secondary hover:border-text')
                    }
                  >
                    <span className="text-sm font-bold">{label}</span>
                    <span className={'text-xs ' + (checked ? 'text-ink-950/75' : 'text-text-muted')}>{hint}</span>
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
          <div>
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
                        ? 'border-accent bg-accent text-ink-950'
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
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[3fr_2fr]">
        {/* Gallery: one large hero image that upgrades in place from blank stock photo to
            the real mockup, instead of a small mockup grid competing with a separate
            "useless" blank photo elsewhere on the page. */}
        <div>
          <div className="relative aspect-square overflow-hidden rounded-xl border border-hairline bg-ink-900">
            {/* BASE LAYER -- the product's stock photo, the scrim and the button. Static: its
                src never changes and it never animates. It is simply covered by the mockup
                layer below when there is one. */}
            <FadeImage src={product?.image} alt={product.title} className="h-full w-full object-cover" />
            {(
              <div
                aria-hidden={showMockup}
                // It stays mounted while invisible and contains a real button, so without
                // this it would still be tab-reachable -- keyboard focus landing on an
                // invisible "Generate mockup". `inert` (React 19 supports the boolean prop
                // directly) removes it from the tab order and the a11y tree together;
                // pointer-events-none alone only handles the mouse.
                inert={showMockup}
                className="absolute inset-0 flex items-center justify-center bg-black/50 p-6"
              >
                <div
                  inert={showMockup}
                  className={
                    'flex items-center justify-center transition-opacity duration-300 ' +
                    (showMockup ? 'opacity-0' : 'opacity-100')
                  }
                >
                {displayedScrimMode === 'signin' ? (
                  <p className="max-w-xs text-center text-sm text-text">
                    <Link to="/account" className="text-accent underline">Sign in</Link> to generate a mockup of your design.
                  </p>
                ) : displayedScrimMode === 'busy' ? (
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
                  </div>
                ) : displayedScrimMode === 'failed' ? (
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
              </div>
            )}

            {/* MOCKUP LAYER -- the ONLY thing in this slot that animates. It sits on top of the
                blank/button layer, fades in when ready, and quick-fades out when it goes away,
                revealing a base that never moved and never needed to. The base is only
                disabled (inert) while covered, never transitioned.
                Rendered from readyHeroUrl, set once the image has decoded, so it is fully
                drawn before it fades and a camera-angle switch swaps src underneath an
                already-visible layer with nothing in between. */}
            {readyHeroUrl && (
              <img
                src={readyHeroUrl}
                alt={product.title}
                className={
                  'pointer-events-none absolute inset-0 h-full w-full object-cover transition-opacity ' +
                  (showMockup && mockupFadedIn ? 'opacity-100 duration-500' : 'opacity-0 duration-200')
                }
              />
            )}

          </div>

          {showMockup && images.length > 1 && thumbsPreloaded && (
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
              2. Size{showColorWithSize ? ` & ${colorLabel.toLowerCase()}` : ''}
            </h2>
            <span className="font-quicksand text-sm font-bold text-text">${variant.price}</span>
          </div>
          {/* Sits with the size picker rather than in Print options: this answers "which
              size am I", which is a required decision, not a refinement. Its data is fetched
              only when opened (see getSizeGuide) so the link costs nothing until used. */}
          <button
            type="button"
            onClick={() => setSizeGuideOpen(true)}
            className="mt-1 cursor-pointer font-quicksand text-xs font-bold text-interactive underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-interactive"
          >
            Size guide
          </button>
          {showColorWithSize && colorPicker}
          {showColorWithSize && (
            <p className="mt-4 font-quicksand text-xs font-bold uppercase tracking-wide text-text-muted">
              Size
            </p>
          )}
          <div className={(showColorWithSize ? 'mt-2' : 'mt-3') + ' flex flex-wrap gap-2'}>
            {sizeVariants.map(v => {
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
                      ? 'border-accent bg-accent text-ink-950'
                      : 'border-hairline text-text-secondary hover:border-text')
                  }
                >
                  {v.size}
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
                disabled={!storeEnabled || checkoutBusy}
                aria-busy={checkoutBusy}
                onClick={onBuyNowButtonClick}
              >
                Buy now
              </Button>
            )}
            <div className="mt-4 space-y-1.5">
              {user && !storeEnabled && (
                <p className="text-xs leading-tight text-accent">
                  Store purchasing is temporarily offline. Please check back soon.
                </p>
              )}
              <p className="text-xs leading-tight text-text-muted">
                Printed on demand and shipped by Printful. No returns on custom prints.
              </p>
            </div>
          </div>
        </div>
      </div>

      <SizeGuideModal
        open={sizeGuideOpen}
        productId={product.id}
        productTitle={product.title}
        onClose={() => setSizeGuideOpen(false)}
      />

      <ArtworkPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={onPickDesign}
      />

      <BuyNowModal
        stage={buyModalStage}
        onContinue={onBuyNowClick}
        onCancel={() => {
          setBuyModalStage(null);
          setCheckoutNotice(null);
        }}
        errorMessage={checkoutNotice}
        narration={
          <ScrambleText
            text={statusNarration(checkoutElapsed, checkoutNarrationPicksRef.current, CHECKOUT_TIMELINE)}
            className="text-xs text-text-secondary"
          />
        }
        progress={checkoutProgress}
        elapsedSeconds={checkoutElapsed}
      />
    </PageContainer>
  );
}
