import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createMockupTask,
  getMockupTask,
  getMockupConfigForProduct,
  getSecondaryDesignConfig,
  buildMockupFiles,
  hideUnsubmittedViews,
  resolvePlacementEntries,
  renderAndUploadPrintFiles,
  getHatWrap,
  capRenderStrategy,
  warmRenderService
} from '../lib/printful';
import { isSameDesign } from '../render/designSettings';
import { useStudio } from '../context/StudioContext';

// Drives a Printful v1 mockup-generation task for the current design on a chosen product
// variant. Ported out of DisplayCanvas: render each unique printfile size from the design
// (off-canvas via StudioContext.renderDesignBlob), upload, create the task, poll, dedupe.
// The render+upload step (renderAndUploadPrintFiles) is shared with the real checkout flow
// in lib/checkout.js -- see lib/printful.js for why mockups filter to cfg.placements while
// checkout doesn't.
const POLL_INTERVAL_MS = 4000;
const POLL_MAX_TRIES = 45;

// Exported so callers (ProductPage) share one definition of "actively working" instead of
// re-deriving it from status strings independently.
export const BUSY_STATUSES = ['rendering', 'creating', 'polling', 'queued'];

// Printful's mockup-task creation endpoint has a hard, undocumented, STORE-WIDE cap --
// measured live at 10 create-task calls per 60s, shared across every user of the app -- and
// shared between BOTH API versions, verified 2026-08-21 by alternating v1 and v2 creates
// inside one window and watching a single counter decrement
// (see TODO.md), not per-user -- our own edge function's per-user limiter was never the
// binding constraint. printful-mockup now enforces a matching global gate and reports
// `retryAfterSeconds` on either its own 429 or a real one passed through from Printful
// (see unwrapFunctionsError). Rather than surfacing that as a hard failure the moment two
// people preview in the same minute, wait out the window and retry automatically --
// bounded so a genuinely stuck/down Printful doesn't hang a customer forever.
const MAX_QUEUE_WAIT_MS = 3 * 60 * 1000;

async function createMockupTaskWithBackoff(args, onWait) {
  const deadline = Date.now() + MAX_QUEUE_WAIT_MS;
  for (;;) {
    try {
      return await createMockupTask(args);
    } catch (err) {
      if (err.status !== 429 || Date.now() >= deadline) throw err;
      const waitSeconds = Math.min(Math.max(err.retryAfterSeconds || 20, 5), 60);
      await onWait(waitSeconds);
    }
  }
}

// Caches a completed mockup by (product, exact printfile-id mapping, design content) so
// switching artwork/variant and back doesn't force another 30-90s Printful round trip for
// something already seen. Keying on the printfile-id mapping rather than e.g. variant color
// is deliberate and confirmed live: every size of a given t-shirt/hoodie color resolves to
// the *same* printfile ids (sizing is handled by repositioning on the cut pattern, not a
// different print file), so all of them correctly share one cache entry -- but the pillow's
// sizes resolve to genuinely different printfile ids (18x18 vs 22x22 vs 20x12 are different
// print areas), so they correctly miss the cache and regenerate. Module-level so it survives
// switching choices and even navigating to a different product and back -- and mirrored to
// localStorage so it also survives reloads/dev restarts, since each cache miss costs a
// 30-90s Printful round trip. The TTL stays well inside the ~72h lifetime of Printful's
// mockup image URLs, so a restored entry's images are still fetchable; persistence is
// best-effort (quota errors / unavailable storage just mean a per-tab cache, as before).
const mockupCache = new Map();
const CACHE_STORAGE_KEY = 'cf-mockup-cache';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

try {
  const stored = JSON.parse(localStorage.getItem(CACHE_STORAGE_KEY) || '{}');
  const now = Date.now();
  for (const [key, entry] of Object.entries(stored)) {
    if (now - entry.t <= CACHE_TTL_MS) mockupCache.set(key, entry.images);
  }
} catch {
  /* corrupt or unavailable storage -- start with an empty cache */
}

function persistMockup(key, images) {
  try {
    const stored = JSON.parse(localStorage.getItem(CACHE_STORAGE_KEY) || '{}');
    const now = Date.now();
    for (const k of Object.keys(stored)) {
      if (now - stored[k].t > CACHE_TTL_MS) delete stored[k];
    }
    stored[key] = { t: now, images };
    localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    /* best-effort -- the in-memory cache above still has it */
  }
}

