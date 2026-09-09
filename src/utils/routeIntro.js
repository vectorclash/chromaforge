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
