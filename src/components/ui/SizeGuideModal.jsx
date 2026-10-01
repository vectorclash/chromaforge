import React, { useEffect, useRef, useState } from 'react';
import SolidPanel from './SolidPanel';
import Button from './Button';
import useScrollLock from '../../hooks/useScrollLock';
import { getSizeGuide } from '../../lib/printful';
import { humanError } from '../../lib/errorMessage';

// Printful's published size guide, surfaced on the product page. This exists because
// "which size am I?" is a real question the store previously left entirely unanswered, and
// because it's the honest answer to it -- a saved default size was built and reverted the
// same day (see IDEAS.md) precisely because sizing differs per garment, which is exactly
// what a per-product table addresses and a remembered preference cannot.
//
// Two table types come back and they are NOT interchangeable:
//   'measure_yourself'  -- body measurements (Chest/Waist/Hips) per size. Self-explanatory,
//                          actionable on its own, and the one that answers the question.
//                          Present on 11 of the 18 products (re-counted 2026-08-28 when the
//                          beanie, neck gaiter and wide-leg pants were added -- the pants and
//                          beanie have one, the one-size gaiter doesn't). Note that count went
//                          10-of-15 to 11-of-18 rather than 12: the windbreaker (615) has since
//                          DROPPED its body table upstream and now returns product_measure only.
//                          Nothing to fix -- the modal renders whatever tables come back -- but
//                          it is live proof this set drifts.
//   'product_measure'   -- the garment laid flat, with measurements labelled A, B, C...
//                          Those labels are keyed to letters on Printful's diagram, so the
//                          numbers are MEANINGLESS without the image beside them. Present on
//                          all 18. Hence the diagram is rendered as part of the table rather
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
// Scanning all 18 products' real size payloads (re-run 2026-08-28 over 169 description,
// image_description, unit and measurement-label fields) turns up only four named entities:
// &nbsp; (75), &quot; (64), &rsquo; (17, including the men's tee) and &Prime; (2, the crossbody
// bag) -- every one of them already in the list below, and the only tags present are p, strong,
// span and br, all of which the generic strip above removes. &rsquo; and &Prime; were once
// missed and rendered literally as "they&rsquo;re" on most products' size guides -- found while
// adding the bandana. The rest of the typographic
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

// The flat-garment table's columns are bare letters (A, B, C) keyed to Printful's diagram, and
// what each letter means only arrives as image_description prose beneath it -- so a reader had
// to scroll past the diagram to learn what "A" was, then back up to read the numbers. This
// lifts the names into the column headers. Every product's legend (all 18, checked
// 2026-10-01) is one "letter, optional dash, name" per line once htmlToText has run:
// "A 1/2 chest width", "B -  Length", "A Waist" followed by a sentence of instructions.
// Returns a map only when EVERY column letter got a name: a partial legend would leave some
// columns explained in the header and the rest only below, which is worse than either.
function parseLegend(text, labels) {
  if (!text || !labels.length) return null;
  const names = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z])\s*[-–—:]?\s+(.+)$/) || line.match(/^([A-Z])\s*[-–—:]\s*(.+)$/);
    if (!m || !labels.includes(m[1]) || names[m[1]]) continue;
    const name = m[2].trim();
    // Every real name is a short noun phrase ("1/2 hem width" is the longest at 3 words). A
    // longer or punctuated line is prose that merely starts with the word "A".
    if (name.split(/\s+/).length > 3 || /[.!?]$/.test(name)) continue;
    names[m[1]] =name.charAt(0).toUpperCase() + name.slice(1);
  }
  return labels.every(l => names[l]) ? names : null;
}

// Local disclosure, same chevron/summary shape as ProductPage's "Print options" panel.
// Used rather than showing everything at once because the full guide is genuinely long: the
// men's tee's body table is six rows of ONE measurement, and Printful's diagram beneath it
// is physically larger than the data it annotates -- then the flat-garment section repeats
// the whole pattern with a second diagram.
function Disclosure({ label, open, onToggle, children }) {
  const [settled, setSettled] = useState(open);
  // Closing un-settles at once, so the clip is back before the row starts shrinking.
  useEffect(() => {
    if (!open) setSettled(false);
  }, [open]);
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
      {/* Always mounted and opened by class -- the same grid-rows expansion as ProductPage's
          Print options (see .print-options-panel, which these rules share). A conditional
          mount can animate in but has nothing on screen to animate on the way out, so this
          used to pop shut. `inert` keeps collapsed content out of the tab order; the clip is
          dropped once settled so the open content's focus rings aren't sliced. */}
      <div
        className={'disclosure-panel' + (open ? ' is-open' : '') + (settled ? ' is-settled' : '')}
        style={{ '--panel-gap': '0.75rem' }}
        inert={!open}
        onTransitionEnd={e => {
          if (e.target === e.currentTarget && e.propertyName === 'grid-template-rows') setSettled(open);
        }}
      >
        <div className="disclosure-inner">
          {/* The cascade staggers this div's children, so content always sits one level in. */}
          <div className="space-y-3">{children}</div>
        </div>
      </div>
    </div>
  );
}

