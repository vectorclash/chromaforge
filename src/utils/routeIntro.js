// Delays for the route entrance cascade, for the items a page positions itself.
//
// Most sections need nothing from this file -- PageContainer's `.intro-stagger` gives every
// direct child its delay from CSS (see tailwind.css). This exists for the other case: a
// section that opts out with `.intro-skip` because it runs its own cascade over a list of
// items, and now has to place those items in the same rhythm rather than starting over at
// zero. Without it a card grid would arrive at the same instant as the page header above it,
// and the page would read as two entrances rather than one.
//
// STEP is the gap between page SECTIONS and is mirrored in tailwind.css's nth-child rules --
// they must move together, so change both or neither.
export const INTRO_STEP = 65;

// Items inside one section are peers arriving together, not a sequence being read, so they
// come faster. At the section rate a full shop grid would take 65 x 10 = 650ms to finish
// after its section had already started, which reads as the page still loading.
export const INTRO_STEP_ITEM = 45;

// Past nine, a section is below the fold on any viewport and an item nobody can see must not
// sit out a delay it will never be watched through. Mirrors the nth-child(n + 9) cap.
export const INTRO_MAX = 8;

/**
 * When one item inside an `.intro-skip` section should start, in ms.
 *
 * @param section  the section's own index among PageContainer's children (0-based), so the
 *                 items continue from where the section itself would have started.
 * @param item     the item's index within that section.
 */
export function introDelay(section, item = 0) {
  return Math.min(section, INTRO_MAX) * INTRO_STEP + item * INTRO_STEP_ITEM;
}

/** The same thing as an inline style, which is how nearly every call site wants it. */
export function introStyle(section, item = 0) {
  return { animationDelay: `${introDelay(section, item)}ms` };
}

// ---------------------------------------------------------------------------------------
// A route whose Suspense fallback shows the page's OWN chrome has already played its
// entrance by the time the page itself mounts, and must not play it again.
//
// The shop and gallery skeletons render the REAL header (their headings are compile-time
// constants) and a grid in the final geometry, so the handover is invisible -- which is what
// makes a second entrance read as the page animating in twice. Measured before the fix: two
// header entrances on one load of /shop and /gallery, against one everywhere else (Aaron,
// 2026-09-09: "the full page appears and animates in then again").
//
// THE PRODUCT PAGE'S REAL PAGE DELIBERATELY DOES NOT INHERIT THAT CLAIM, and that asymmetry
// is the whole point. Its skeleton is placeholder bars with no title at all, so the real page
// arriving IS new content and has to enter -- that 808ms cascade is the thing this whole
// system exists to deliver. The rule is "do not re-animate what the visitor has already
// seen", not "animate once".
//
// WHICH IS WHY A CLAIM CARRIES A KIND, and a container skips its entrance only when the
// standing claim MATCHES its own. The product route mounts its skeleton up to three separate
// times on a cold load -- the Suspense fallback, then the page's own `loading` render, then
// the copy inside SkeletonFadeOut -- and each is a fresh mount, so each replayed the cascade
// (Aaron, 2026-09-09: "the skeleton content animate twice as it loads in", cold load only,
// because a warm visit has no fallback phase). Those three are all `placeholder`, so the
// second and third enter nothing; the real page is `content`, does not match, and still
// enters in full.
//
// The claim is RELEASED when the claiming tree unmounts, so returning to the route later
// enters again. That ordering is safe: React renders the incoming tree (where PageContainer
// reads this, during render) before it commits the swap that unmounts the outgoing one.
let claim = null;

export function claimRouteIntro(pathname, kind = 'content') {
  claim = { pathname, kind };
}

export function releaseRouteIntro(pathname, kind = 'content') {
  if (claim && claim.pathname === pathname && claim.kind === kind) claim = null;
}

export function routeIntroClaimed(pathname, kind = 'content') {
  return claim !== null && claim.pathname === pathname && claim.kind === kind;
}
