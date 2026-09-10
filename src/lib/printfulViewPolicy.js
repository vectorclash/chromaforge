// Namespace import on purpose: a named import of a key the generated file happens not to carry is a
// hard module error, which would take the whole bundle down over a half-written table. This way a
// missing map degrades to "no product is classifiable", which is a filmstrip that looks like it did
// before the on-model tier existed rather than a blank site.
import * as styleTable from './printfulMockupStyleGroups.js';

const MOCKUP_STYLE_GROUPS = styleTable.MOCKUP_STYLE_GROUPS ?? {};
const MODEL_GROUPS_BY_PRODUCT = styleTable.MODEL_GROUPS_BY_PRODUCT ?? {};
const PER_VARIANT_MOCKUP_PRODUCTS = new Set(styleTable.PER_VARIANT_MOCKUP_PRODUCTS ?? []);

// Decides which camera angles a mockup asks Printful for, and in what order they are shown.
//
// WHAT CAME BEFORE, so nobody rebuilds the dead end. This file once requested up to four groups
// (Flat + an on-model group + Ghost + Product details) and then tried to ORDER a mixed bag by
// inference. That failed repeatedly, and the reason is structural rather than a want of a better
// heuristic:
//
//   Ask Printful for SEVERAL groups in one task and it returns each placement's photo as an
//   untyped `mockup_url` primary, with `option_group` present only on the `extra` entries. So the
//   most important photos -- the front, the back -- arrive with NO indication of what they show.
//   Re-measured 2026-09-07 and still true; also measured, the REQUEST ORDER IS NOT A LEVER:
//   ["Flat","Product details","Men's"] and ["Men's","Flat","Product details"] give byte-identical
//   assignment on the sweatshirt (Men's and Product details untyped, Flat tagged). Printful has its
//   own fixed notion of which style owns a placement's primary. Four ordering heuristics were tried
//   against real responses and every one left some product jumping between flat lays and model
//   shots -- inferring "the group missing this angle" handed every primary to Product details, and
//   matching the catalog's own view names fails wherever Printful's vocabulary differs from ours.
//
// WHAT UNLOCKED IT (2026-09-07). Every photo, primary and extra alike, carries a
// `generator_mockup_id`, and that id is STABLE across tasks -- so a one-off pass asking for ONE
// group at a time learns exactly the classification a combined task refuses to state. That table is
// src/lib/printfulMockupStyleGroups.js (see scripts/build-mockup-style-groups.mjs for how it is
// built and why it is a cache of Printful's own catalogue rather than something derivable). With it
// a single task carries flats, detail shots and on-model shots and every photo is placed exactly,
// with no inference and no second task -- Printful's create limit is 10/60s shared store-wide, so a
// second task per preview would have permanently halved peak preview throughput.
//
// Filenames are NOT a substitute and were checked: the flat back and the on-model back are both
// `...-white-back-<hash>.jpg`.
//
// Both ways this can degrade are safe, and that is deliberate: a product with no table entry is
// never asked for its model group at all (so it keeps exactly the two-group strip it has today),
// and an id the table does not know sorts LAST. Neither can reorder the flats at the head of the
// strip.

// THE SHAPE, and it is still deliberately narrow (Aaron, 2026-08-29: "let's just do the flats, and
// details if available. keep it simple"). Every product asks for the same three TIERS -- the garment
// flat, its detail shots, and one on-model group -- so a filmstrip reads identically across the shop
// and nothing is derived from how a given product happens to be photographed. Each tier contributes
// AT MOST ONE group: the patterns inside a tier are a preference order, not a list to collect.
//
// `Default` is the non-apparel vocabulary for `Flat` (the pillow and tote use it). The model tier
// needs several patterns because no single name covers the catalogue: 14 of 18 products publish
// `Men's`, the women's t-shirt `Women's`, the pillow `Person` and the tote `Standing`/`In Hand`.
// Everything else a product publishes -- ghost, on-hanger, seasonal, size-chart cards -- is
// deliberately not requested.
//
// LIFESTYLE groups are otherwise deliberately absent from the pattern list -- "Lifestyle 1" reads
// as a numbered repeat to the unnumbered-only rule below, so nothing here would pick one up on its
// own. The bandana (630) is the one exception, via MODEL_GROUP_OVERRIDES: its three Lifestyle
// styles were rejected sight-unseen when the product was added ("knotted in hair or on a bag
// handle, a twisted sliver of the artwork"), and reviewing real photos of all three in 2026-09-08's
// roster overturned that -- Lifestyle 2 is a real on-model shot worth showing.
const FLAT_GROUPS = [/^flat$/i, /^default$/i];
const DETAIL_GROUPS = [/^product details$/i];
const MODEL_GROUPS = [/^men's$/i, /^women's$/i, /^person$/i, /^standing$/i, /^in hand$/i];

