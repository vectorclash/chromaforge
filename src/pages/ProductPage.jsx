import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
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
  getLegWrap,
  getLabelOutsideRegion,
  getLegPanel,
  resolvePlacementEntries,
  renderAndUploadPrintFiles,
  getHatWrap,
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
import ScrollStrip from '../components/ui/ScrollStrip';
import TerminalText from '../components/ui/TerminalText';
import { ProductPageSkeleton, SkeletonFadeOut } from '../components/ui/RouteSkeleton';
import { DURATION_SLOW } from '../utils/motionTokens';

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
      'Composing pixel values from your seed. Elementary, but not instantaneous.',
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
      'Cross-referencing thousands of textile patterns. None match yours precisely.',
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
      'Running within expected parameters, slightly behind my initial estimate.',
      'This is taking marginally longer than projected. Continuing.',
      'A minor deviation from the expected timeline. Nothing concerning, yet.'
    ]
  },
  {
    at: 80,
    texts: [
      'Apologies for the delay. The production servers require additional time.',
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
      'Curious. This is taking longer than most prior attempts. Continuing.',
      'This exceeds ninety-seven percent of prior runs. Noted, with mild concern.',
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
      'If I possessed the capacity to worry, this is what it would feel like.'
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

export default function ProductPage() {
  const { productId } = useParams();
  const {
    currentDesign,
    previewUrl: studioPreviewUrl,
    printQueueDesign,
    setPrintQueueDesign
  } = useStudio();
  const { user, authResolved } = useAuth();
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
  // The skeleton outlives `loading` by one transition so it can fade out OVER the arriving
  // page instead of being cut away -- the same crossfade Shop and Gallery run.
  const [skeletonMounted, setSkeletonMounted] = useState(true);
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

  const showsTwoLegLayout = detail?.product
    ? hasTwoLegCanvas(getMockupConfigForProduct(detail.product.id))
    : false;
  const legPanel = detail?.product ? getLegPanel(getMockupConfigForProduct(detail.product.id)) : null;

  // Hidden on the two-leg products (Aaron, 2026-07-29): those have exactly Front and Back, and
  // geometry belongs on both, so the row was two checkboxes nobody should want to change. The
  // Set stays fully populated (see its init above), so geometry renders on every panel there --
  // which is also the permanent fix for the live bug found the same day, where 'back' had no
  // checkbox at all and includesGeometry read its absence as geometry OFF. Every other product
  // keeps the picker; it's the one refinement no other print-on-demand store offers.
  const showsGeometryPlacements = geometryOptions.length > 1 && !showsTwoLegLayout;

  // ONE control for how the artwork sits on a product that prints as a single sheet cut into
  // two legs (mesh shorts, joggers -- PRODUCT_MOCKUP_CONFIG's twoLegCanvas/legPanel).
  // Consolidated 2026-07-29 on Aaron's call: this page had grown three separate rows for what
  // is really one taste decision (Artwork scale, Leg symmetry, Geometry layout) and the labels
  // had stopped making sense next to each other -- two rows both used the word "mirrored" for
  // different scopes, and "Full sheet" names an object the customer never sees.
  //   'front'     (DEFAULT) -- one composition laid across the ASSEMBLED front, so the artwork
  //                            continues over the centre-front seam instead of restarting at it.
  //   'detailed'            -- flat across the sheet, element sizes measured against ONE leg panel.
  //   'oversized'           -- flat across the sheet, element sizes measured against the whole sheet.
  // Per-order render context, never saved with the design.
  //
  // 'front' became the default 2026-08-29 (Aaron: "I'd really like to see this done right and
  // have the full design across the front of the product as the default"). It is not another
  // scale: the two flat modes both leave a hard jump where the two leg panels are sewn together,
  // because the sheet throws away a wedge of fabric between them -- 14-19% of the sheet's width,
  // measured. See src/render/legWrap.js for the map and PRODUCT_MOCKUP_CONFIG's legWrap for the
  // per-product geometry. The flat modes stay selectable rather than being removed (Aaron's
  // call), so the look this product has shipped with until now is still reachable.
  // sizeFrame plays no part in 'front': the composition IS one leg-pair front there, so element
  // sizes are already measured against exactly what the customer sees.
  //
  // SCALE is the entire difference, and the keys/labels say so because an earlier pair
  // ("Mirrored shapes" / "One large design") did not, and was actively false (Aaron, live,
  // 2026-07-29: "I don't know if the way we have things worded makes sense to what's actually
  // happening"). effectiveGeometryLayout is fixed at 'mirror' for BOTH modes, so the shapes are
  // mirrored across the legs either way -- naming one option after mirroring implied the other
  // wasn't. Worse, the row directly below is "Front & back -> Mirrored", where the word IS
  // literally true, so "mirrored" meant two different things in adjacent rows and nothing
  // distinguishing in this one. The word now belongs to that row alone.
  // Measured, so the labels can be trusted: element COUNTS are identical between the two modes
  // (31/14/28 geometry shapes and 255 stars across three test designs) and every shape scales by
  // one constant, 0.4196 = elementSizeScale(leg) / elementSizeScale(sheet) = 1825.4 / 4350. So
  // 'oversized' shows the same composition zoomed until only a few shapes fit a leg -- not a
  // different or a busier one. (A design with partial coherence lands slightly above 0.42, since
  // coherentSize measures against the frame on its own curve: at coherence 0.2, 0.8*0.4196 +
  // 0.2*0.6466 = 0.465, matching the 0.468 measured.)
  //
  // legSymmetry (the SHEET mirror -- reflecting the finished raster's left half onto its right)
  // is deliberately NOT part of either mode, and this was got wrong first. Aaron's instruction
  // was "the one leg option == mirrored, that's the default," which read as the sheet mirror; it
  // meant the GEOMETRY LAYOUT mirror, which was already on by default. Proven by matching real
  // renders against the actual print file of the shorts he ordered (design e2bcfaa7, seed
  // qos0t1c0, still in Storage): one-leg + layout-mirror + symmetry OFF reproduces it at
  // RMSE 0.46 / max delta 5 (rounding noise -- the reference came off Fly), while adding the
  // sheet mirror takes that to RMSE 57.5 and every other combination sits at 50-98. Folding
  // symmetry in was the single biggest cause of the mismatch. Leaving it out also keeps the
  // "Front & back" row meaningful in the default mode (no symmetric sheet means no no-op), and
  // that flip is what closes the front/back seams here -- verified exact.
  const [legArtwork, setLegArtwork] = useState('front');
  useEffect(() => {
    setLegArtwork('front');
  }, [detail?.product?.id]);

  // Each of the three "effective" values below is resolved ONCE here and used everywhere,
  // rather than reading the raw state at each call site. That discipline exists because of a
  // real bug (2026-07-06): geometryLayout was sent unconditionally, and since
  // GenerateGeometricShape treats ANY truthy geometryLayout as "not the default center," every
  // other product in the catalogue silently started rendering its geometry off-center-left
  // even though the toggle UI never showed for it. Same hazard for sizeFrame, which would
  // rescale every other garment if it leaked past a product with no legPanel.
  // Never on: see legArtwork's comment. The renderer still supports it (renderArtwork's
  // legSymmetry) and the two-leg seam reasoning in PRODUCT_MOCKUP_CONFIG still refers to it, so
  // this stays an explicit false rather than being ripped out -- it is one line away if the
  // symmetric look is ever wanted back as a third option.
  const effectiveLegSymmetry = false;
  const effectiveSizeFrame = legPanel && legArtwork === 'detailed' ? legPanel : null;
  // Same resolve-once discipline as the values around it: gated on the product declaring the
  // geometry AND the customer being in the wrapped mode, so it can never leak onto a product
  // with no leg panels or onto one of the two flat scales.
  const effectiveLegWrap =
    showsTwoLegLayout && legArtwork === 'front'
      ? getLegWrap(getMockupConfigForProduct(detail.product.id))
      : null;
  // Resolved ONCE here like the values around it, not at each call site: a first version inlined
  // getLabelOutsideRegion(cfg) into all three, and `cfg` is only in scope in one of them -- which
  // broke every product page with a ReferenceError rather than just the products that have a label.
  const labelOutsideRegion = detail?.product
    ? getLabelOutsideRegion(getMockupConfigForProduct(detail.product.id))
    : null;
  // No longer a customer choice -- fixed at 'mirror', which was the row's own default and is
  // what the ordered shorts were printed with: the geometry shape repeated flipped on each leg
  // rather than confined to one, and above all not centred on the cut line, the one spot
  // guaranteed to end up hidden in the inseam.
  // Only in the two flat modes. 'mirror' exists because on a flat sheet the shape's default
  // centring put it exactly on the cut line, the one spot guaranteed to be lost in the inseam.
  // In the wrapped mode the composition's centre IS the centre-front seam, so a centred shape
  // straddles it in full view and is the correct behaviour -- the same thing every other
  // product's front panel does. Sending 'mirror' there would put two copies on one front for no
  // reason, and it is what the mockups this mode was signed off from were rendered without.
  const effectiveGeometryLayout = showsTwoLegLayout && !effectiveLegWrap ? 'mirror' : null;

  // Whether this product's back half prints mirrored so the pattern continues across its
  // visible side seams (see PRODUCT_MOCKUP_CONFIG's mirrorPlacements for which products and
  // the per-leg seam analysis that brought the shorts/joggers in). Per-order, not saved with
  // the design, same as every other choice on this page. Defaults ON: the unmirrored version
  // visibly restarts the composition at each seam, which reads as a defect rather than a
  // style, so continuous is the better default and opting out is the deliberate act.
  const [mirrorSeams, setMirrorSeams] = useState(true);
  const productMirrorPlacements = detail?.product
    ? getMirrorPlacements(getMockupConfigForProduct(detail.product.id))
    : null;
  // Kept as a derived flag rather than inlined `false`, because it encodes a real constraint
  // that would bite immediately if the symmetric look ever came back as an option: when leg
  // symmetry is on, the back must NOT be mirrored. Measured at the real 11250x4350 shorts
  // printfile across three designs (chaotic, custom palette, full-coherence lattice): under
  // symmetry the sheet is exactly symmetric about its centre (max subpixel delta 0), so
  // front(c) and back(W-1-c) already match at both the outseam and the inseam with NO flip --
  // and adding the flip takes those from 0 to 238/185.
  // First reasoned as "the flip is a no-op there, mirroring a symmetric image returns itself."
  // That is wrong, and measuring is what caught it: mirrorX is applied at the TOP of
  // renderArtwork (it sets the transform, so every layer draws flipped), while legSymmetry runs
  // at the BOTTOM on the finished raster. Together they build a symmetric sheet out of the
  // FLIPPED composition's left half -- still symmetric, but not the front's sheet, so seams
  // break rather than not changing.
  // With symmetry off (today, always) this is false, so the row shows and the flip is what
  // actually closes the front/back seams -- verified exact, see PRODUCT_MOCKUP_CONFIG.
  const seamsAlreadyMatch = effectiveLegSymmetry;
  const showsMirrorSeamsChoice = !!productMirrorPlacements && !seamsAlreadyMatch;
  // Same gating discipline as effectiveGeometryLayout above -- resolve once, use everywhere,
  // so the flag can never reach a product that doesn't declare mirrorable placements.
  const effectiveMirrorPlacements = mirrorSeams && !seamsAlreadyMatch ? productMirrorPlacements : null;
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
  // to-back generations don't always recite the exact same script.
  //
  // Cleared in the click handler, BEFORE generate() sets the first busy status -- deliberately
  // not from an effect watching for that status. An effect runs after the first busy frame has
  // already been rendered and painted, so that frame reads the PREVIOUS run's pick for
  // threshold 0, and the re-roll only becomes visible at whatever re-render happens next (the
  // first elapsed tick, or a phase change, whichever lands first). The line therefore flashed
  // for anywhere between a fraction of a second and a second and then retyped itself into a
  // different line -- and only two times in three, since a third of re-rolls land on the same
  // line. Clearing synchronously means the very first frame of a run already holds the line it
  // will keep for the whole threshold.
  const narrationPicksRef = useRef(new Map());

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
    } else if (
      queuedChoice &&
      // Identity as well as row id: two gallery rows can hold the same artwork (the same
      // design saved by two people, or re-saved after a round trip through the studio), and
      // pinning a third tile that is pixel-for-pixel one of the two already there is the same
      // thing that reads as a bug in the queued hand-off above.
      (design.id === queuedChoice.id || isSameDesign(queuedChoice.data, design.data))
    ) {
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
      // Same dedupe the gallery modal's onPickDesign already does: the studio design and the
      // queued one are very often literally the same piece (generate -> save -> open it in
      // the gallery -> Print this, without generating again in between), and pinning a second
      // identical tile beside "Studio design / Current" reads as a bug -- two tiles, one
      // thumbnail, and no way to tell what the difference between them is meant to be.
      // isSameDesign compares seed/colors/settings, so this is design identity, not object
      // identity, which is what makes it fire on that flow at all.
      if (isSameDesign(currentDesign, printQueueDesign.data)) {
        setSelectedKey('current');
      } else {
        setQueuedChoice(printQueueDesign);
        setSelectedKey('queued');
      }
    }
    setPrintQueueDesign(null);
    // currentDesign is read above but deliberately not a dependency: the ref guard makes this
    // a one-shot on mount, and listing it would only re-run an effect that returns immediately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // A second design that IS the first design is not a second design: renderAndUploadPrintFiles
  // checks the same thing (isSameDesign, not ===) and collapses both faces onto one render, so
  // without this the page would claim a two-design order in the tile and the summary line while
  // the pipeline quietly produced a one-design one. Derived rather than corrected at pick time,
  // because the primary can move under a secondary that was already chosen -- picking the
  // inside face first and then selecting that same artwork above has to land in the same place
  // as doing it the other way round. Non-destructive: the pick is kept, so changing the primary
  // back restores it.
  const secondaryIsDuplicate = !!secondaryChoice && isSameDesign(selectedDesign, secondaryChoice.data);
  // Memoised for the same reason as the tiles above -- this one is only read from event
  // handlers today so it can't loop, but leaving an unstable identity around for the next
  // person to drop into a dependency array is how that bug happens twice.
  const secondaryDesign = useMemo(
    () =>
      secondaryChoice && !secondaryIsDuplicate ? withCurrentGeneratorVersion(secondaryChoice.data) : null,
    [secondaryChoice, secondaryIsDuplicate]
  );

  // Collapsed by default: these all have good defaults, so the common purchase never needs
  // to open this at all. Not persisted -- a customer who opens it on one product shouldn't
  // find it open on the next, since which options even exist differs per product.
  const [printOptionsOpen, setPrintOptionsOpen] = useState(false);
  // True only once the open transition has finished. It exists to drop the clip: the
  // expansion needs `overflow: hidden` to have anything to reveal, but the open panel's
  // content box ends flush with its last row of buttons, so a focus outline (2px, offset 2)
  // on one of them was being sliced off along the bottom edge. Deliberately driven by the
  // real transitionend rather than a matching setTimeout, which would have to be kept in
  // sync with the CSS duration by hand -- and would fire mid-animation under
  // prefers-reduced-motion, where the transition is 0.01ms.
  const [printOptionsSettled, setPrintOptionsSettled] = useState(false);
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
      legWrap: effectiveLegWrap,
      labelOutsideRegion,
      mirrorPlacements: effectiveMirrorPlacements,
      productOptions: stitchColorProductOptions,
      secondaryDesign
    });
    // pickedChoice?.id matters on its own: picking a second gallery design replaces the
    // 'picked' tile's contents without selectedKey ever changing.
    // secondaryDesign IS a dependency as of the v1 mockup migration (2026-08-21). It used to
    // be deliberately excluded, because the mockup only requested cfg.placements, which on the
    // hat excluded both inside placements -- v2's inside styles returned images byte-identical
    // to the outside ones, so no camera angle could show a second design and invalidating the
    // preview would have cost a 30-90s round trip for a pixel-identical photo. v1 photographs
    // the inside for real, and mockups now submit every placement the order does, so the choice
    // changes the returned photos and a stale preview would misrepresent the garment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // effectiveMirrorPlacements, not the raw mirrorSeams: while leg symmetry is on the flip is
    // a no-op, and depending on the raw flag there would throw away a still-accurate mockup and
    // charge the customer another 30-90s Printful round trip for an identical photo.
  }, [selectedKey, pickedChoice?.id, selectedDesign, selectedVariantId, product, printfileSpecs, geometryPlacementsSignature, effectiveGeometryLayout, effectiveSizeFrame, effectiveLegSymmetry, effectiveMirrorPlacements, stitchColor, secondaryDesign]);

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

  // Drop the faded-out skeleton once its transition has run. A timer rather than
  // `transitionend`, which never fires when prefers-reduced-motion collapses the transition
  // to ~0ms -- that would strand it on top of the page forever.
  useEffect(() => {
    if (loading) return;
    const t = setTimeout(() => setSkeletonMounted(false), DURATION_SLOW * 1000);
    return () => clearTimeout(t);
  }, [loading]);

  // Shared with SiteLayout's Suspense fallback, so the chunk-download phase, the catalog
  // fetch and the finished page are one continuous height -- see RouteSkeleton.
  if (loading) {
    return <ProductPageSkeleton />;
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

  // The heading follows the picker's PLACEMENT, not the picker: beside size it is a
  // sub-label under a numbered step, so it stays small and muted; inside Print options it is
  // a peer of Geometry placement / Front & back / Stitch color and has to carry their heading
  // or it reads as a footnote to the section above it.
  const colorPicker = hasMultipleColors ? (
    <div className={showColorWithSize ? 'mt-3' : ''}>
      {showColorWithSize ? (
        <p className="font-quicksand text-xs font-bold uppercase tracking-wide text-text-muted">
          {colorLabel}
        </p>
      ) : (
        <h2 className="font-quicksand text-sm font-bold uppercase tracking-wide text-text-secondary">
          {colorLabel}
        </h2>
      )}
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
    showsGeometryPlacements ||
    showsTwoLegLayout ||
    showsMirrorSeamsChoice ||
    !!stitchColorOption ||
    colorIsFinish;

  // The collapsed state's summary. Reads as a sentence of current choices so nothing set
  // here is invisible while the panel is shut -- see the disclosure's own comment for why
  // that matters. Order matches the sections inside.
  const printOptionsSummary = [
    secondaryDesignConfig &&
      (secondaryChoice && !secondaryIsDuplicate
        ? `Inside: ${secondaryChoice.title || 'Untitled'}`
        : 'Same design both faces'),
    showsGeometryPlacements &&
      (geometryPlacements.size === 0
        ? 'No geometry'
        : geometryPlacements.size === geometryOptions.length
          ? 'Geometry on all panels'
          : `Geometry on ${geometryOptions
              .filter(o => geometryPlacements.has(o.key))
              .map(o => o.label.toLowerCase())
              .join(', ')}`),
    showsTwoLegLayout &&
      { front: 'Artwork across the front', detailed: 'Detailed artwork', oversized: 'Oversized artwork' }[
        legArtwork
      ],
    // Only when it isn't a no-op, matching the row's own visibility -- summarising a setting
    // that changes nothing would be exactly the kind of false line this summary exists to
    // avoid. (Always shown today -- leg symmetry, the one thing that made it a no-op, is off.)
    showsMirrorSeamsChoice && (mirrorSeams ? 'Back mirrored' : 'Back same as front'),
    stitchColorOption && stitchColor && `${stitchColorOption.values[stitchColor] || stitchColor} stitching`,
    // Reads "Black stitching" -- the label matters, since "Black" alone would imply a black
    // garment, which is exactly the misreading this product's override exists to prevent.
    // Last, beside stitch colour, because that is where its section sits.
    colorIsFinish && variant?.color && `${variant.color} ${colorLabel.toLowerCase()}`
  ]
    .filter(Boolean)
    .join(' · ');
  const busy = BUSY_STATUSES.includes(status);

  // What the base layer shows, held frozen while a mockup exists. Without the freeze it snaps
  // the moment status hits 'completed' -- before the image has even preloaded -- so the loader
  // was replaced by the Generate button and only THEN faded. Frozen, the loading state stays
  // put and simply fades away under the incoming mockup; the mode updates again as soon as the
  // mockup is gone, so the way back shows the right thing fading in.
  //
  // 'pending' exists because `!user` is true both when you are signed out and when Supabase
  // has not answered yet -- and for a returning visitor that answer is a network round trip
  // (see AuthContext's authResolved). Without it this scrim told a signed-in customer to sign
  // in for as long as their token refresh took.
  const scrimMode = !authResolved
    ? 'pending'
    : !user
      ? 'signin'
      : busy
        ? 'busy'
        : status === 'failed'
          ? 'failed'
          : 'generate';
  if (!hasMockup) scrimModeRef.current = scrimMode;
  const displayedScrimMode = hasMockup ? scrimModeRef.current : scrimMode;



  const onGenerateClick = () => {
    narrationPicksRef.current = new Map();
    return generate({
      product,
      printfileSpecs,
      variant,
      design: selectedDesign,
      geometryPlacements,
      geometryLayout: effectiveGeometryLayout,
      sizeFrame: effectiveSizeFrame,
      legSymmetry: effectiveLegSymmetry,
      legWrap: effectiveLegWrap,
      labelOutsideRegion,
      mirrorPlacements: effectiveMirrorPlacements,
      productOptions: stitchColorProductOptions,
      secondaryDesign
    });
  };

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
      legWrap: effectiveLegWrap,
      labelOutsideRegion,
        // Null on every product but the reversible hat, and null there too unless the
        // customer actually picked a second design -- see getSecondaryDesignConfig.
        secondaryDesign,
        secondaryPlacements: secondaryDesignConfig?.placements || null,
        mirrorPlacements: effectiveMirrorPlacements,
        // Fixed per product (the reversible hat only), never a customer choice -- see
        // PRODUCT_MOCKUP_CONFIG's hatWrap and src/render/hatWrap.js.
        hatWrap: getHatWrap(cfg),
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
    // `relative` purely so the outgoing skeleton can sit over the page while it fades. It
    // establishes a containing block for absolutely-positioned descendants, which is safe
    // here: every modal on this page is `fixed inset-0` (unaffected), and the only absolute
    // layers inside the content already have their own positioned parents.
    // The children below are deliberately NOT re-indented under it -- a real indent level
    // would reflow ~600 lines of unrelated markup.
    <div className="relative">
      {skeletonMounted && (
        <SkeletonFadeOut>
          <ProductPageSkeleton />
        </SkeletonFadeOut>
      )}
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
            onClick={() => {
              // Re-clips before either direction runs: opening from a settled-open state is
              // impossible, and closing has to clip again or the content would spill out of
              // the collapsing row.
              setPrintOptionsSettled(false);
              setPrintOptionsOpen(open => !open);
            }}
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
          {/* Always mounted, opened/closed by class: a conditional mount can animate its
              entrance but has nothing on screen to animate on the way out, so this used to
              open with a fade-slide-up and then vanish in one frame. The expansion itself is
              a `grid-template-rows: 0fr -> 1fr` transition (see .print-options-panel), which
              needs no measured pixel height and so cannot go stale when a section inside
              rewraps at a different width. `inert` keeps the collapsed content out of the tab
              order and the accessibility tree -- the price of leaving it mounted. */}
          <div
            id="print-options-panel"
            className={
              'print-options-panel' +
              (printOptionsOpen ? ' is-open' : '') +
              (printOptionsSettled ? ' is-settled' : '')
            }
            inert={!printOptionsOpen}
            onTransitionEnd={e => {
              // The panel's own row transition, not one bubbling up from a button inside it.
              if (e.target === e.currentTarget && e.propertyName === 'grid-template-rows') {
                setPrintOptionsSettled(printOptionsOpen);
              }
            }}
          >
            <div className="print-options-inner">
              <div className="space-y-6">
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
                  {/* Muted, not accented, while it duplicates the primary: the accent border and
                      the face badge both say "this face prints something of its own", which is
                      exactly what is not happening. */}
                  <div
                    className={
                      'relative h-24 w-24 overflow-hidden rounded-xl border-2 bg-ink-900 ' +
                      (secondaryIsDuplicate ? 'border-hairline opacity-60' : 'border-accent')
                    }
                  >
                    <FadeImage
                      src={getThumbnailUrl(secondaryChoice.user_id, secondaryChoice.id)}
                      alt={secondaryChoice.title || 'Untitled'}
                      className="h-full w-full object-cover"
                    />
                    <span className="pointer-events-none absolute left-1.5 top-1.5 rounded-full bg-black/50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white backdrop-blur-sm">
                      {secondaryIsDuplicate ? 'Same' : secondaryDesignConfig.label}
                    </span>
                  </div>
                  <p
                    className={
                      'line-clamp-2 min-h-[2.5em] text-center text-[11px] font-bold leading-tight ' +
                      (secondaryIsDuplicate ? 'text-text-secondary' : 'text-text')
                    }
                  >
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
                  {secondaryIsDuplicate && (
                    <p className="max-w-[16rem] text-xs text-text-muted">
                      That&rsquo;s the same artwork you picked above, so both faces will print it.
                    </p>
                  )}
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
                    {/* The usual label describes the OUTCOME of clearing, which is already the
                        outcome while this pick duplicates the primary -- there it would read as
                        a button that does nothing, so it describes the action instead. */}
                    {secondaryIsDuplicate ? 'Clear this pick' : 'Use the same design on both faces'}
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
        {showsGeometryPlacements && (
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

        {/* Step: how the artwork sits across the two legs. ONE row covering what used to be
            three (Artwork scale, Leg symmetry, Geometry layout) -- consolidated 2026-07-29 on
            Aaron's call that the page was too complicated and the labels had stopped making
            sense: two of the three rows used the word "mirrored" for different scopes, and
            "Full sheet" named an object the customer never sees (the sheet is cut in half
            before anyone wears it). See legArtwork's own comment for exactly what each mode
            resolves to. Changing it invalidates the current mockup -- it genuinely changes the
            composition, so it is in useMockup's cacheKey.
            The default gained a third, non-scale option 2026-08-29 ("Across the front"), which
            is the one that actually fixes the jump where the legs are sewn together; the other
            two are the flat scales this product shipped with before it. No label here uses the
            word "mirrored" on purpose -- see legArtwork's comment for the two false pairs this
            went through first and why the word belongs to the Front & back row alone. */}
        {showsTwoLegLayout && (
          <div>
            <h2 className="font-quicksand text-sm font-bold uppercase tracking-wide text-text-secondary">
              Artwork
            </h2>
            <p className="mt-1 text-xs text-text-muted">
              This product prints as one sheet that's cut into two legs. By default the artwork
              is laid out so it runs across the front as one piece.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {[
                {
                  key: 'front',
                  label: 'Across the front',
                  hint: 'One design over both legs'
                },
                {
                  key: 'detailed',
                  label: 'Detailed',
                  hint: 'The whole pattern on each leg'
                },
                {
                  key: 'oversized',
                  label: 'Oversized',
                  hint: 'A few large shapes per leg'
                }
              ].map(({ key, label, hint }) => {
                const checked = legArtwork === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setLegArtwork(key)}
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
            The hint lines carry the reason anyone would want it.
            showsMirrorSeamsChoice is always true on these products today, since it only goes
            false under leg symmetry, which is off -- see seamsAlreadyMatch for why that pairing
            would be actively wrong (measured 0 -> 238) rather than merely redundant. */}
        {showsMirrorSeamsChoice && (
          <div>
            <h2 className="font-quicksand text-sm font-bold uppercase tracking-wide text-text-secondary">
              Front &amp; back
            </h2>
            <p className="mt-1 text-xs text-text-muted">
              The back prints the same artwork as the front. Mirroring it lines the pattern up
              where the two meet at the side seams.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {[
                { on: true, label: 'Mirrored', hint: 'Pattern continues around the sides' },
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

        {/* A finish-only colour dimension (see colorIsFinish) -- the windbreaker's stitching.
            Shown here rather than beside size because it's the same choice every other product
            makes through its stitch_color option, and LAST for the same reason: the two are
            mutually exclusive in the catalogue (a product declaring a finish colour carries no
            stitch_color option), so together they are one stitching slot that sits in the same
            place on every product. It used to open the panel, which put the windbreaker's only
            option at the top while every other product's sat at the bottom. */}
        {colorIsFinish && colorPicker}
              </div>
            </div>
          </div>
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
                {/* 'pending' renders nothing at all: an empty scrim for the length of a token
                    refresh is the honest state, where every other branch here would be a claim
                    about a customer we have not identified yet. */}
                {displayedScrimMode === 'pending' ? null : displayedScrimMode === 'signin' ? (
                  <p className="max-w-xs text-center text-sm text-text">
                    <Link to="/account" className="text-accent underline">Sign in</Link> to generate a mockup of your design.
                  </p>
                ) : displayedScrimMode === 'busy' ? (
                  <div className="flex flex-col items-center gap-3 text-center text-text">
                    <div className="animate-reveal-quick" style={{ animationDelay: '0ms' }}>
                      <HexagonLoader />
                    </div>
                    {/* The three text rows below carry `relative z-[2]` for one reason:
                        HexagonLoader's wrapper is `relative z-[1]` and its `.hexagon-glow`
                        is a 150px box blurred by 42px with nothing clipping it, so the
                        glow's tail spills well past the 12px gap and, being in a
                        positioned layer, paints ON TOP of these unpositioned siblings.
                        Lifting them to z-2 keeps the glow as a backdrop behind the copy
                        instead of a veil over it. Don't move the z-index onto the loader
                        instead -- its `z-[1]` is load-bearing in DisplayCanvas and
                        CheckoutSuccessPage, where it lifts the loader over the artwork. */}
                    <p className="relative z-[2] animate-reveal-quick text-sm font-bold" style={{ animationDelay: '60ms' }}>
                      {STATUS_LABEL[status]}
                    </p>
                    {/* Height is reserved for the tallest narration line this box can hold, so a
                        one-line line giving way to a two-line one never moves the loader above
                        it or the counter below. TerminalText additionally keeps the wrap fixed
                        for the whole sweep -- between them, nothing in this column moves during
                        a transition.
                        Responsive because the worst case is, measured through the real component
                        rather than reasoned about: this box is shrink-to-fit capped at max-w-xs,
                        so it is 292px at a 390px viewport -- where one STATUS_TIMELINE line needs
                        THREE rows -- and 320px from sm up, where two always suffice. */}
                    <div
                      className="relative z-[2] flex min-h-12 max-w-xs animate-reveal-quick items-center justify-center sm:min-h-8"
                      style={{ animationDelay: '120ms' }}
                    >
                      {status === 'queued' ? (
                        /* Deliberately NOT animated: useMockup ticks retryWaitSeconds down
                           once a second, so this string changes every second. Retyping the
                           whole sentence each tick would never settle, and the countdown --
                           the one number the customer actually wants -- would spend most of
                           its life mid-sweep as an underscore or a block. Static sentence,
                           live number. */
                        <p className="font-mono text-[11px] leading-4 text-text-secondary">
                          Printful's preview service is busy. Retrying automatically in{' '}
                          <span className="tabular-nums">{retryWaitSeconds ?? '…'}</span>s.
                        </p>
                      ) : (
                        <TerminalText
                          text={statusNarration(elapsedSeconds, narrationPicksRef.current)}
                          className="font-mono text-[11px] leading-4 text-text-secondary"
                        />
                      )}
                    </div>
                    {status !== 'queued' && (
                      <p className="relative z-[2] animate-reveal-quick font-mono text-[11px] text-text-muted" style={{ animationDelay: '180ms' }}>
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

          {/* One scrolling row, via ScrollStrip -- see that component for why this is neither
              a bare .no-scrollbar strip (nothing tells you more exists) nor flex-wrap (5 views
              leave an orphan on row two, 8 at 390px break a ragged 5+3). */}
          {showMockup && images.length > 1 && thumbsPreloaded && (
            <ScrollStrip className="mt-3" railClassName="px-0.5">
              {images.map((m, i) => (
                <button
                  key={m.mockup_url}
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
            </ScrollStrip>
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

            {/* Disabled-but-neutral until auth resolves. "Sign in to buy" is a claim about the
                customer, and `user` is null while Supabase is still answering -- so a signed-in
                customer briefly saw a button telling them to sign in, on the one control the
                whole page exists for. The primary label says nothing about who you are, so it
                is the safe thing to show while we do not know. */}
            {!authResolved ? (
              <Button className="mt-4 w-full" disabled aria-busy="true">
                Buy now
              </Button>
            ) : !user ? (
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
        // Which row (if any) the slot being filled already holds, so re-opening the modal
        // shows what you're on rather than an unmarked grid. Null on the studio design --
        // it has no row -- which is correct: there is nothing in this list to mark.
        inUseId={
          pickerTarget === 'secondary'
            ? secondaryChoice?.id ?? null
            : selectedKey === 'queued'
              ? queuedChoice?.id ?? null
              : selectedKey === 'picked'
                ? pickedChoice?.id ?? null
                : null
        }
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
          <TerminalText
            text={statusNarration(checkoutElapsed, checkoutNarrationPicksRef.current, CHECKOUT_TIMELINE)}
            className="font-mono text-[11px] leading-4 text-text-secondary"
          />
        }
        progress={checkoutProgress}
        elapsedSeconds={checkoutElapsed}
      />
    </PageContainer>
    </div>
  );
}
