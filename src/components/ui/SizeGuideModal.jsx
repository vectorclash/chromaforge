import React, { useEffect, useState } from 'react';
import SolidPanel from './SolidPanel';
import Button from './Button';
import useScrollLock from '../../hooks/useScrollLock';
import { getSizeGuide } from '../../lib/printful';

// Printful's published size guide, surfaced on the product page. This exists because
// "which size am I?" is a real question the store previously left entirely unanswered, and
// because it's the honest answer to it -- a saved default size was built and reverted the
// same day (see IDEAS.md) precisely because sizing differs per garment, which is exactly
// what a per-product table addresses and a remembered preference cannot.
//
// Two table types come back and they are NOT interchangeable:
//   'measure_yourself'  -- body measurements (Chest/Waist/Hips) per size. Self-explanatory,
//                          actionable on its own, and the one that answers the question.
//                          Present on 10 of the 15 products.
//   'product_measure'   -- the garment laid flat, with measurements labelled A, B, C...
//                          Those labels are keyed to letters on Printful's diagram, so the
//                          numbers are MEANINGLESS without the image beside them. Present on
//                          all 15. Hence the diagram is rendered as part of the table rather
//                          than as decoration, and a table with no usable image still shows
//                          its letters alongside imageDescription, which explains them.
//
// Fetched lazily on first open (see getSizeGuide) -- most product views never open this, so
// it would be a wasted request on every page load otherwise.

// Printful returns inches; cm is derived here rather than re-fetching with unit=cm.
const UNITS = [
  { key: 'in', label: 'inches', suffix: '″', convert: v => v },
  { key: 'cm', label: 'cm', suffix: ' cm', convert: v => v * 2.54 }
];

// The description fields are HTML fragments from Printful (<p>, <strong>, <span style>,
// &nbsp;). They're rendered as TEXT, never via dangerouslySetInnerHTML: it's third-party
// markup on a page that also takes payment, and nothing in these strings needs formatting
// badly enough to justify an injection surface. Block tags become line breaks so the
// original paragraph structure survives as plain text.
//
// Entity decoding is a string-only allowlist plus numeric escapes -- deliberately NOT the
// usual "assign innerHTML to a detached element and read textContent" trick, which decodes
// everything but is exactly the injection surface this function exists to avoid.
// Scanning all 15 products' real size payloads (2026-07-27) turns up only three named
// entities: &nbsp;, &rsquo; (14 sites, including the men's tee) and &Prime; (the crossbody
// bag). The latter two were previously missed and rendered literally as "they&rsquo;re" on
// most products' size guides -- found while adding the bandana. The rest of the typographic
// set below is Printful's own WYSIWYG vocabulary, decoded pre-emptively so a copy edit
// upstream can't reintroduce the same visible defect.
// &amp; is decoded LAST: doing it first (as this used to) turns a literal "&amp;rsquo;" into
// "&rsquo;" and then into an apostrophe, double-decoding text Printful meant literally.

// String.fromCodePoint throws a RangeError on anything outside 0..0x10FFFF (and on
// surrogates via fromCodePoint's own rules), which would take the whole modal down mid-render
// over a malformed third-party string. An out-of-range escape is left exactly as written
// instead -- ugly, but it's what Printful sent.
function codePoint(value, original) {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return original;
  try {
    return String.fromCodePoint(value);
  } catch {
    return original;
  }
}

function htmlToText(html) {
  if (typeof html !== 'string') return '';
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&rsquo;/g, '’')
    .replace(/&lsquo;/g, '‘')
    .replace(/&rdquo;/g, '”')
    .replace(/&ldquo;/g, '“')
    .replace(/&Prime;/g, '″')
    .replace(/&prime;/g, '′')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&deg;/g, '°')
    .replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => codePoint(parseInt(hex, 16), m))
    .replace(/&#(\d+);/g, (m, dec) => codePoint(Number(dec), m))
    .replace(/&amp;/g, '&')
    .replace(/\n{2,}/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

// Local disclosure, same chevron/summary shape as ProductPage's "Print options" panel.
// Used rather than showing everything at once because the full guide is genuinely long: the
// men's tee's body table is six rows of ONE measurement, and Printful's diagram beneath it
// is physically larger than the data it annotates -- then the flat-garment section repeats
// the whole pattern with a second diagram.
function Disclosure({ label, open, onToggle, children }) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border border-hairline px-3 py-2 text-left transition hover:border-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-interactive"
      >
        <span className="font-quicksand text-xs font-bold uppercase tracking-[0.14em] text-text-muted">
          {label}
        </span>
        <svg
          viewBox="0 0 24 24"
          width={16}
          height={16}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={'shrink-0 text-text-muted transition-transform duration-200 ' + (open ? 'rotate-180' : '')}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && <div className="mt-3 animate-fade-slide-up">{children}</div>}
    </div>
  );
}

