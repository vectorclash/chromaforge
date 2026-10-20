// Print jobs: the render requests an order's print files are made from AFTER payment.
//
// Until 2026-10-19 the browser rendered every placement at true print resolution (through
// render-print-file) before Stripe was even opened, and the order carried finished file URLs.
// Now Buy Now goes straight to Stripe: the browser describes each placement's render -- the exact
// body it used to send render-print-file -- and process-order renders them once the money has
// settled. Render time stops being something the customer waits through.
//
// The browser still decides WHAT each placement is (which design, mirrored or not, the pocket
// crop, the leg or hat wrap...), because that logic lives in src/lib/printful.js and is shared
// with the mockup the customer approved. Duplicating it here would be a second implementation to
// drift. What the server owns is checking that a job is plausible for THIS product and variant:
// its placement exists, its canvas is exactly Printful's printfile for that placement, and it
// renders the design the order records. Everything else render-service validates itself, as it
// already did for render-print-file.

export type PrintJob = {
  design: { generatorVersion: number; seed: string; colors: unknown[]; settings?: unknown };
  width: number;
  height: number;
  label?: string;
  includeGeometry?: boolean;
  geometryLayout?: string | null;
  mirrorX?: boolean;
  sizeFrame?: unknown;
  legSymmetry?: boolean;
  geometryScale?: number;
  regions?: unknown;
  sourceWidth?: number;
  sourceHeight?: number;
  hatWrap?: unknown;
  legWrap?: unknown;
};

type PrintfileSpecs = {
  variant_printfiles: { variant_id: number; placements: Record<string, number> }[];
  printfiles: { printfile_id: number; width: number; height: number }[];
};

// Same three keys as src/lib/printfulPlacements.js's FRONT_PLACEMENT_KEYS -- the placement a
// pocket's regions are cropped from.
const FRONT_PLACEMENT_KEYS = ["front", "default", "outside_front"];

// A whole order's jobs, serialised, comfortably above any real one (a design is a few hundred
// bytes; the largest product has ~10 placements) and far below anything worth storing.
const MAX_JOBS_BYTES = 64 * 1024;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

// The design fields render-print-file forwards to render-service, and nothing else.
function pickDesign(d: unknown) {
  if (!isPlainObject(d)) return null;
  if (typeof d.seed !== "string" || d.seed.length < 1 || d.seed.length > 64) return null;
  if (!Number.isInteger(d.generatorVersion)) return null;
  if (d.colors != null && !Array.isArray(d.colors)) return null;
  return {
    generatorVersion: d.generatorVersion as number,
    seed: d.seed,
    colors: (d.colors as unknown[]) ?? [],
    ...(d.settings != null ? { settings: d.settings } : {})
  };
}

const designKey = (d: ReturnType<typeof pickDesign>) =>
  d ? JSON.stringify([d.generatorVersion, d.seed, d.colors, d.settings ?? null]) : "";

export async function fetchPrintfileSpecs(productId: number, printfulKey: string): Promise<PrintfileSpecs | null> {
  const res = await fetch(`https://api.printful.com/mockup-generator/printfiles/${productId}`, {
    headers: { Authorization: `Bearer ${printfulKey}` }
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.result ?? null;
}

// Returns the sanitised jobs, or an error string. `designs` are the order's own design(s): a job
// may only render one of them, so the order's audit copy describes what is printed.
export function validatePrintJobs(
  raw: unknown,
  { specs, variantId, designs }: { specs: PrintfileSpecs; variantId: number; designs: unknown[] }
): { jobs: Record<string, PrintJob> } | { error: string } {
  if (!isPlainObject(raw)) return { error: "Invalid print jobs" };
  if (JSON.stringify(raw).length > MAX_JOBS_BYTES) return { error: "Invalid print jobs" };

  const variantFiles = specs.variant_printfiles?.find(v => v.variant_id === variantId);
  if (!variantFiles) return { error: "Unknown variant" };
  const specById = new Map(specs.printfiles.map(p => [p.printfile_id, p]));
  const allowedDesigns = new Set(designs.map(d => designKey(pickDesign(d))).filter(Boolean));
  const frontKey = Object.keys(variantFiles.placements).find(k => FRONT_PLACEMENT_KEYS.includes(k));
  const frontSpec = frontKey ? specById.get(variantFiles.placements[frontKey]) : undefined;

  const jobs: Record<string, PrintJob> = {};
  for (const [placement, job] of Object.entries(raw)) {
    const printfileId = variantFiles.placements[placement];
    const spec = printfileId != null ? specById.get(printfileId) : undefined;
    if (!spec || !isPlainObject(job)) return { error: `Invalid print job for ${placement}` };

    const design = pickDesign(job.design);
    if (!design || !allowedDesigns.has(designKey(design))) {
      return { error: `Print job for ${placement} does not match the ordered design` };
    }
    // The canvas must be Printful's own printfile for this placement -- never a size the client
    // chose. That is also what bounds the render's cost.
    if (job.width !== spec.width || job.height !== spec.height) {
      return { error: `Print job for ${placement} has the wrong size` };
    }
    // A pocket's regions are cropped from the FRONT's composition, generated at the front's size.
    if (job.regions != null) {
      if (!frontSpec || job.sourceWidth !== frontSpec.width || job.sourceHeight !== frontSpec.height) {
        return { error: `Print job for ${placement} has the wrong source size` };
      }
    }

    const label = typeof job.label === "string" || typeof job.label === "number" ? String(job.label) : "";
    jobs[placement] = {
      design,
      width: spec.width,
      height: spec.height,
      ...(/^[A-Za-z0-9_-]{1,64}$/.test(label) ? { label } : {}),
      includeGeometry: job.includeGeometry !== false,
      geometryLayout: typeof job.geometryLayout === "string" ? job.geometryLayout : null,
      mirrorX: job.mirrorX === true,
      sizeFrame: job.sizeFrame ?? null,
      legSymmetry: job.legSymmetry === true,
      ...(typeof job.geometryScale === "number" ? { geometryScale: job.geometryScale } : {}),
      ...(job.regions != null
        ? { regions: job.regions, sourceWidth: job.sourceWidth as number, sourceHeight: job.sourceHeight as number }
        : {}),
      ...(job.hatWrap != null ? { hatWrap: job.hatWrap } : {}),
      ...(job.legWrap != null ? { legWrap: job.legWrap } : {})
    };
  }
  return { jobs };
}
