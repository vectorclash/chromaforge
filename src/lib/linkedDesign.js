// A link that names a saved design -- `/shop?id=<design>`, `/shop/257?id=<design>`, any page --
// makes that design the visit's ACTIVE design (StudioContext's currentDesign), so an ad lands on
// the shop or a product already wearing its artwork (Aaron, 2026-11-15).
//
// The homepage and the studio are left out: their DisplayCanvas already reads `?id=` itself
// (init()), loads the row through its own reveal and hands the design to StudioContext. Doing it
// here as well would build the same design twice.
//
// One load per visit, started the first time anything asks, shared by everyone who waits on it:
// StudioContext adopts the result, and the shop and product page hold their first screenful for it
// (waitForLinkedDesign) so the grid never shows a random design and then swaps. A bad, deleted or
// private id, or an animation (animations never print -- savedAnimation's printableRow), resolves
// to null and the visit keeps its own design.
//
// The row is rebuilt with the bundle's generateArtwork, so it carries the CURRENT generator version
// (the stamp a stored row needs before it re-enters the live pipeline -- withCurrentGeneratorVersion's
// rule) and the full config every surface expects of currentDesign, not the compact stored form.
import { supabase } from './supabase';
import { printableRow } from './savedAnimation';
import { getDesignIdFromUrl } from '../utils/urlConfig';
import { generateArtwork } from '../render/generateArtwork';

const OWN_LOADERS = new Set(['/', '/studio']);
// Database ids are UUIDs; anything else is a mistyped link, not worth a request.
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let load = null;
let settled = false;

export function loadLinkedDesign() {
  if (load) return load;
  const id = typeof window === 'undefined' ? null : getDesignIdFromUrl();
  if (!id || !ID_RE.test(id) || OWN_LOADERS.has(window.location.pathname)) {
    settled = true;
    load = Promise.resolve(null);
    return load;
  }
  // maybeSingle, not lib/designs' getDesign: a deleted or private id is an ordinary outcome here,
  // and .single() turns it into a 406 the browser logs as an error.
  load = fetchRow(id)
    .then(row => {
      const printable = printableRow(row);
      const data = printable?.data;
      if (!data?.seed) return null;
      const design = generateArtwork(data.seed, 1080, 1080, data.colors ?? [], data.settings ?? null);
      return { id: row.id, title: row.title ?? null, design };
    })
    .catch(err => {
      console.warn('Linked design could not be loaded:', err?.message || err);
      return null;
    })
    .finally(() => {
      settled = true;
    });
  return load;
}

// True while a link's design is still on its way -- the ambient surfaces hold their first render
// for it rather than render the visit's opening design and throw it away.
export function linkedDesignPending() {
  loadLinkedDesign();
  return !settled;
}

async function fetchRow(id) {
  const { data, error } = await supabase.from('designs').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

// For a page holding its first paint: the linked design, or null if there is none or it has not
// arrived within `ms` -- a slow request must not hold the shop back (it is still adopted when it
// lands, through StudioContext).
export function waitForLinkedDesign(ms = 2500) {
  return Promise.race([loadLinkedDesign(), new Promise(resolve => setTimeout(() => resolve(null), ms))]);
}
