// Which full-screen overlay, if any, is covering the page -- so work for surfaces the visitor
// cannot see can step aside for work they can.
//
// Written for MobileNav, the one overlay with a Generate inside it. A Generate re-renders every
// surface showing the design, and the shared cycle (generationCycle.js) holds its reveal until
// all of them have landed. With the menu open that included the homepage's full-size hero, the
// 3D shirt's texture pieces, the footer band and the About blob -- none of them visible behind an
// opaque menu -- so a Generate from the menu took 3.0-3.7s on the homepage against 1.76s on
// /shop, measured (Aaron: "sometimes takes 3 times longer to generate").
//
// While an overlay is registered here:
//   - renderQueue puts renders for surfaces behind it in a BACKGROUND lane, after every render
//     for something visible (see renderArtworkQueued);
//   - trackCycleWork ignores their work, so the reveal waits only on what the visitor can see.
// Hidden surfaces still re-render, afterwards, and reveal on their own when they land -- which is
// normally while the menu is still covering them.
//
// A surface is "in front" when its element sits inside the overlay, or when its caller says so
// (renderDesignBlob's `foreground`, for renders that do not know their element).
let overlay = null;

export function setFocusOverlay(el) {
  overlay = el || null;
}

// Only clears if `el` is still the registered overlay, so a late cleanup cannot clear a newer one.
export function clearFocusOverlay(el) {
  if (overlay === el) overlay = null;
}

export function overlayActive() {
  return !!overlay && overlay.isConnected;
}

// Whether `el` is hidden behind the registered overlay. An element we cannot place (null) is
// treated as behind it only while an overlay is up -- the conservative reading for work that is
// about to be demoted, since everything in front of the overlay can say so explicitly.
export function isBehindOverlay(el) {
  if (!overlayActive()) return false;
  return !(el && overlay.contains(el));
}