// Which SPECIFIC model group a product's on-model tier uses, when it isn't the first-alphabetical
// match the pattern order above would pick. 2026-09-08: every candidate group Printful publishes
// per product (98 of them, incl. numbered repeats -- "Men's 2", "Men's 3"...) was pulled as a real
// photo into a comparison roster and Aaron picked one per product by looking at the actual model,
// not just the first name that happened to match. A numbered group is NOT "more of the same photo
// shoot" here the way it is for FLAT_GROUPS/DETAIL_GROUPS (that assumption is real for a garment
// lying flat, photographed twice -- it does not hold for a person, who is a different photo shoot
// each time), so this deliberately bypasses `pickGroup`'s unnumbered-only rule.
export const MODEL_GROUP_OVERRIDES = {
  257: "Men's 5",
  261: "Women's 3",
  320: "Men's 3",
  420: "Men's 2",
  458: "Men's 2",
  604: "Women's",
  630: "Lifestyle 2",
  654: "Women's"
};

// Whether this product's mockup photos are per-VARIANT, so one variant's preview must never be
// shown for another. Everything else shares a photo across sizes, which is what useMockup's cache
// key assumes -- see there for why that assumption is right for a garment and wrong here.
//
// The set is the catalogue's own `restricted_to_variants` products, swept by
// scripts/build-mockup-style-groups.mjs. Two of eighteen: the pillow (83) and the bandana (630).
// Deriving it rather than listing it here is what makes a product Printful later re-photographs
// per size pick this up on the next build instead of silently keeping a stale preview.
//
// FOUND VIA THE BANDANA (2026-09-09, Aaron: the third photo is "sometimes the man I chose, and
// sometimes a cute dog"). Its three sizes all print from printfile 380, so every key component
// matched and all three shared one cached preview -- whichever size was selected when the preview
// was first generated decided the whole filmstrip, and later size changes silently reused it. The
// photos genuinely differ: measured, the flat lay is shot TO SCALE and the bandana fills 37% of the
// frame at S against 80.7% at L, and "Lifestyle 2" is a different shoot per size (a French bulldog
// at S, a man at M and L). So someone picking L was shown the S bandana at under half its size.
//
// The pillow was never affected and is in the set for correctness rather than as a fix: its five
// sizes each have their OWN printfile, so the key's placement signature already separated them. The
// bandana is the only product where the mockup varies by size and nothing in the key said so.
export function mockupVariesByVariant(productId) {
  return PER_VARIANT_MOCKUP_PRODUCTS.has(String(productId));
}

// Printful numbers repeats of the same set -- "Flat 2", "Product details 2". Those are more shots of
// the same thing, so only the unnumbered group is asked for; its own extra views still come back.
function baseGroup(name) {
  return String(name).replace(/\s+\d+$/, '').trim();
}

// The cap on how many photos a filmstrip carries. Raised from 6 to 8 when the on-model tier landed:
// the track jacket alone needs exactly 8 (2 flat + 4 detail + 2 model) and would otherwise have had
// its model shots trimmed off the end by the very cap meant to keep the strip short. Not raised
// further because ProductPage preloads every thumbnail at full mockup size (~154KB) before the strip
// appears, so each extra view is paid for in wait, on a phone, before anything is shown.
export const MAX_VIEWS = 8;

// Bump whenever this file's choices change, or the Edge Function's response normalisation does.
// useMockup persists finished previews in localStorage against a cache key that otherwise describes
// only the ORDER (product, variant, design, print options), so without this a browser holding a
// preview from before a policy change replays it for 12 hours.
export const VIEW_POLICY_VERSION = 15;

// The first group a product actually has for each pattern in `patterns`, or null.
function pickGroup(availableGroups, patterns) {
  for (const pattern of patterns) {
    for (const group of availableGroups ?? []) {
      if (!group || !pattern.test(baseGroup(group))) continue;
      // Only the unnumbered form, so "Flat" is asked for and "Flat 2" is not.
      if (baseGroup(group) !== String(group).trim()) continue;
      return group;
    }
  }
  return null;
}

// The model group for one product: the exact override above when the catalog actually carries it,
// otherwise the ordinary first-match pattern pick. Falling back (rather than erroring) is what keeps
// this safe if Printful ever renames or drops a chosen group -- the product quietly reverts to the
// old default instead of losing its model tier outright.
function pickModelGroup(availableGroups, productId) {
  const override = MODEL_GROUP_OVERRIDES[Number(productId)];
  if (override && (availableGroups ?? []).includes(override)) return override;
  return pickGroup(availableGroups, MODEL_GROUPS);
}

// Every group this policy would ever request for a product, ignoring whether it can be classified.
// Used by scripts/build-mockup-style-groups.mjs, which is the thing that MAKES a product
// classifiable -- so it must not be gated on the table it is about to write.
export function catalogGroupsFor(availableGroups, productId) {
  return [
    pickGroup(availableGroups, FLAT_GROUPS),
    pickGroup(availableGroups, DETAIL_GROUPS),
    pickModelGroup(availableGroups, productId)
  ].filter(Boolean);
}

