// The studio's recent generations, kept on this device so a design is never lost to the next
// Generate or a tab switch (Aaron, 2026-10-10: "I hit generate and a moment later realized
// that the artwork was amazing and I should have saved it"). The studio's Recent panel shows
// them; StudioContext owns the list and is the only writer.
//
// An entry is the design's identity only -- seed, colours, settings, a few hundred bytes --
// never pixels: a design regenerates identically from those, so the list costs nothing to keep
// and survives a reload. Thumbnails are rendered when the panel opens.
//
// Pure functions over the list plus a guarded localStorage read/write, so it runs in plain Node.
// Deliberately no import of render/compactDesign (it pulls in the whole generator).
import { compactSettings, isSameDesign } from '../render/designSettings';

export const RECENT_STORAGE_KEY = 'cf-studio:recent';
const KEY = RECENT_STORAGE_KEY;
const VERSION = 1;
// Nine: a full 3x3 grid in the panel. It was 20, which read as overwhelming (Aaron, 2026-10-10).
export const RECENT_MAX = 9;

const HEX = /^#[0-9a-f]{3,8}$/i;

// The stored form of a design: what toCompactDesign keeps, minus generatorVersion (a record of
// when a design was saved, never a rendering instruction -- and an entry is not saved anywhere).
export function recentDesignOf(design) {
  const out = { seed: design.seed, colors: [...(design.colors || [])] };
  const settings = compactSettings(design.settings);
  if (settings) out.settings = settings;
  return out;
}

function validEntry(e) {
  return (
    e &&
    typeof e.id === 'string' &&
    e.design &&
    typeof e.design.seed === 'string' &&
    Array.isArray(e.design.colors) &&
    e.design.colors.every(c => typeof c === 'string' && HEX.test(c)) &&
    (e.design.settings === undefined || (typeof e.design.settings === 'object' && e.design.settings !== null)) &&
    (e.savedId === null || typeof e.savedId === 'string')
  );
}

export function readRecentDesigns() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (!raw || raw.v !== VERSION || !Array.isArray(raw.entries)) return [];
    return raw.entries
      .filter(validEntry)
      .slice(-RECENT_MAX)
      .map(e => ({ id: e.id, design: e.design, savedId: e.savedId ?? null, savedTitle: e.savedTitle ?? null }));
  } catch {
    return [];
  }
}

export function writeRecentDesigns(entries) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: VERSION, entries }));
  } catch {
    // Storage full or blocked: the list still works for this visit.
  }
}

let counter = 0;
function newId() {
  counter += 1;
  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}

// A design reached the screen. Returns the new { entries, currentId }.
//   - Already in the list (a recalled design, a reload of the same one): it becomes current and
//     nothing moves. Going back never reorders or deletes anything.
//   - The same seed as the CURRENT entry, reshaped by a slider or a palette edit: that entry is
//     updated in place, so tweaking one design doesn't fill the list with near-copies of it --
//     unless that entry is saved, which keeps the saved version and adds the reshaped one.
//   - Otherwise it is new: added at the end, and the oldest drops off past RECENT_MAX.
// `saved` ({ id, title }) marks it as a gallery row, when the caller knows it is one.
export function recordRecentDesign(entries, currentId, design, saved = null) {
  const stored = recentDesignOf(design);
  const existing = entries.find(e => isSameDesign(e.design, stored));
  if (existing) {
    if (saved && existing.savedId !== saved.id) {
      return {
        entries: entries.map(e => (e === existing ? { ...e, savedId: saved.id, savedTitle: saved.title ?? null } : e)),
        currentId: existing.id
      };
    }
    return { entries, currentId: existing.id };
  }
  const savedFields = { savedId: saved?.id ?? null, savedTitle: saved?.title ?? null };
  const current = entries.find(e => e.id === currentId);
  if (current && current.design.seed === stored.seed && !current.savedId) {
    return {
      entries: entries.map(e => (e === current ? { ...e, design: stored, ...savedFields } : e)),
      currentId: current.id
    };
  }
  const entry = { id: newId(), design: stored, ...savedFields };
  return { entries: [...entries, entry].slice(-RECENT_MAX), currentId: entry.id };
}

// A design was saved to (or loaded from) the gallery as row `id`.
export function markRecentSaved(entries, design, id, title = null) {
  const stored = recentDesignOf(design);
  let changed = false;
  const next = entries.map(e => {
    if (!isSameDesign(e.design, stored) || (e.savedId === id && e.savedTitle === title)) return e;
    changed = true;
    return { ...e, savedId: id, savedTitle: title };
  });
  return changed ? next : entries;
}

// Gallery row `id` was deleted: the design stays in the list, it just isn't saved any more.
export function markRecentDeleted(entries, id) {
  if (!entries.some(e => e.savedId === id)) return entries;
  return entries.map(e => (e.savedId === id ? { ...e, savedId: null, savedTitle: null } : e));
}

// Cache key for an entry's thumbnail: changes whenever the design it shows does.
export function recentDesignKey(design) {
  return JSON.stringify(recentDesignOf(design));
}
