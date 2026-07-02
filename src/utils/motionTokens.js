// Shared motion timings, in seconds (GSAP's unit) -- mirrors the --duration-* custom
// properties in tailwind.css's @theme block. Kept in sync by hand rather than read from
// CSS: GSAP's JS-level tweens can't consume a CSS custom property without a runtime
// getComputedStyle lookup on every animation, not worth the cost for hot animation code.
// Consolidates what used to be five near-duplicate ad-hoc values (0.2/0.3/0.35/0.45/0.5s)
// scattered across components down to three actual tiers.
export const DURATION_FAST = 0.2; // quick UI feedback -- icon morphs, small fades
export const DURATION_BASE = 0.35; // standard transitions -- most panel/element animation
export const DURATION_SLOW = 0.5; // slower, more deliberate entrances/crossfades

// Millisecond form for setTimeout/CSS transitionDuration call sites that don't work in
// GSAP's seconds -- e.g. the crossfade widgets' own fade timing.
export const DURATION_SLOW_MS = DURATION_SLOW * 1000;