// Sizes become ROWS and measurements COLUMNS, not the other way round: a product can carry
// up to 11 sizes (the hoodie runs 2XS-6XL) but never more than about five measurements, and
// 11 columns cannot be read on a phone.
//
// `names` (from parseLegend) puts each letter's meaning under it in the header. `selectedSize`
// is the size picked on the product page; its row is marked so the guide opens on the
// customer's own answer. Only an exact match is marked -- a product whose variant labels
// differ from its guide's (none today) simply marks nothing rather than guessing.
function MeasurementTable({ table, unit, names, selectedSize }) {
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
            <th scope="col" className="py-2 pr-3 pl-2 align-bottom text-xs font-bold uppercase tracking-wide text-text-muted">
              Size
            </th>
            {measurements.map(m => (
              <th
                key={m.type_label}
                scope="col"
                className="py-2 pr-3 align-bottom text-xs font-bold uppercase tracking-wide text-text-muted"
              >
                {m.type_label}
                {names?.[m.type_label] && (
                  <span className="mt-0.5 block max-w-[7rem] text-[11px] font-semibold normal-case leading-tight tracking-normal text-text-secondary">
                    {names[m.type_label]}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sizes.map(size => {
            const selected = size === selectedSize;
            return (
              <tr
                key={size}
                aria-current={selected ? 'true' : undefined}
                className={
                  'border-b border-hairline/50 last:border-0 ' + (selected ? 'bg-accent/10' : '')
                }
              >
                <th
                  scope="row"
                  className={
                    'py-2 pr-3 font-bold ' + (selected ? 'pl-2 text-accent shadow-[inset_2px_0_0_var(--color-accent)]' : 'pl-2 text-text')
                  }
                >
                  {size}
                </th>
                {measurements.map(m => (
                  <td
                    key={m.type_label}
                    className={'py-2 pr-3 ' + (selected ? 'text-text' : 'text-text-secondary')}
                  >
                    {valueFor(m, size)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

// Which edges of the scrolling body currently hide content. Drives the hairlines under the
// header and above the footer, so a body that scrolls says so -- and one that fits draws no
// rule at all. Re-measured on scroll, on resize, and whenever the body's own content changes
// size (a disclosure opening, the guide arriving, the diagram decoding).
function useScrollEdges(ref, deps) {
  const [edges, setEdges] = useState({ top: false, bottom: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const top = el.scrollTop > 1;
      const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      setEdges(prev => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    // A disclosure opens with fade-slide-up, whose 16px translate is scrollable overflow for
    // as long as it runs. When it ends nothing changes SIZE, so the observer below never
    // fires and the footer rule stayed on over a body with nothing left to scroll (measured
    // on the neck gaiter: scrollHeight 453 -> 443 with no resize). Diagrams decoding late
    // are caught the same way; `load` does not bubble, hence capture.
    el.addEventListener('animationend', measure);
    el.addEventListener('transitionend', measure);
    el.addEventListener('load', measure, true);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    return () => {
      el.removeEventListener('scroll', measure);
      el.removeEventListener('animationend', measure);
      el.removeEventListener('transitionend', measure);
      el.removeEventListener('load', measure, true);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return edges;
}

export default function SizeGuideModal({ open, productId, productTitle, selectedSize, onClose }) {
  useScrollLock(open);
  const [guide, setGuide] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [unitKey, setUnitKey] = useState('in');
  const [howToOpen, setHowToOpen] = useState(false);
  // null = "not chosen yet", which resolves to closed when a body table exists above it and
  // OPEN when it is the only table -- otherwise a product with no body table (the
  // windbreaker, every bag, the hats) opened onto a single collapsed button and a footnote.
  const [garmentChoice, setGarmentChoice] = useState(null);
  const unit = UNITS.find(u => u.key === unitKey) || UNITS[0];
  const bodyRef = useRef(null);

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
      .catch(err => !cancelled && setError(humanError(err, "We couldn't load the size guide.")))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open, productId]);

  // A different product gets its own default for the garment section.
  useEffect(() => {
    setGarmentChoice(null);
    setHowToOpen(false);
  }, [productId]);

  const edges = useScrollEdges(bodyRef, [open, guide, loading, error, howToOpen, garmentChoice]);

  if (!open) return null;

  const tables = guide?.size_tables || [];
  // Body measurements first where they exist -- that's the table that answers "which size
  // am I", while the flat-garment one answers "how big is the garment".
  const ordered = [...tables].sort((a, b) => (a.type === 'measure_yourself' ? -1 : 0) - (b.type === 'measure_yourself' ? -1 : 0));
  const hasBody = ordered.some(t => t.type === 'measure_yourself');
  const garmentOpen = garmentChoice ?? !hasBody;

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/60 px-4 py-6 backdrop-blur-sm"
      onClick={onClose}
    >
      {/* Header and footer stay put and only the middle scrolls. When the whole panel
          scrolled, a guide a few pixels too tall for the viewport (the hoodie, by 23px at
          1280x900) left the bottom of the panel sliced through, which read as broken rather
          than scrollable. */}
      <SolidPanel
        className="flex max-h-[92vh] w-full max-w-lg animate-pop-in flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="size-guide-title"
        onClick={e => e.stopPropagation()}
      >
        <div
          className={
            'shrink-0 border-b px-5 pt-4 pb-3 transition-colors sm:px-6 sm:pt-5 ' +
            (edges.top ? 'border-hairline' : 'border-transparent')
          }
        >
          <div className="flex items-center justify-between gap-4">
            <h2 id="size-guide-title" className="font-quicksand text-lg font-bold text-text">
              Size guide
            </h2>
            {/* Same close control as the artwork picker and gallery modals. It replaced a
                full-size Close button that sat alone at the right of an otherwise empty
                footer row, repeating what Esc and the backdrop already do. */}
            <Button type="button" variant="icon" className="-mr-2" onClick={onClose} aria-label="Close">
              <CloseIcon />
            </Button>
          </div>
          <div className="mt-1 flex items-center justify-between gap-4">
            <p className="min-w-0 text-sm text-text-secondary">{productTitle}</p>
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
        </div>

        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-3 sm:px-6">
          {loading && <p className="mt-3 text-sm text-text-secondary">Loading size guide…</p>}
          {error && <p className="mt-3 text-sm text-accent">{error}</p>}
          {/* Only reachable when Printful genuinely returns an empty size_tables array. A
              malformed/stale response can't land here -- getSizeGuide shape-checks and throws,
              so that case renders as an error rather than as a confident claim about what
              Printful publishes. */}
          {!loading && !error && guide && !ordered.length && (
            <p className="mt-3 text-sm text-text-secondary">
              No size guide is published for this product.
            </p>
          )}

          {ordered.map(table => {
            const isBody = table.type === 'measure_yourself';
            const description = htmlToText(table.description);
            const imageDescription = htmlToText(table.image_description);
            // Garment tables only: their columns ARE letters. A body table's columns are
            // already words, and its image_description is measuring instructions.
            const names = isBody
              ? null
              : parseLegend(imageDescription, (table.measurements || []).map(m => m.type_label));
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
                {/* Once the letters are named in the table's own header, this legend would
                    only repeat them. It stays as the fallback when the legend can't be read. */}
                {imageDescription && !names && (
                  <p className="whitespace-pre-line text-xs text-text-muted">{imageDescription}</p>
                )}
              </>
            );

            // Body measurements are the answer to "which size am I", so that table stays open.
            // Its diagram is not: the description already explains the measurement in words, so
            // the picture is a nice-to-have that was taking more room than the numbers.
            if (isBody) {
              return (
                <section key={table.type} className="mt-3 space-y-3">
                  <h3 className="font-quicksand text-xs font-bold uppercase tracking-[0.14em] text-text-muted">
                    Your measurements
                  </h3>
                  {description && (
                    <p className="whitespace-pre-line text-xs text-text-muted">{description}</p>
                  )}
                  <MeasurementTable table={table} unit={unit} selectedSize={selectedSize} />
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
            // so the whole section (table AND image together) collapses as one unit when a body
            // table sits above it.
            return (
              <section key={table.type} className={hasBody ? 'mt-4' : 'mt-3'}>
                <Disclosure
                  label="Product measurements"
                  open={garmentOpen}
                  onToggle={() => setGarmentChoice(!garmentOpen)}
                >
                  {description && (
                    <p className="whitespace-pre-line text-xs text-text-muted">{description}</p>
                  )}
                  <MeasurementTable table={table} unit={unit} names={names} selectedSize={selectedSize} />
                  {diagram}
                </Disclosure>
              </section>
            );
          })}
        </div>

        {/* Deliberately makes no variance claim of its own. It used to say "allow up to 1″",
            directly under Printful's own garment text saying up to 2″ on the windbreaker --
            the garment descriptions already state each product's tolerance. */}
        <div
          className={
            'shrink-0 border-t px-5 pt-3 pb-4 transition-colors sm:px-6 sm:pb-5 ' +
            (edges.bottom ? 'border-hairline' : 'border-transparent')
          }
        >
          <p className="text-xs text-text-muted">
            Measurements are published by Printful, who make each piece by hand.
          </p>
        </div>
      </SolidPanel>
    </div>
  );
}