// Sizes become ROWS and measurements COLUMNS, not the other way round: a product can carry
// up to 11 sizes (the hoodie runs 2XS-6XL) but never more than about five measurements, and
// 11 columns cannot be read on a phone.
function MeasurementTable({ table, unit }) {
  const measurements = table.measurements || [];
  if (!measurements.length) return null;
  const sizes = [];
  for (const m of measurements) {
    for (const v of m.values || []) if (!sizes.includes(v.size)) sizes.push(v.size);
  }
  const valueFor = (m, size) => {
    const hit = (m.values || []).find(v => v.size === size);
    if (!hit) return '—';
    // Some measurements come back as a min/max range rather than a single value.
    const format = raw => {
      const n = parseFloat(raw);
      return Number.isFinite(n) ? `${Math.round(unit.convert(n) * 10) / 10}${unit.suffix}` : '—';
    };
    if (hit.min_value != null && hit.max_value != null) {
      return `${format(hit.min_value)}–${format(hit.max_value)}`;
    }
    return format(hit.value);
  };

  return (
    // Its own horizontal scroll container so a wide table can never make the page itself
    // scroll sideways.
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="w-full min-w-[18rem] border-collapse text-left font-quicksand text-sm">
        <thead>
          <tr className="border-b border-hairline">
            <th scope="col" className="py-2 pr-3 text-xs font-bold uppercase tracking-wide text-text-muted">
              Size
            </th>
            {measurements.map(m => (
              <th
                key={m.type_label}
                scope="col"
                className="py-2 pr-3 text-xs font-bold uppercase tracking-wide text-text-muted"
              >
                {m.type_label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sizes.map(size => (
            <tr key={size} className="border-b border-hairline/50 last:border-0">
              <th scope="row" className="py-2 pr-3 font-bold text-text">
                {size}
              </th>
              {measurements.map(m => (
                <td key={m.type_label} className="py-2 pr-3 text-text-secondary">
                  {valueFor(m, size)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function SizeGuideModal({ open, productId, productTitle, onClose }) {
  useScrollLock(open);
  const [guide, setGuide] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [unitKey, setUnitKey] = useState('in');
  // Both collapsed by default -- see the Disclosure comment for why the full guide is too
  // long to show at once.
  const [howToOpen, setHowToOpen] = useState(false);
  const [garmentOpen, setGarmentOpen] = useState(false);
  const unit = UNITS.find(u => u.key === unitKey) || UNITS[0];

  useEffect(() => {
    if (!open) return;
    const onKeyDown = e => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // Keyed on productId as well as open: the modal outlives a product change on this page.
  useEffect(() => {
    if (!open || !productId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getSizeGuide(productId)
      .then(result => !cancelled && setGuide(result))
      .catch(err => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open, productId]);

  if (!open) return null;

  const tables = guide?.size_tables || [];
  // Body measurements first where they exist -- that's the table that answers "which size
  // am I", while the flat-garment one answers "how big is the garment".
  const ordered = [...tables].sort((a, b) => (a.type === 'measure_yourself' ? -1 : 0) - (b.type === 'measure_yourself' ? -1 : 0));

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/60 px-4 py-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <SolidPanel
        className="flex max-h-[92vh] w-full max-w-lg animate-pop-in flex-col overflow-y-auto p-5 sm:p-6"
        role="dialog"
        aria-modal="true"
        aria-labelledby="size-guide-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="size-guide-title" className="font-quicksand text-lg font-bold text-text">
              Size guide
            </h2>
            <p className="truncate text-sm text-text-secondary">{productTitle}</p>
          </div>
          <div className="flex shrink-0 gap-1">
            {UNITS.map(u => (
              <button
                key={u.key}
                type="button"
                onClick={() => setUnitKey(u.key)}
                aria-pressed={unitKey === u.key}
                className={
                  'cursor-pointer rounded-lg border px-2.5 py-1 font-quicksand text-xs font-bold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-interactive ' +
                  (unitKey === u.key
                    ? 'border-accent bg-accent text-ink-950'
                    : 'border-hairline text-text-secondary hover:border-text')
                }
              >
                {u.label}
              </button>
            ))}
          </div>
        </div>

        {loading && <p className="mt-6 text-sm text-text-secondary">Loading size guide…</p>}
        {error && <p className="mt-6 text-sm text-accent">{error}</p>}
        {/* Only reachable when Printful genuinely returns an empty size_tables array. A
            malformed/stale response can't land here -- getSizeGuide shape-checks and throws,
            so that case renders as an error rather than as a confident claim about what
            Printful publishes. */}
        {!loading && !error && !ordered.length && (
          <p className="mt-6 text-sm text-text-secondary">
            No size guide is published for this product.
          </p>
        )}

        {ordered.map(table => {
          const isBody = table.type === 'measure_yourself';
          const description = htmlToText(table.description);
          const imageDescription = htmlToText(table.image_description);
          const diagram = table.image_url && (
            <>
              {/* Printful's own measuring diagram. A third-party image, but NOT new
                  third-party exposure: this page already loads product photos and generated
                  mockups from the same Printful CDN, so no host is contacted here that the
                  page wasn't contacting anyway. (Contrast the gallery's avatar rule, where
                  rendering a provider URL would have introduced a brand-new host.)
                  Height-capped and object-contain: the artwork is mostly whitespace around a
                  small figure, so at full bleed it dwarfed the table it annotates. */}
              <img
                src={table.image_url}
                alt={`${isBody ? 'How to measure' : 'Garment measurement'} diagram for ${productTitle}`}
                loading="lazy"
                className="max-h-56 w-full rounded-xl bg-white object-contain p-2"
              />
              {imageDescription && (
                <p className="mt-2 whitespace-pre-line text-xs text-text-muted">{imageDescription}</p>
              )}
            </>
          );

          // Body measurements are the answer to "which size am I", so that table stays open.
          // Its diagram is not: the description already explains the measurement in words, so
          // the picture is a nice-to-have that was taking more room than the numbers.
          if (isBody) {
            return (
              <section key={table.type} className="mt-5 space-y-3">
                <h3 className="font-quicksand text-xs font-bold uppercase tracking-[0.14em] text-text-muted">
                  Your measurements
                </h3>
                {description && (
                  <p className="whitespace-pre-line text-xs text-text-muted">{description}</p>
                )}
                <MeasurementTable table={table} unit={unit} />
                {diagram && (
                  <Disclosure
                    label="How to measure"
                    open={howToOpen}
                    onToggle={() => setHowToOpen(o => !o)}
                  >
                    {diagram}
                  </Disclosure>
                )}
              </section>
            );
          }

          // The flat-garment table answers "how big is the garment", a follow-up question --
          // and its A/B/C labels are unreadable without the diagram, so the whole section
          // (table AND image together) collapses as one unit rather than separately.
          return (
            <section key={table.type} className="mt-4">
              <Disclosure
                label="Garment measurements"
                open={garmentOpen}
                onToggle={() => setGarmentOpen(o => !o)}
              >
                <div className="space-y-3">
                  {description && (
                    <p className="whitespace-pre-line text-xs text-text-muted">{description}</p>
                  )}
                  <MeasurementTable table={table} unit={unit} />
                  {diagram}
                </div>
              </Disclosure>
            </section>
          );
        })}

        <p className="mt-6 text-xs text-text-muted">
          Measurements are published by Printful, who make these garments. Products are made
          by hand, so allow up to 1&Prime; of variance.
        </p>
        <div className="mt-4 flex justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </SolidPanel>
    </div>
  );
}
