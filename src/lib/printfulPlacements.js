// Pure placement/view helpers for the Printful mockup pipeline.
//
// Split out of lib/printful.js for the same reason printfulMockupConfig.js was: that module
// imports the Supabase client, so anything living in it can only run inside Vite. These three
// functions are pure data transforms with no dependencies, and scripts/check-printful-mockups.mjs
// needs to exercise the REAL ones -- a checker that reimplements the logic it is checking will
// drift away from the code it is supposed to protect, which is the entire point of the exercise.
//
// lib/printful.js re-exports all three, so existing imports are unchanged.

// Which placements the chosen variant needs, as [placementKey, printfileId] pairs.
// `placementFilter` narrows to the mockup-visible subset (PRODUCT_MOCKUP_CONFIG's `placements`);
// checkout deliberately passes none, because a placement left out of an ORDER prints as blank
// fabric on the real garment.
export function resolvePlacementEntries(printfileSpecs, variant, placementFilter) {
  const variantPrintfiles = printfileSpecs.variant_printfiles.find(v => v.variant_id === variant.id);
  if (!variantPrintfiles) return null;
  return Object.entries(variantPrintfiles.placements).filter(
    ([key]) => !placementFilter || placementFilter.includes(key)
  );
}

// The `files` array for a v1 mockup task: one entry per placement, each carrying the artwork URL
// and the print area it fills. `position` is REQUIRED by v1 (the task 400s with "Position field
// is missing" without it) and is built here rather than in the Edge Function because
// `printfileSpecs` is already in the browser's hands -- it was fetched to render the artwork in
// the first place, so deriving it server-side would mean a second Printful round trip for numbers
// we already hold.
//
// The window is always the FULL print area (top/left 0, width/height = the printfile's own
// dimensions), which is the same "fill the whole printfile" rule the real order path uses. That
// is what keeps a preview honest: the mockup and the print file are framed alike.
export function buildMockupFiles(entries, printfileSpecs, urlsByPlacement) {
  return entries
    .filter(([placementKey]) => urlsByPlacement[placementKey])
    .map(([placementKey, printfileId]) => {
      const spec = printfileSpecs.printfiles.find(f => f.printfile_id === printfileId);
      if (!spec) throw new Error(`No printfile ${printfileId} for placement ${placementKey}`);
      return {
        placement: placementKey,
        image_url: urlsByPlacement[placementKey],
        position: {
          area_width: spec.width,
          area_height: spec.height,
          width: spec.width,
          height: spec.height,
          top: 0,
          left: 0
        }
      };
    });
}

// Splits a placement key or a view title into lowercase words ("outside_front" and
// "Right Front Outside" both yield outside/front), so a view can be matched against the
// placements it depicts without hardcoding Printful's title strings.
function placementWords(text) {
  return String(text).toLowerCase().split(/[^a-z]+/).filter(Boolean);
}

// Drops views of placements we sent no artwork for. v1 returns every camera angle a product has,
// not only the ones the submitted files cover -- so the reversible bucket hat, whose mockup set is
// the two OUTSIDE placements when there is no second design, came back with 8 views of which 4
// showed a blank white hat. v2 never exposed this because we hand-picked two style ids.
//
// The rule is derived rather than hardcoded: take the words of every placement the product HAS but
// we did NOT submit, subtract the words of the ones we did, and drop any view whose title uses a
// remaining word. On the hat that leaves {inside, label} and removes exactly the four blanks; on a
// product where we submit everything, the set is empty and nothing is dropped.
export function hideUnsubmittedViews(views, entries, printfileSpecs) {
  const submitted = new Set(entries.flatMap(([placement]) => placementWords(placement)));
  const all = Object.keys(printfileSpecs?.available_placements || {});
  const submittedKeys = new Set(entries.map(([placement]) => placement));
  const hidden = new Set();
  for (const placement of all) {
    if (submittedKeys.has(placement)) continue;
    for (const word of placementWords(placement)) if (!submitted.has(word)) hidden.add(word);
  }
  if (!hidden.size) return views;
  const kept = views.filter(v => !placementWords(v.display_name).some(w => hidden.has(w)));
  // Never hand back nothing: if the rule somehow matched every view, a blank filmstrip is worse
  // than a wrong-looking one, and the customer still needs something to approve.
  return kept.length ? kept : views;
}
