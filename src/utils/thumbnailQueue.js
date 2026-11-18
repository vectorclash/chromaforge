// Spaces out gallery thumbnail requests (2026-11-18). Every card used to ask for its thumbnail the
// moment it mounted, and over HTTP/2 nothing holds those back: scrolling quickly through ~90 designs
// sent 134 requests in 5s, and Supabase Storage refused 26 of them with 429 Too Many Requests for
// ~30s. Now a card asks only once it is near the screen (`watchNear`), and then waits for a slot
// (`requestSlot`), which takes two things:
//   - one of MAX_IN_FLIGHT concurrent requests, and
//   - a token from a bucket holding BURST that refills at RATE per second. Storage's limit is a
//     RATE, and a concurrency cap alone does not bound it: thumbnails come off the CDN in a few
//     ms, so 6 slots still turned over ~36 requests a second and the worst 5s held ~180 (measured).
//     16 + 10/s keeps a fast scroll to well under the burst Storage refused (134 in 5s).
// The free slot goes to the waiting card CLOSEST TO THE SCREEN, not the first to ask: after a fast
// scroll, where you land fills first, and cards left behind drop out (`watchNear`) before asking.
//
// A slot is held for ONE attempt: GalleryThumbnail gives it back on the first load or error, so a
// refused card's retries (FadeImage's jittered schedule) never block the cards behind it. A slot is
// also given back after STALL_MS whatever happens, so a request that never settles cannot wedge
// the queue for the rest of the visit.

const MAX_IN_FLIGHT = 6;
const BURST = 16;
const RATE = 10; // tokens per second
const STALL_MS = 15000;

let inFlight = 0;
const waiting = [];
let tokens = BURST;
let refilledAt = 0;
let pumpTimer = 0;

function refill() {
  const now = performance.now();
  if (refilledAt) tokens = Math.min(BURST, tokens + ((now - refilledAt) / 1000) * RATE);
  refilledAt = now;
}

// Distance from the element's centre to the viewport's centre, vertically.
function distance(entry) {
  const el = entry.el;
  if (!el || !el.isConnected) return Infinity;
  const r = el.getBoundingClientRect();
  return Math.abs(r.top + r.height / 2 - window.innerHeight / 2);
}

function pump() {
  refill();
  while (inFlight < MAX_IN_FLIGHT && waiting.length && tokens >= 1) {
    let best = 0;
    if (waiting.length > 1) {
      let bestD = Infinity;
      for (let i = 0; i < waiting.length; i++) {
        const d = distance(waiting[i]);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    const [next] = waiting.splice(best, 1);
    tokens -= 1;
    inFlight += 1;
    next.grant();
  }
  // Out of tokens with cards still waiting (and a request slot free): come back when one refills.
  if (waiting.length && inFlight < MAX_IN_FLIGHT && tokens < 1 && !pumpTimer) {
    pumpTimer = setTimeout(() => {
      pumpTimer = 0;
      pump();
    }, Math.ceil(((1 - tokens) / RATE) * 1000));
  }
}

// Asks for a slot for the card at `el` (used to rank by distance from the screen). `onGrant(release)`
// runs when one is free; call `release` when the request has settled (extra calls are ignored).
// Returns a cancel function for a card that unmounts or leaves the screen first: it leaves the
// queue if still waiting, or gives its slot back if it had one.
export function requestSlot(el, onGrant) {
  let state = 'waiting';
  let stallTimer = 0;
  const release = () => {
    if (state !== 'granted') return;
    state = 'done';
    clearTimeout(stallTimer);
    inFlight -= 1;
    pump();
  };
  const entry = {
    el,
    grant: () => {
      state = 'granted';
      stallTimer = setTimeout(release, STALL_MS);
      onGrant(release);
    }
  };
  waiting.push(entry);
  pump();
  return () => {
    if (state === 'waiting') {
      state = 'done';
      const i = waiting.indexOf(entry);
      if (i >= 0) waiting.splice(i, 1);
    } else {
      release();
    }
  };
}

// One shared IntersectionObserver for every card: `onChange(near)` is told whether the element is
// within NEAR_MARGIN of the viewport. Returns an unwatch function.
const NEAR_MARGIN = '400px 0px';
let observer = null;
const watchers = new Map();

export function watchNear(el, onChange) {
  if (typeof IntersectionObserver === 'undefined') {
    onChange(true);
    return () => {};
  }
  if (!observer) {
    observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) watchers.get(entry.target)?.(entry.isIntersecting);
      },
      { rootMargin: NEAR_MARGIN }
    );
  }
  watchers.set(el, onChange);
  observer.observe(el);
  return () => {
    watchers.delete(el);
    observer.unobserve(el);
  };
}

// Whether this page has already fetched `url` -- the gallery's own preload of the first screen, or
// a card seen earlier in the visit -- so its card can skip the queue and show at once. Read from
// the browser's resource-timing list, which records every load (cache hits included) and, unlike
// probing with `new Image()`, starts no request: a probe per card was itself the burst, sending
// all 197 requests at mount before a single card reached the queue.
export function alreadyFetched(url) {
  if (!url || typeof performance === 'undefined' || !performance.getEntriesByName) return false;
  return performance.getEntriesByName(new URL(url, window.location.href).href).length > 0;
}
