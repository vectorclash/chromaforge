import { useCallback, useState } from 'react';
import {
  uploadMockupSourceImage,
  createMockupTask,
  getMockupTask,
  getMockupConfigForProduct
} from '../lib/printful';
import { useStudio } from '../context/StudioContext';

// Drives a Printful v2 mockup-generation task for the current design on a chosen product
// variant. Ported out of DisplayCanvas: render each unique printfile size from the design
// (off-canvas via StudioContext.renderDesignBlob), upload, create the task, poll, dedupe.
//
// Mockups are previews, not the final print file -- cap render size well below Printful's
// real printfile dims (some 6000x6000) to stay fast and under iOS Safari's ~16.7 Mpx canvas
// limit. A front+back task completes in well under a minute, but allow generous poll
// headroom regardless.
const RENDER_CAP = 1200;
const POLL_INTERVAL_MS = 4000;
const POLL_MAX_TRIES = 45;

function scaledDims(spec) {
  const scale = RENDER_CAP / Math.max(spec.width, spec.height);
  return { width: Math.round(spec.width * scale), height: Math.round(spec.height * scale) };
}

// Caches a completed mockup by (product, exact printfile-id mapping, design content) so
// switching artwork/variant and back doesn't force another 30-90s Printful round trip for
// something already seen. Keying on the printfile-id mapping rather than e.g. variant color
// is deliberate and confirmed live: every size of a given t-shirt/hoodie color resolves to
// the *same* printfile ids (sizing is handled by repositioning on the cut pattern, not a
// different print file), so all of them correctly share one cache entry -- but the pillow's
// sizes resolve to genuinely different printfile ids (18x18 vs 22x22 vs 20x12 are different
// print areas), so they correctly miss the cache and regenerate. Module-level so it survives
// switching choices and even navigating to a different product and back, for the tab's life.
const mockupCache = new Map();

// failure_reasons is an array of { type, detail, source, valid_values } objects, not
// strings -- joining it directly (as this used to) renders as "[object Object]".
function describeFailure(reasons) {
  const detail = reasons?.map(r => r.detail || r.type).filter(Boolean).join('; ');
  return detail || 'Mockup generation failed.';
}

function resolveEntries(printfileSpecs, cfg, variant) {
  const variantPrintfiles = printfileSpecs.variant_printfiles.find(v => v.variant_id === variant.id);
  if (!variantPrintfiles) return null;
  return Object.entries(variantPrintfiles.placements).filter(
    ([key]) => !cfg.placements || cfg.placements.includes(key)
  );
}

function cacheKey(product, entries, design) {
  const signature = entries
    .map(([placement, printfileId]) => `${placement}:${printfileId}`)
    .sort()
    .join(',');
  return `${product.id}:${signature}:${JSON.stringify(design)}`;
}

export function useMockup() {
  const { renderDesignBlob } = useStudio();
  const [status, setStatus] = useState('idle'); // idle|rendering|creating|polling|completed|failed
  const [error, setError] = useState(null);
  const [images, setImages] = useState([]);

  const generate = useCallback(
    async ({ product, printfileSpecs, variant, design }) => {
      if (!design) {
        setStatus('failed');
        setError('Create a design in the Studio first.');
        return;
      }

      const cfg = getMockupConfigForProduct(product.id);
      const entries = resolveEntries(printfileSpecs, cfg, variant);
      if (!entries) {
        setStatus('failed');
        setError('No printfile mapping for this variant.');
        return;
      }

      const key = cacheKey(product, entries, design);
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
        // Render + upload each unique printfile size once (placements often share one).
        const printfileIdToUrl = {};
        for (const [, printfileId] of entries) {
          if (printfileIdToUrl[printfileId]) continue;
          const spec = printfileSpecs.printfiles.find(f => f.printfile_id === printfileId);
          if (!spec) continue;
          const { width, height } = scaledDims(spec);
          const blob = await renderDesignBlob(design, width, height);
          printfileIdToUrl[printfileId] = await uploadMockupSourceImage(blob, printfileId);
        }

        const placements = entries.map(([placementKey, printfileId]) => ({
          placement: placementKey,
          technique: cfg.technique,
          layers: [{ type: 'file', url: printfileIdToUrl[printfileId] }]
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
            productOptions: cfg.productOptions,
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
        mockupCache.set(key, unique);
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
  const sync = useCallback(({ product, printfileSpecs, variant, design }) => {
    setError(null);
    const cfg = design && getMockupConfigForProduct(product.id);
    const entries = cfg && resolveEntries(printfileSpecs, cfg, variant);
    const cached = entries && mockupCache.get(cacheKey(product, entries, design));
    if (cached) {
      setImages(cached);
      setStatus('completed');
    } else {
      setStatus('idle');
      setImages([]);
    }
  }, []);

  return { status, error, images, generate, sync };
}
