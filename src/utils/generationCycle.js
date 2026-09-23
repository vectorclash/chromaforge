import { DURATION_FAST, DURATION_HOLD, DURATION_SLOW } from './motionTokens';

// One Generate, one loading state, one reveal -- across every surface showing the design.
//
// Before this, each surface (the mini generator's thumbnail, the footer's art band, the mobile
// nav, the product/gallery tiles, the About blob, the hero, the shirt) ran its OWN crossfade, and
// each one entered its loading state only when ITS new image arrived. Those arrive at very
// different times -- a 480px thumbnail in tens of ms, the footer's 3200x1000 band much later --
// so one click produced a ripple of surfaces going dark one after another and coming back one
// after another (Aaron: "when you click generate it needs to be in the generate state across the
// board in sync. not this weird way it is now").
//
// Now a Generate begins a CYCLE here, at the click:
//   loading    every surface fades its current image out and shows its loading indicator, NOW.
//   (work)     each surface's new render is tracked (trackCycleWork).
//   revealing  once the new design exists, every tracked render has landed, and at least
//              MIN_LOADING has passed, every surface fades the new design in at the same instant.
//   idle       DURATION_SLOW later, when those fade-ins have finished.
// MIN_LOADING keeps the rhythm every surface already had (fade out, blank hold); the cycle only
// decides WHEN, it adds no new motion.
//
// Only a Generate starts a cycle. A slider tweak, a palette edit or a gallery load still reveals
// per surface, exactly as before.
//
// A plain module store rather than React state: its consumers include a class component
// (DisplayCanvas) and GSAP callbacks, and a change of phase must not re-render the app.
const MIN_LOADING_MS = (DURATION_FAST + DURATION_HOLD) * 1000;
// A render that never settles must not strand the whole site in a loading state.
const MAX_LOADING_MS = 10000;

let cycle = null; // { id, phase: 'loading' | 'revealing', startedAt, pending, designChanged }
let nextId = 1;
const listeners = new Set();
let checkTimer = 0;
let safetyTimer = 0;
let idleTimer = 0;

function notify() {
  const snapshot = getCycle();
  listeners.forEach(fn => fn(snapshot));
}

/** @returns {{ id: number, phase: 'loading' | 'revealing' } | null} */
export function getCycle() {
  return cycle ? { id: cycle.id, phase: cycle.phase } : null;
}

export function subscribeCycle(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// A Generate was clicked. Begins a new cycle, replacing any still running (work tracked for
// the old one still counts: it is the same surfaces, now rendering the newer design).
export function beginCycle() {
  clearTimeout(idleTimer);
  clearTimeout(safetyTimer);
  clearTimeout(checkTimer);
  cycle = {
    id: nextId++,
    phase: 'loading',
    startedAt: performance.now(),
    pending: cycle?.pending ?? new Set(),
    adds: 0,
    designChanged: false
  };
  safetyTimer = window.setTimeout(reveal, MAX_LOADING_MS);
  notify();
  return cycle.id;
}

// The active design changed. The cycle cannot reveal before this -- until then, no surface has
// even been asked for the new render.
export function markCycleDesign() {
  if (!cycle || cycle.phase !== 'loading') return;
  cycle.designChanged = true;
  scheduleCheck();
}

// Holds the reveal until `promise` settles (either way). A no-op outside a loading cycle, so a
// render that is not part of a Generate never delays anything.
export function trackCycleWork(promise) {
  if (!cycle || cycle.phase !== 'loading') return promise;
  const { pending } = cycle;
  const done = Promise.resolve(promise).then(
    () => {},
    () => {}
  );
  pending.add(done);
  cycle.adds += 1;
  done.then(() => {
    pending.delete(done);
    scheduleCheck();
  });
  return promise;
}

// Runs `fn` at the reveal of cycle `id` -- immediately if that has already happened, or if a
// newer cycle has replaced it (whoever asked is then out of date; letting it finish is the
// safe choice, the same as a surface with no cycle at all).
export function whenRevealed(id, fn) {
  if (!cycle || cycle.id !== id || cycle.phase !== 'loading') {
    fn();
    return () => {};
  }
  const unsubscribe = subscribeCycle(c => {
    if (!c || c.id !== id || c.phase !== 'loading') {
      unsubscribe();
      fn();
    }
  });
  return unsubscribe;
}

function scheduleCheck() {
  clearTimeout(checkTimer);
  // A macrotask, so a render queued in the same commit that changed the design (every surface's
  // effect runs in that commit) is tracked before the set is judged empty.
  checkTimer = window.setTimeout(check, 0);
}

// Nothing pending is not yet proof nothing is COMING: a surface's render resolves a moment
// before React hands its new url to that surface's crossfade, which then tracks its own decode.
// So an empty set is only trusted if it is still empty, with nothing added, one painted frame
// later.
function check() {
  if (!cycle || cycle.phase !== 'loading') return;
  if (!cycle.designChanged || cycle.pending.size > 0) return;
  const wait = MIN_LOADING_MS - (performance.now() - cycle.startedAt);
  if (wait > 0) {
    checkTimer = window.setTimeout(check, wait);
    return;
  }
  const { id, adds } = cycle;
  requestAnimationFrame(() => {
    checkTimer = window.setTimeout(() => {
      if (!cycle || cycle.id !== id || cycle.phase !== 'loading') return;
      if (cycle.pending.size > 0 || cycle.adds !== adds) return; // something joined; its settle re-checks
      reveal();
    }, 0);
  });
}

function reveal() {
  if (!cycle || cycle.phase !== 'loading') return;
  clearTimeout(safetyTimer);
  clearTimeout(checkTimer);
  cycle.phase = 'revealing';
  const { id } = cycle;
  notify();
  idleTimer = window.setTimeout(() => {
    if (cycle && cycle.id === id) {
      cycle = null;
      notify();
    }
  }, DURATION_SLOW * 1000);
}