// v1 reports a failed task as a single `error` string (v2 used an array of
// { type, detail, source, valid_values } objects, which is why this used to do more work --
// joining those directly rendered as "[object Object]"). Kept as a function so a null/blank
// error still produces something a customer can read.
function describeFailure(error) {
  return (typeof error === 'string' && error.trim()) || 'Mockup generation failed.';
}

// `geometryPlacements` (a Set of placement keys, or null for "everywhere") is the
// customer's per-placement geometry choice from ProductPage.jsx -- part of the cache key
// because it changes rendered content just like the design/variant do, so toggling a
// checkbox must miss the cache rather than silently restoring a mockup rendered under a
// different selection. `geometryLayout` (see printful.js's renderAndUploadPrintFiles) is
// the same idea for the two-leg-canvas layout toggle. `productOptions` (e.g. stitch color,
// see ProductPage.jsx's stitch-color picker) doesn't change the print file at all, but it
// IS submitted to Printful's create-task endpoint and does change the returned photo (the
// garment's stitching is visibly white or black in the mockup) -- omitting it from the key
// would silently serve a mockup rendered under a previously-selected stitch color.
function cacheKey(product, variant, entries, design, geometryPlacements, geometryLayout, mirrorPlacements, productOptions, sizeFrame, legSymmetry, secondaryDesign) {
  const signature = entries
    .map(([placement, printfileId]) => `${placement}:${printfileId}`)
    .sort()
    .join(',');
  const geometrySignature = geometryPlacements ? [...geometryPlacements].sort().join(',') : 'all';
  const optionsSignature = productOptions ? JSON.stringify(productOptions) : 'default';
  // mirrorPlacements is part of the key because it genuinely changes the returned photo --
  // unlike the secondary-design choice, which only affects placements no camera angle shows
  // (see ProductPage's sync effect). A stale unmirrored preview would misrepresent the seam.
  const mirrorSignature = mirrorPlacements ? [...mirrorPlacements].sort().join(',') : 'none';
  // sizeFrame changes the composition itself (element sizes are measured against one leg
  // panel rather than the whole sheet -- see render/scale.js), so a stale preview would show
  // the customer a different artwork scale than the one they picked.
  const frameSignature = sizeFrame ? `${sizeFrame.width}x${sizeFrame.height}` : 'sheet';
  // Changes the returned photo (the legs become mirror images), so it belongs in the key.
  const symmetrySignature = legSymmetry ? 'sym' : 'asym';
  // The variant COLOUR, deliberately not the variant id. Sizes are meant to share a mockup --
  // they share printfile ids and Printful photographs one garment for all of them, which is
  // what `signature` above already expresses. Colours are not: Printful photographs each one,
  // so the returned photo genuinely differs. Colours on these products share their printfiles,
  // so without this they collided on one key and switching colour silently restored the
  // previous colour's mockup (found on the windbreaker, 615, whose two "colours" are the
  // stitching choice -- picking the other one appeared to do nothing at all). Also affects the
  // tote (274), the only other multi-colour product.
  const colorSignature = variant?.color || 'single';
  // The second design printed on a physically separate face (the reversible bucket hat's
  // inside). This USED to be deliberately excluded, on the grounds that the mockup only
  // requested the outside placements so a second design could not change any preview pixel --
  // true under v2, whose inside mockup styles returned images byte-identical to the outside
  // ones. v1 photographs the inside for real, and the hat now submits those placements, so the
  // choice genuinely changes the returned photos and a stale preview would misrepresent them.
  const secondarySignature = secondaryDesign ? JSON.stringify(secondaryDesign) : 'none';
  return `${product.id}:${colorSignature}:${secondarySignature}:${signature}:${geometrySignature}:${geometryLayout || 'center'}:${mirrorSignature}:${optionsSignature}:${frameSignature}:${symmetrySignature}:${JSON.stringify(design)}`;
}


