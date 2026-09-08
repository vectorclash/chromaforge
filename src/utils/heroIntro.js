import { DURATION_SLOW } from './motionTokens';

// The homepage hero's entrance, as one set of beats every part of it reads.
//
// THE THING THAT MAKES THIS NON-OBVIOUS, and that a first version got wrong by keying the
// sequence to page mount: the hero's main event is the ARTWORK, and it is not ready when the
// page is. It is a full-resolution generative render on the main thread -- measured at
// ~1.6s on this machine, and the whole point of the piece. Everything else (the nav, the
// shirt, the two buttons) was on screen from 590ms, which left 1.6 seconds of chrome sitting
// on a black page next to a blank white shirt, and then the artwork arriving on its own with
// nothing tying it to any of it. Aaron, 2026-09-08: "the entire hero just needs a unified
// intro animation, right now it's just a bit chaotic with things just popping in."
//
// So the sequence has TWO phases keyed to two different moments:
//
//   WAIT  (from mount)   the dot grid and its colour ripple, and nothing else. This is the
//                        loading state the project already built (DotRipple) and it is the
//                        only thing on screen while the render runs.
//   REVEAL (from the first artwork paint)   the artwork resolves in, and the hero assembles
//                        on top of it: nav, shirt, Generate, Save, Go to studio.
//
// Holding the controls costs the visitor nothing they could have used -- Generate is disabled
// during the first build anyway -- and it buys two things beyond the sequence itself: the
// shirt arrives already wearing the design (its texture commits on the same signal), so the
// blank white tee and its chromatic-aberration glitch are never seen at all.
export const HERO_WAIT = {
  // Late enough not to race the first paint, early enough that the page is never blank for
  // long. The ripple rides the same beat -- it draws ON the grid, so arriving first would be
  // the exact pop this sequence exists to remove.
  grid: 150
};

export const HERO_REVEAL = {
  // Offsets from the artwork beat, which is 0: `.image-container` starts its own DURATION_SLOW
  // fade at that instant, and the rest lands into it while it is still resolving.
  //
  // The three controls are 130ms apart, NOT the 60 a first version used (Aaron, 2026-09-08:
  // "animate in the ui buttons one at a time and not in one block"). 60ms is inside the same
  // 500ms fade for all three at once -- each one is barely past its neighbour's first frame,
  // so the column reads as one object arriving with a soft edge. At 130 each button has
  // visibly started before the next one does, which is the difference between a stagger you
  // can see and one that only exists in the numbers.
  nav: 150,
  shirt: 300,
  generate: 430,
  save: 560,
  studioLink: 690
};

export const HERO_REVEAL_END = HERO_REVEAL.studioLink + DURATION_SLOW * 1000;

// A bound, not a target. If the first render is slow -- an old phone, a pathological seed --
// the hero must not sit without a nav indefinitely, so the reveal runs anyway. Comfortably
// past the ~1.6s measured here, and it is measured from MOUNT, so a slow connection (which
// delays the mount itself) does not eat into it.
export const HERO_REVEAL_CAP = 3200;

// A hero mount that is already scrolled away from the top is a restored position (a browser
// back, a reload partway down), not a fresh arrival -- entering content there would animate
// what the visitor has already scrolled past. Read live rather than memoised at module scope,
// so a client-side navigation back to "/" (which resets the scroll) gets its entrance again.
export const heroIntroEnabled = () => typeof window !== 'undefined' && window.scrollY <= 40;

// `backwards` fill holds the first keyframe through the delay, so a beat that has not come
// round yet is simply not painted -- there is nothing for JS to hide once a phase has begun.
// Before its phase begins, an element carries .hero-hold instead (components.css).
export const heroIntroStyle = delay => ({ animationDelay: `${delay}ms` });

// The artwork lands inside DisplayCanvas, and the nav is rendered by HomePage, which is three
// components away and has no path to that event. Same problem, and the same answer, as
// useScrollLock's subscribeScrollLock: the place that knows announces it, and whoever needs
// it listens, rather than every consumer trying to detect the moment for itself.
const listeners = new Set();
let revealed = false;

export function subscribeHeroReveal(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// True once the hero has begun revealing. Read by anything that mounts LATE and would
// otherwise wait forever for a signal that has already been sent.
export function heroRevealStarted() {
  return revealed;
}

export function notifyHeroReveal() {
  if (revealed) return;
  revealed = true;
  listeners.forEach(fn => fn());
}

// A fresh page view starts over. Called by the hero on mount rather than reset on unmount, so
// the flag survives long enough for anything unmounting alongside it to still read it.
export function resetHeroReveal() {
  revealed = false;
}
