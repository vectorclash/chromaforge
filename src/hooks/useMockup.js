import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createMockupTask,
  getMockupTask,
  getMockupConfigForProduct,
  resolvePlacementEntries,
  renderAndUploadPrintFiles,
  capRenderStrategy
} from '../lib/printful';
import { useStudio } from '../context/StudioContext';

// Drives a Printful v2 mockup-generation task for the current design on a chosen product
// variant. Ported out of DisplayCanvas: render each unique printfile size from the design
// (off-canvas via StudioContext.renderDesignBlob), upload, create the task, poll, dedupe.
// The render+upload step (renderAndUploadPrintFiles) is shared with the real checkout flow
// in lib/checkout.js -- see lib/printful.js for why mockups filter to cfg.placements while
// checkout doesn't.
const POLL_INTERVAL_MS = 4000;
const POLL_MAX_TRIES = 45;

// Exported so callers (ProductPage) share one definition of "actively working" instead of
// re-deriving it from status strings independently.
export const BUSY_STATUSES = ['rendering', 'creating', 'polling'];

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

// failure_reasons is an array of { type, detail, source, valid_values } objects, not
// strings -- joining it directly (as this used to) renders as "[object Object]".
function describeFailure(reasons) {
  const detail = reasons?.map(r => r.detail || r.type).filter(Boolean).join('; ');
  return detail || 'Mockup generation failed.';
}

// `geometryPlacements` (a Set of placement keys, or null for "everywhere") is the
// customer's per-placement geometry choice from ProductPage.jsx -- part of the cache key
// because it changes rendered content just like the design/variant do, so toggling a
// checkbox must miss the cache rather than silently restoring a mockup rendered under a
// different selection. `geometryLayout` (see printful.js's renderAndUploadPrintFiles) is
// the same idea for the two-leg-canvas layout toggle. `productOptions` (e.g. stitch color,
// see ProductPage.jsx's stitch-color picker) doesn't change the print file at all, but it
// IS submitted to Printful's mockup-tasks endpoint and does change the returned photo (the
// garment's stitching is visibly white or black in the mockup) -- omitting it from the key
// would silently serve a mockup rendered under a previously-selected stitch color.
function cacheKey(product, entries, design, geometryPlacements, geometryLayout, productOptions) {
  const signature = entries
    .map(([placement, printfileId]) => `${placement}:${printfileId}`)
    .sort()
    .join(',');
  const geometrySignature = geometryPlacements ? [...geometryPlacements].sort().join(',') : 'all';
  const optionsSignature = productOptions ? JSON.stringify(productOptions) : 'default';
  return `${product.id}:${signature}:${geometrySignature}:${geometryLayout || 'center'}:${optionsSignature}:${JSON.stringify(design)}`;
}

export function useMockup() {
  const { renderDesignBlob } = useStudio();
  const [status, setStatus] = useState('idle'); // idle|rendering|creating|polling|completed|failed
  const [error, setError] = useState(null);
  const [images, setImages] = useState([]);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const busyStartRef = useRef(null);

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
      productOptions = null
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

      const key = cacheKey(product, entries, design, geometryPlacements, geometryLayout, productOptions);
      const cached = mockupCache.get(key);
      if (cached) {
        setError(null);
        setImages(cached);
        setStatus('completed');
        return;
      }

      setStatus('rendering');
      setError(null);
      setImages([]);
      try {
        const urls = await renderAndUploadPrintFiles(entries, {
          printfileSpecs,
          design,
          renderOne: capRenderStrategy(renderDesignBlob),
          pocketCrop: cfg.pocketCrop || null,
          geometryPlacements,
          geometryLayout
        });

        const placements = entries.map(([placementKey]) => ({
          placement: placementKey,
          technique: cfg.technique,
          layers: [{ type: 'file', url: urls[placementKey] }]
        }));

        // Printful's v2 mockup-tasks endpoint has been confirmed live to occasionally
        // return a bare "Internal Server Error" failure for some all-over-print products
        // (the track jacket, 801) that then succeeds immediately on a second attempt with
        // the exact same inputs -- a transient flake on their end, not anything wrong with
        // what we sent. One automatic retry before surfacing a failure to the user.
        let task2 = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          task2 = null;
          setStatus('creating');
          const task = await createMockupTask({
            productId: product.id,
            variantIds: [variant.id],
            placements,
            productOptions: productOptions || cfg.productOptions,
            mockupStyleIds: cfg.mockupStyleIds
          });

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
          if (attempt === 1) throw new Error(describeFailure(task2.failure_reasons));
        }

        const mockups = task2.catalog_variant_mockups?.[0]?.mockups || [];
        // Placements sharing a camera angle render pixel-identical images at distinct
        // throwaway URLs -- dedupe by style_id (the photo angle), not mockup_url.
        const seen = new Set();
        const unique = mockups.filter(m => {
          if (seen.has(m.style_id)) return false;
          seen.add(m.style_id);
          return true;
        });
        // Printful doesn't guarantee the response order matches the requested
        // mockupStyleIds order (confirmed live: the track jacket comes back back-then-front
        // even though front is requested first) -- re-sort by cfg.mockupStyleIds so front is
        // always images[0] regardless of what Printful hands back.
        unique.sort(
          (a, b) => cfg.mockupStyleIds.indexOf(a.style_id) - cfg.mockupStyleIds.indexOf(b.style_id)
        );
        mockupCache.set(key, unique);
        persistMockup(key, unique);
        setImages(unique);
        setStatus('completed');
      } catch (err) {
        setStatus('failed');
        setError(err.message);
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
      productOptions = null
    }) => {
      setError(null);
      const cfg = design && getMockupConfigForProduct(product.id);
      const entries = cfg && resolvePlacementEntries(printfileSpecs, variant, cfg.placements);
      const cached =
        entries &&
        mockupCache.get(cacheKey(product, entries, design, geometryPlacements, geometryLayout, productOptions));
      if (cached) {
        setImages(cached);
        setStatus('completed');
      } else {
        setStatus('idle');
        setImages([]);
      }
    },
    []
  );

  return { status, error, images, elapsedSeconds, generate, sync };
}
