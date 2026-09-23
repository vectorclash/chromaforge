import { DURATION_FAST } from './motionTokens';
import { endFastWindow } from '../render/renderQueue';

// Runs `work` only once a control's "working" state is actually on screen.
//
// Every Generate in the app does its heavy lifting synchronously on the main thread --
// generateArtwork, renderArtwork, and on a design change a render per surface showing it (the
// footer's 3200x1000 band, the hero's full-size build). Started inside the click handler, all of
// that ran BEFORE the browser could paint the click's own feedback, so a button pressed and then
// nothing visibly happened until the work was done (Aaron: "a bit of a delay between clicking
// and when it actually starts"). Measured on the production build, click to first paintable
// frame: 86-141ms on the mini generator, 111-370ms in the studio, 304-817ms on the homepage hero.
//
// So the order is flipped: the caller shows its active state first (dim, spin, fade the artwork
// out), and the work starts after the next paint plus that state's own opening beat
// (DURATION_FAST, the same beat the artwork's fade-out uses). The work takes exactly as long as
// before; it just no longer hides the response to the click. Waiting out the beat rather than a
// single frame matters because the heavy work freezes every JS-driven animation while it runs --
// start it one frame in and the fade-out stalls at barely-begun, which reads as the same delay.
//
// Returns a cancel function, for unmounts.
export function afterFeedback(work, delaySeconds = DURATION_FAST) {
  // A generate is an interaction: its renders go stepwise even if the page only just loaded,
  // so the animations this very function puts on screen keep running (render/renderQueue.js).
  endFastWindow();
  let timer = 0;
  // rAF fires just before the next paint; a timeout scheduled from inside it therefore runs
  // after that paint, never before it.
  const raf = requestAnimationFrame(() => {
    timer = window.setTimeout(work, delaySeconds * 1000);
  });
  return () => {
    cancelAnimationFrame(raf);
    clearTimeout(timer);
  };
}