export function useMockup() {
  const { renderDesignBlob } = useStudio();
  const [status, setStatus] = useState('idle'); // idle|rendering|creating|polling|completed|failed
  const [error, setError] = useState(null);
  const [images, setImages] = useState([]);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  // Seconds remaining before the next auto-retry while status is 'queued' (Printful's
  // store-wide mockup-task cap is temporarily exhausted) -- null outside that state.
  const [retryWaitSeconds, setRetryWaitSeconds] = useState(null);
  const busyStartRef = useRef(null);
  // Cache key of the generation currently running (null when none), and cache key of the
  // selection the UI currently shows. Together these fix two real problems with switching
  // artwork/variant while a generation is in flight (found live, 2026-07-10):
  // (1) switching to a selection that resolves to the SAME key (e.g. another size of the
  // same color -- sizes share printfile ids, see cacheKey's comment) used to drop the UI
  // to idle as if the run were cancelled, even though the in-flight run is byte-for-byte
  // the one the new selection needs; sync now recognizes it and leaves the busy UI alone.
  // (2) the run was never actually cancelled -- on completion it unconditionally wrote
  // status/images, so a genuinely different selection (another color) made mid-run got
  // the OLD selection's mockup popping in over it 30-90s later; completion now still
  // writes the cache but only touches visible state if its key is still the one showing.
  const inFlightKeyRef = useRef(null);
  const currentKeyRef = useRef(null);

  // Wall-clock seconds since the current busy run started, so the UI can reassure users
  // who hit a slow Printful round trip instead of just spinning silently. Ticks across the
  // whole rendering->creating->polling sequence (and any retry within it) as one continuous
  // run -- busyStartRef is only set on the non-busy->busy transition, not on every phase
  // change within a run, otherwise the clock would reset to 0 at each of those phase
  // changes instead of counting the whole thing.
  useEffect(() => {
    if (!BUSY_STATUSES.includes(status)) {
      busyStartRef.current = null;
      setElapsedSeconds(0);
      return;
    }
    if (busyStartRef.current === null) busyStartRef.current = Date.now();
    const id = setInterval(
      () => setElapsedSeconds(Math.floor((Date.now() - busyStartRef.current) / 1000)),
      1000
    );
    return () => clearInterval(id);
  }, [status]);

  const generate = useCallback(
    async ({
      product,
      printfileSpecs,
      variant,
      design,
      geometryPlacements = null,
      geometryLayout = null,
      mirrorPlacements = null,
      sizeFrame = null,
      legSymmetry = false,
      productOptions = null,
      secondaryDesign = null
    }) => {
      if (!design) {
        setStatus('failed');
        setError('Create a design in the Studio first.');
        return;
      }

      const cfg = getMockupConfigForProduct(product.id);
      const entries = resolvePlacementEntries(printfileSpecs, variant, cfg.placements);
      if (!entries) {
        setStatus('failed');
        setError('No printfile mapping for this variant.');
        return;
      }

      // A mockup request is the strongest pre-purchase signal there is -- start waking
      // the scale-to-zero render-service now so a later Buy Now doesn't pay its cold
      // start. Before the cache check on purpose: a returning visitor whose mockup is
      // cached is just as likely to buy.
      warmRenderService();

      const key = cacheKey(product, variant, entries, design, geometryPlacements, geometryLayout, mirrorPlacements, productOptions, sizeFrame, legSymmetry, secondaryDesign);
      currentKeyRef.current = key;
      const cached = mockupCache.get(key);
      if (cached) {
        setError(null);
        setImages(cached);
        setStatus('completed');
        return;
      }

      inFlightKeyRef.current = key;
      setStatus('rendering');
      setError(null);
      setImages([]);
      setRetryWaitSeconds(null);

      // Ticks a visible countdown down to 0, then flips back to 'creating' so the actual
      // retry happens under the same status the very first attempt used.
      const onWait = async waitSeconds => {
        setStatus('queued');
        for (let s = waitSeconds; s > 0; s--) {
          setRetryWaitSeconds(s);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        setRetryWaitSeconds(null);
        setStatus('creating');
      };

      try {
        const urls = await renderAndUploadPrintFiles(entries, {
          printfileSpecs,
          design,
          renderOne: capRenderStrategy(renderDesignBlob),
          pocketCrop: cfg.pocketCrop || null,
          geometryPlacements,
          geometryLayout,
          mirrorPlacements,
          // Not in cacheKey below: this is a fixed property of the product, never a customer
          // choice, so it cannot vary between two mockups of the same product and variant.
          hatWrap: getHatWrap(cfg),
          sizeFrame,
          legSymmetry,
          secondaryDesign,
          secondaryPlacements: getSecondaryDesignConfig(cfg)?.placements || null
        });

        const files = buildMockupFiles(entries, printfileSpecs, urls);

        // Printful's mockup generator has been confirmed live to occasionally return a bare
        // "Internal Server Error" failure for some all-over-print products (the track jacket,
        // 801) that then succeeds immediately on a second attempt with the exact same inputs
        // -- a transient flake on their end, not anything wrong with what we sent. One
        // automatic retry before surfacing a failure to the user. (Observed on v2; kept after
        // the v1 migration because nothing suggests the render backend behind it changed.)
        let task2 = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          task2 = null;
          setStatus('creating');
          const task = await createMockupTaskWithBackoff(
            {
              productId: product.id,
              variantIds: [variant.id],
              files,
              productOptions: productOptions || cfg.productOptions
            },
            onWait
          );

          setStatus('polling');
          for (let i = 0; i < POLL_MAX_TRIES; i++) {
            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
            const polled = await getMockupTask(task.id);
            if (polled.status === 'completed' || polled.status === 'failed') {
              task2 = polled;
              break;
            }
          }
          if (!task2) throw new Error('Mockup generation timed out.');
          if (task2.status === 'completed') break;
          if (attempt === 1) throw new Error(describeFailure(task2.error));
        }

        // Already flattened, de-duplicated by URL and ordered front-first by the Edge
        // Function (see its GET handler). One thing is still left to do here, because only the
        // client knows which placements it submitted: DROP VIEWS OF PLACEMENTS WE SENT NO
        // ARTWORK FOR. v1 returns every camera angle it has for the product, not only the ones
        // covered by the submitted files -- so the reversible bucket hat (654), whose mockup set
        // is deliberately the two OUTSIDE placements, came back with 8 views of which 4 showed a
        // blank white hat ("Front Inside", "Back Inside", "Right Front Inside", "Right Inside").
        // v2 never exposed this because we hand-picked two style ids.
        // The rule is derived rather than hardcoded: take the words of every placement the
        // product HAS but we did NOT submit, subtract the words of the ones we did, and drop any
        // view whose title uses a remaining word. On the hat that leaves {inside, label} and
        // removes exactly the four blanks; on a product where we submit everything (the t-shirt)
        // the set is empty and nothing is dropped.
        // The filter is fed the placements whose views are worth SHOWING, which is not always
        // the set we submitted. On the reversible hat with a single design, the inside faces
        // carry the same artwork as the outside ones and Printful's inside photos come back
        // visually identical to their outside counterparts (measured: matching means on all
        // four angles). Showing them would double the filmstrip with duplicates -- and on a
        // 360px phone that pushes 4 of 8 thumbnails out of view. So they are only shown once a
        // genuinely different second design makes them different photos.
        const secondaryPlacements = getSecondaryDesignConfig(cfg)?.placements || [];
        const showsSecondary = !!secondaryDesign && !isSameDesign(design, secondaryDesign);
        const entriesWorthShowing = showsSecondary
          ? entries
          : entries.filter(([placementKey]) => !secondaryPlacements.includes(placementKey));
        const unique = hideUnsubmittedViews(task2.mockups || [], entriesWorthShowing, printfileSpecs);
        mockupCache.set(key, unique);
        persistMockup(key, unique);
        // Only drive the visible state if this run's selection is still the one showing --
        // the cache write above means a later switch back restores it instantly either way.
        if (currentKeyRef.current === key) {
          setImages(unique);
          setStatus('completed');
        }
      } catch (err) {
        if (currentKeyRef.current === key) {
          setStatus('failed');
          setError(err.message);
        }
      } finally {
        if (inFlightKeyRef.current === key) inFlightKeyRef.current = null;
      }
    },
    [renderDesignBlob]
  );

  // Switching artwork or variant: if this exact combo was already generated this session,
  // restore it instantly from the cache instead of dropping to "Generate mockup" and making
  // the user wait through another Printful round trip for something they've already seen.
  // Otherwise fall back to idle so the previous selection's mockup doesn't keep showing as
  // if it were current.
  const sync = useCallback(
    ({
      product,
      printfileSpecs,
      variant,
      design,
      geometryPlacements = null,
      geometryLayout = null,
      mirrorPlacements = null,
      sizeFrame = null,
      legSymmetry = false,
      productOptions = null,
      secondaryDesign = null
    }) => {
      setError(null);
      const cfg = design && getMockupConfigForProduct(product.id);
      const entries = cfg && resolvePlacementEntries(printfileSpecs, variant, cfg.placements);
      const key =
        entries
          ? cacheKey(product, variant, entries, design, geometryPlacements, geometryLayout, mirrorPlacements, productOptions, sizeFrame, legSymmetry, secondaryDesign)
          : null;
      currentKeyRef.current = key;
      const cached = key && mockupCache.get(key);
      if (cached) {
        setImages(cached);
        setStatus('completed');
      } else if (key && inFlightKeyRef.current === key) {
        // The generation already running IS this selection's (e.g. the user switched to
        // another size of the same color, which shares the same printfiles -- see
        // cacheKey) -- keep the busy UI (narration, elapsed timer) running instead of
        // "cancelling" a run that was never actually cancelled.
      } else {
        setStatus('idle');
        setImages([]);
      }
    },
    []
  );

  return { status, error, images, elapsedSeconds, retryWaitSeconds, generate, sync };
}
