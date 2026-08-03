// Waits for a batch of image URLs to finish decoding, so a grid can be revealed already
// holding its pictures instead of appearing as empty cards that fill in afterwards.
//
// Why this exists: the gallery used to drop its skeleton the instant the Supabase query
// resolved, which is well before any thumbnail had downloaded. That produced a visible
// three-stage load -- placeholder grid, then a differently-sized grid of blank cards, then
// images fading in one by one -- and read as a page erroring out and retrying rather than
// as content arriving.
//
// Two deliberate properties:
//   - It NEVER rejects. A thumbnail that 404s is completely normal here (designs saved
//     before thumbnails existed have no Storage object -- see lib/designs.js), and one
//     missing image must not hold the whole grid back, so `onerror` resolves the same as
//     `onload`. The card's own <FadeImage onError> still hides the broken slot.
//   - It is capped by `timeoutMs`. This is a progressive enhancement, not a gate: if the
//     network is slow the page must still show up on time. Losing the preload just means
//     falling back to the per-card placeholders, which is the old behaviour, not a break.
//
// Preloading also makes the reveal itself free: FadeImage checks `probe.complete` for an
// already-decoded src and mounts fully opaque when it finds one, so images warmed here
// skip their own pulse-and-fade entirely rather than replaying it a second time.
// 1500ms: the gallery warms 8 thumbnails, measured at a 38KB median (~300KB the batch), so
// anything from roughly 1.6Mbps up finishes inside the cap and gets a grid that arrives
// complete. Slower than that and the cap fires first, which is the intended degradation --
// the structure appears on time and the stragglers fade in per card, as they used to.
export function preloadImages(urls, { timeoutMs = 1500 } = {}) {
  if (typeof window === 'undefined' || urls.length === 0) return Promise.resolve();

  const settled = urls.map(
    url =>
      new Promise(resolve => {
        const img = new window.Image();
        img.onload = resolve;
        img.onerror = resolve;
        img.src = url;
      })
  );

  let timer;
  const deadline = new Promise(resolve => {
    timer = setTimeout(resolve, timeoutMs);
  });

  return Promise.race([Promise.all(settled), deadline]).then(() => clearTimeout(timer));
}
