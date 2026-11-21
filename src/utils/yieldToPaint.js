// Lets the page paint before the next piece of work. A rAF alone would stall in a background tab,
// where it does not fire, so the timeout is the fallback that keeps hidden work moving. (It lived
// in render/animationFrames.js, the 2D animation build, which went with the 2D mode on 2026-11-21.)
/** @returns {Promise<void>} */
export function yieldToPaint() {
  return new Promise(resolve => {
    let done = false;
    const go = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    requestAnimationFrame(() => setTimeout(go, 0));
    setTimeout(go, 100);
  });
}
