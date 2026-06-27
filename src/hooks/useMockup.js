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
// limit. A 5-placement task completes in ~40-80s, so allow generous poll headroom.
const RENDER_CAP = 1200;
const POLL_INTERVAL_MS = 4000;
const POLL_MAX_TRIES = 45;

function scaledDims(spec) {
  const scale = RENDER_CAP / Math.max(spec.width, spec.height);
  return { width: Math.round(spec.width * scale), height: Math.round(spec.height * scale) };
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
      setStatus('rendering');
      setError(null);
      setImages([]);
      try {
        const variantPrintfiles = printfileSpecs.variant_printfiles.find(
          v => v.variant_id === variant.id
        );
        if (!variantPrintfiles) throw new Error('No printfile mapping for this variant.');

        const cfg = getMockupConfigForProduct(product.id);
        // Restrict to the hand-verified placement subset -- submitting every placement
        // (e.g. the hoodie's back/label placements) left tasks stuck pending indefinitely.
        const entries = Object.entries(variantPrintfiles.placements).filter(
          ([key]) => !cfg.placements || cfg.placements.includes(key)
        );

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

        const placements = entries.map(([key, printfileId]) => ({
          placement: key,
          technique: cfg.technique,
          layers: [{ type: 'file', url: printfileIdToUrl[printfileId] }]
        }));

        setStatus('creating');
        const task = await createMockupTask({
          productId: product.id,
          variantIds: [variant.id],
          placements,
          productOptions: cfg.productOptions
        });

        setStatus('polling');
        for (let i = 0; i < POLL_MAX_TRIES; i++) {
          await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
          const task2 = await getMockupTask(task.id);
          if (task2.status === 'completed') {
            const mockups = task2.catalog_variant_mockups?.[0]?.mockups || [];
            // Placements sharing a camera angle render pixel-identical images at distinct
            // throwaway URLs -- dedupe by style_id (the photo angle), not mockup_url.
            const seen = new Set();
            const unique = mockups.filter(m => {
              if (seen.has(m.style_id)) return false;
              seen.add(m.style_id);
              return true;
            });
            setImages(unique);
            setStatus('completed');
            return;
          }
          if (task2.status === 'failed') {
            throw new Error(task2.failure_reasons?.join(', ') || 'Mockup generation failed.');
          }
        }
        throw new Error('Mockup generation timed out.');
      } catch (err) {
        setStatus('failed');
        setError(err.message);
      }
    },
    [renderDesignBlob]
  );

  // Back to idle/no-images -- callers use this when the artwork or variant changes, so a
  // stale mockup from a previous selection doesn't keep showing as if it were current.
  const reset = useCallback(() => {
    setStatus('idle');
    setError(null);
    setImages([]);
  }, []);

  return { status, error, images, generate, reset };
}
