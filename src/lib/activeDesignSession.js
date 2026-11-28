// The tab's ACTIVE design (StudioContext's currentDesign), kept in sessionStorage so a reload of
// the same tab comes back wearing it (2026-11-27, Aaron: a gallery design taken to the shop came
// back as a different artwork after the windbreaker's page reloaded itself on his phone).
//
// The active design otherwise lives only in memory, and a page can reload without anyone asking:
// iOS Safari kills a tab's web process when memory runs short and reloads it on the spot
// (measured in the visit events: a second page load on /shop/615 1.3s after the product page
// opened, in a tab that had just shown the zip hoodie and the track jacket), lazyWithReload
// reloads once when a route chunk will not load, and Stripe's cancel link comes back to the
// product page as a fresh page load -- which lost the design on EVERY checkout someone backed out
// of. In each case the visitor is still in the middle of something with that design.
//
// What it does NOT change: a visit still opens on artwork nobody has seen. sessionStorage belongs
// to one tab and dies with it, so a new visit starts empty; and a load of the homepage or the
// studio ignores it -- those are where Generate lives, and a refresh there is a request for new
// art (StudioContext's opening design). A `?id=` link still wins over it (linkedDesign.js).
//
// Stored compact -- { seed, colors, settings }, the same identity a saved row holds, a few hundred
// bytes -- plus the saved row's id and title when the design is one, so it comes back reading
// "Saved" instead of offering a duplicate save. Rebuilt with the bundle's generateArtwork, exactly
// as a saved row is. Anything unreadable is ignored and the visit opens on a fresh design.
import { toCompactDesign } from '../render/compactDesign';
import { generateArtwork } from '../render/generateArtwork';

const KEY = 'cf-active-design';
const VERSION = 1;
// Where a load starts on new art regardless (see above).
const FRESH_PATHS = new Set(['/', '/studio']);
// The forms studioPrefs accepts for a palette colour.
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function storage() {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Record the active design for this tab. Cheap to call on every change: it writes only when the
 * stored value would change.
 * @param {object|null} design a generateArtwork() result (or anything with seed/colors/settings)
 * @param {{ id?: string|null, title?: string|null }} [saved] the saved row it IS, if any
 */
let lastWritten = null;
export function writeActiveDesign(design, saved = {}) {
  const store = storage();
  if (!store || !design?.seed) return;
  const { seed, colors, settings } = toCompactDesign(design);
  const value = { v: VERSION, seed, colors: colors ?? [], settings: settings ?? null };
  if (design.autoPalette) value.autoPalette = true;
  if (saved.id) {
    value.savedId = saved.id;
    if (saved.title) value.savedTitle = saved.title;
  }
  const serialized = JSON.stringify(value);
  if (serialized === lastWritten) return;
  lastWritten = serialized;
  try {
    store.setItem(KEY, serialized);
  } catch {
    // Full or blocked: a reload then opens on new art, as it always did.
  }
}

/**
 * The design this tab had before it reloaded, rebuilt -- or null on a homepage/studio load, in a
 * new tab, or for anything that does not read back cleanly.
 * @returns {{ design: object, savedId: string|null, savedTitle: string|null } | null}
 */
export function readActiveDesign() {
  const store = storage();
  if (!store || FRESH_PATHS.has(window.location.pathname)) return null;
  try {
    const value = JSON.parse(store.getItem(KEY) || 'null');
    if (!value || value.v !== VERSION || typeof value.seed !== 'string' || !value.seed) return null;
    const colors = Array.isArray(value.colors) ? value.colors : [];
    if (colors.length > 6 || !colors.every(c => typeof c === 'string' && HEX.test(c))) return null;
    const settings = value.settings && typeof value.settings === 'object' ? value.settings : null;
    const design = generateArtwork(value.seed, 1080, 1080, colors, settings);
    if (value.autoPalette) design.autoPalette = true;
    lastWritten = JSON.stringify(value);
    const savedId = typeof value.savedId === 'string' && ID.test(value.savedId) ? value.savedId : null;
    const savedTitle = savedId && typeof value.savedTitle === 'string' ? value.savedTitle.slice(0, 200) : null;
    return { design, savedId, savedTitle };
  } catch (err) {
    console.warn('Could not restore the active design:', err?.message || err);
    return null;
  }
}
