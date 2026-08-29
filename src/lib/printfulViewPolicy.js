// Decides which camera angles a mockup asks Printful for, and in what order they are shown.
//
// THE SHAPE, and why it is this simple (Aaron, 2026-08-29: "let's just do the flats, and details if
// available. keep it simple"). Every product asks for the SAME two style groups -- the garment flat,
// and its detail shots -- so a filmstrip reads identically across the shop. Nothing is derived from
// how a product happens to be photographed, so nothing can drift product to product.
//
// WHAT CAME BEFORE, so nobody rebuilds it. This file previously requested up to four groups
// (Flat + an on-model group + Ghost + Product details) and then tried to ORDER a mixed bag. That
// failed repeatedly and the reason is structural, not a matter of a better heuristic:
//
//   Ask Printful for SEVERAL groups in one task and it returns each placement's photo as an
//   untyped `mockup_url` primary, with `option_group` present only on the `extra` entries. So the
//   most important photos -- the front, the back -- arrive with NO indication of what they show,
//   and there is no reliable way to recover it. Measured on real tasks: inferring "the group that
//   is missing this angle" handed every primary to Product details, because Product details lacks
//   every angle by definition; the track jacket's entire strip came back labelled as detail shots.
//   Matching against the catalog's own view names does better but still fails wherever Printful's
//   vocabulary differs from ours ("Right Front" vs "Right"). Four ordering rules were tried against
//   real responses; all of them left some product jumping between flat lays and model shots.
//
//   Ask for ONE group and the ambiguity does not exist: there are no `extra` entries at all, every
//   photo comes back as a placement primary, and every one belongs to the group that was asked for.
//   Measured: the sweatshirt returns 2 photos for `Flat` (front, back) and 4 for `Men's` (front,
//   back, both sleeves) -- clean either way.
//
// Asking for Flat plus Product details keeps that property in the one combination that matters: the
// flats come back as primaries and the details as extras, so the two are still told apart with no
// inference (verified on the sweatshirt and the track jacket). Showing model shots as well would
// mean a SECOND task per preview, which is a real cost -- Printful's create limit is 10/60s shared
// store-wide -- and is the thing to reach for if the shop ever wants them back.

// The two groups requested, in the order they are shown. `Default` is the non-apparel vocabulary for
// `Flat` (the pillow and tote use it); a product carrying neither simply gets no flat group, which
// is Printful's answer, not ours. Everything else a product publishes -- on-model, ghost, on-hanger,
// lifestyle, seasonal, size-chart cards -- is deliberately not requested.
const REQUESTED_GROUPS = [/^flat$/i, /^default$/i, /^product details$/i];

// Printful numbers repeats of the same set -- "Flat 2", "Product details 2". Those are more shots of
// the same thing, so only the unnumbered group is asked for; its own extra views still come back.
function baseGroup(name) {
  return String(name).replace(/\s+\d+$/, '').trim();
}

export const MAX_VIEWS = 6;

// Bump whenever this file's choices change, or the Edge Function's response normalisation does.
// useMockup persists finished previews in localStorage against a cache key that otherwise describes
// only the ORDER (product, variant, design, print options), so without this a browser holding a
// preview from before a policy change replays it for 12 hours.
export const VIEW_POLICY_VERSION = 9;

// Which option_groups to send with a v1 mockup task, given the group names this product actually
// has (from /v2/catalog-products/{id}/mockup-styles). Returns [] when nothing matches, which the
// caller must treat as "send no option_groups and take v1's default" -- an empty list would
// otherwise ask for nothing at all and return a filmstrip with no photos.
export function chooseOptionGroups(availableGroups) {
  const seen = new Set();
  const chosen = [];
  for (const pattern of REQUESTED_GROUPS) {
    for (const group of availableGroups ?? []) {
      if (!group || seen.has(group) || !pattern.test(baseGroup(group))) continue;
      // Only the unnumbered form, so "Flat" is asked for and "Flat 2" is not.
      if (baseGroup(group) !== String(group).trim()) continue;
      seen.add(group);
      chosen.push(group);
      break;
    }
  }
  return chosen;
}

// Angle order within a group. Front first, then the back, then the rest as Printful names them.
// Anything unrecognised sorts after everything known rather than first, so a view title Printful
// adds later cannot displace the front of the strip.
const VIEW_ORDER = [/^front/i, /^back/i, /^left/i, /^right/i];

export function viewRank(title) {
  const i = VIEW_ORDER.findIndex(re => re.test(String(title || '')));
  return i === -1 ? VIEW_ORDER.length : i;
}

// Rank of the style group a photo came from. A photo with no group is a placement's own primary --
// which, given only Flat and Product details are ever requested, is a flat lay. It ranks with the
// flats, which is where it belongs and is now simply true rather than inferred.
export function viewGroupRank(group) {
  if (!group) return 0;
  return /^product details$/i.test(baseGroup(group)) ? 1 : 0;
}

// Orders and caps a normalised view list: the flats first in angle order, then the detail shots.
export function orderViews(views, max = MAX_VIEWS) {
  return views
    .map((v, i) => ({ v, i, g: viewGroupRank(v.option_group), r: viewRank(v.display_name) }))
    .sort((a, b) => a.g - b.g || a.r - b.r || a.i - b.i)
    .slice(0, max)
    .map(x => x.v);
}