// Which option_groups to send with a v1 mockup task, given the group names this product actually
// has (from /v2/catalog-products/{id}/mockup-styles). Returns [] when nothing matches, which the
// caller must treat as "send no option_groups and take v1's default" -- an empty list would
// otherwise ask for nothing at all and return a filmstrip with no photos.
//
// The MODEL group is only requested for a product whose model views this build can actually
// classify. Asking for it without them would return on-model photos as untyped primaries
// indistinguishable from the flats -- precisely the mixed bag that made this approach fail before --
// so an unclassifiable product silently keeps the two-group filmstrip it has today rather than
// getting a scrambled one. The gate is MODEL_GROUPS_BY_PRODUCT rather than "is this product in the
// table at all", because those are different facts: the pillow's `Person` styles are restricted to
// variants the table build could not reach, so it has flat ids and no model ones.
export function chooseOptionGroups(availableGroups, productId) {
  const chosen = [
    pickGroup(availableGroups, FLAT_GROUPS),
    pickGroup(availableGroups, DETAIL_GROUPS)
  ];
  if (MODEL_GROUPS_BY_PRODUCT[String(productId)]) chosen.push(pickModelGroup(availableGroups, productId));
  return [...new Set(chosen.filter(Boolean))];
}

// The style group a photo belongs to. `option_group` is Printful's own answer and is trusted when
// present -- it is only ever absent on a placement's primary, which is exactly what the style table
// exists to classify. Null means neither could say, which ranks the photo last rather than guessing.
export function resolveViewGroup(productId, view) {
  if (view?.option_group) return view.option_group;
  const id = view?.generator_mockup_id;
  return (id && MOCKUP_STYLE_GROUPS[String(productId)]?.[String(id)]) || null;
}

// A per-product view-name correction used to live here (`VIEW_NAME_FIXUPS`, swapping Front and Back
// on the track jacket, 801). It is GONE, and its cause is fixed rather than patched: the placement
// key a photo arrives under is not a statement about what the photo shows, and the Edge Function now
// names a primary from the style table -- Printful's own filename -- instead. The fixup existed
// because 801's `front` placement returns the garment's back; measured 2026-09-07, the same fault
// silently affected the joggers (784) and the crossbody (744) too, where two different flats both
// arrived on a placement labelled "Front" and one was shown as "Front 2". Naming from the table
// fixes all three at once, so a hand-maintained per-product swap has nothing left to do. If a
// product ever needs one again, the honest fix is almost certainly a missing table entry.

// Angle order within a group. Front first, then the back, then the rest as Printful names them.
// Anything unrecognised sorts after everything known rather than first, so a view title Printful
// adds later cannot displace the front of the strip.
const VIEW_ORDER = [/^front/i, /^back/i, /^left/i, /^right/i];

export function viewRank(title) {
  const i = VIEW_ORDER.findIndex(re => re.test(String(title || '')));
  return i === -1 ? VIEW_ORDER.length : i;
}

// Rank of the style group a photo came from: the flats lead, then the detail shots, then the
// on-model shots. Anything unrecognised -- a group this policy never asked for, or a photo whose
// group neither Printful nor the style table could name -- sorts LAST, so a style Printful adds
// later lands at the end of the strip and can never displace the front of it.
export function viewGroupRank(group) {
  if (!group) return 3;
  const base = baseGroup(group);
  if (FLAT_GROUPS.some(re => re.test(base))) return 0;
  if (DETAIL_GROUPS.some(re => re.test(base))) return 1;
  if (MODEL_GROUPS.some(re => re.test(base))) return 2;
  return 3;
}

// The rank of one normalised view, and the ONE place that decides what an unnameable photo means.
//
// "No group" has two completely different causes and they need opposite answers:
//
//   - The response could not have been classified AT ALL -- an Edge Function older than the style
//     table, which returns no `generator_mockup_id` for anything, or a product the table does not
//     cover (which is therefore never asked for on-model shots either). Then untyped means what it
//     meant before any of this existed: a placement's own primary, i.e. a FLAT. Rank it first.
//   - The photo carried an id and the table did not know it. That is real drift, the strip has a
//     photo nobody can place, and last is where it belongs.
//
// Getting this wrong is not theoretical: ranking the first case last put the track jacket's four
// detail shots ahead of its two flats on a frontend running against the not-yet-deployed function
// (Aaron, live: "the two flats are no longer first as they need to be"). Deploying the function
// first is still required -- this only makes failing to do it benign instead of scrambling.
function rankView(productId, view) {
  const group = resolveViewGroup(productId, view);
  if (group) return viewGroupRank(group);
  const classifiable = !!view?.generator_mockup_id && !!MOCKUP_STYLE_GROUPS[String(productId)];
  return classifiable ? viewGroupRank(null) : 0;
}

// Orders and caps a normalised view list: the flats first in angle order, then the detail shots,
// then the on-model shots. `productId` lets an untyped primary be classified through the style
// table; see rankView for what happens when nothing can name a photo.
export function orderViews(views, max = MAX_VIEWS, productId) {
  return views
    .map((v, i) => ({ v, i, g: rankView(productId, v), r: viewRank(v.display_name) }))
    .sort((a, b) => a.g - b.g || a.r - b.r || a.i - b.i)
    .slice(0, max)
    .map(x => x.v);
}
