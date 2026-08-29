// Decides which camera angles a mockup asks Printful for, and in what order they are shown.
//
// WHY THIS EXISTS (2026-08-29, Aaron: "it's weird how some products have just a flat front and
// back and some have a wide range of angles ... so inconsistent"). Under v2 we hand-picked a style
// id per product; the v1 migration dropped that, deliberately, because those ids were a
// per-product AND per-variant maintenance burden that had already broken every pillow size but
// 18x18. The price was that v1 picks its own default subset, and that default varies wildly:
// measured across the catalogue, the zip hoodie and track jacket returned 2 views while the beanie
// returned 10 -- not because Printful has fewer photos of a zip hoodie (it has ten style GROUPS)
// but because nobody was choosing.
//
// So this chooses, and the choice is DERIVED FROM EACH PRODUCT'S OWN STYLE LIST rather than
// hardcoded per product. That distinction is the whole design: a hardcoded list is exactly what
// `placements` was, and it silently drifted out of date at the v1 migration until it was costing
// customers the mesh shorts' entire back panel and a visible 3in label patch they were buying
// unseen. A rule that reads the catalogue cannot drift; it can only be wrong the same way for
// everyone, which is findable.
//
// THE TARGET IS CONSISTENCY, NOT ABUNDANCE. "Take everything available" fixes the scarcity and
// leaves the inconsistency: products would still return 2 to 10, just larger. A fixed shape --
// the garment flat, the garment worn, the garment's detail -- reads the same on every product
// page, which is what a filmstrip is for. It also caps a real cost: real mockups measure 154KB
// each, so ten views is ~1.5MB of images on a phone against ~750KB for six.

// The rule is EXCLUDE-THEN-RANK, not a whitelist, and that is deliberate. A whitelist of
// "good" group names is the same shape as the old `placements` list: it silently drops anything it
// has not heard of, and it drifts the moment Printful renames or adds one. A first draft here was a
// whitelist and the dry run caught it immediately -- it matched NOTHING on the pillow (whose groups
// are Default/Person/Lifestyle, with no "Flat") and cut the tote from three views to one, because
// non-apparel products use a different vocabulary (Default, Standing, On Hanger, In Hand) than
// garments do. Dropping is the dangerous direction; an unrecognised group is now KEPT, ranked last.

// Groups never requested, with the reason -- so "why is this missing?" is answerable here rather
// than through a Printful round trip:
//   Lifestyle*/Flat Lifestyle/Couple's/Duet/Boy's/Girl's -- staged scenes. They photograph a mood,
//     often showing a sliver of the garment at an angle that says nothing about the buyer's own
//     artwork, which is the only thing this filmstrip exists to show.
//     NOT `Person`, which was grouped here at first and is different (Aaron, 2026-08-29). It is
//     someone holding the product, and on the pillow -- the only product that has the group, and the
//     only one with no on-model group at all -- it is the one human-scale reference available. A
//     pillow is unusually hard to judge for size against a plain background, with no body to read it
//     against, and 18in vs 22in is exactly what a buyer is unsure about. It is ranked below the real
//     product shots, so on any future product that has both it can only appear once the budget is
//     not already filled by better groups.
//   Halloween/Holiday season/Spring-summer vibes -- seasonal. They would date the product page and
//     change under us without warning.
//   Product specs -- NOT photographs. On the track jacket (801) these are size-chart cards rendered
//     in English/French/German/Italian/Japanese/Spanish, six near-identical documents.
const EXCLUDED_GROUP = /lifestyle|halloween|holiday|vibes|couple|duet|boy's|girl's|product specs/i;

// Preference order among what survives. Anything unlisted sorts after these but is still eligible,
// which is what keeps a product like the tote (Default / On Hanger / Standing / In Hand) working
// without naming its vocabulary here.
const GROUP_RANK = [
  /^flat$/i,      // the canonical product shot, garments
  /^default$/i,   // the same thing, non-apparel vocabulary
  // On-model, capped at one (see ON_MODEL). Men's is listed first only so the pick is DETERMINISTIC
  // rather than falling out of whatever order Printful happens to return -- an earlier draft picked
  // whichever came first and gave five products a women's shot and eight a men's, for no reason. A
  // product with only one of them (261, the women's tee) is unaffected either way.
  /^men's$/i,
  /^women's$/i,
  /^ghost$/i,     // garment shape, no model
  // Above the hanger/standing shots: a fabric close-up tells a buyer more about how their own
  // artwork prints than a photograph of the garment hanging up does, and the group budget below
  // fills before both can be had.
  /^product details$/i,
  /^standing$/i, /^on hanger$/i, /^in hand$/i,
  // Last of the ranked groups: real, but it is a scale reference rather than a look at the artwork.
  /^person$/i
];

// At most one ON-MODEL group. A unisex all-over-print garment photographed on a male and a female
// model is very nearly the same picture -- same artwork, marginally different drape -- so requesting
// both spends a filmstrip slot and ~154KB (measured over 28 real mockups) to say nothing. Whichever
// the product lists first wins, so the choice is the catalogue's rather than ours.
const ON_MODEL = /^(men's|women's)$/i;

// Printful numbers repeats of the same set -- "Men's", "Men's 2", "Men's 3", "Flat 2". These are
// MORE SHOTS OF THE SAME THING, not different things, and treating them as distinct groups defeats
// the one-on-model rule outright: the dry run had the beanie requesting Men's, Men's 2 AND Men's 3.
// Collapse to the base name and keep the unnumbered one, which sorts first.
function baseGroup(name) {
  return String(name).replace(/\s+\d+$/, '').trim();
}

function groupRank(name) {
  const i = GROUP_RANK.findIndex(re => re.test(baseGroup(name)));
  return i === -1 ? GROUP_RANK.length : i;
}

export const MAX_VIEWS = 6;

// Bump whenever this file's choices change, or the Edge Function's response normalisation does.
// useMockup persists finished previews in localStorage against a cache key that otherwise describes
// only the ORDER (product, variant, design, print options) -- so without this a browser holding a
// preview from before a policy change replays it forever, with the old view set and, worse, with no
// option_group on its entries, which makes orderViews silently fall back to sorting by angle alone.
// That is exactly how it surfaced: a filmstrip that still jumped between image types after the fix
// had shipped, on a page whose cached copy predated it.
export const VIEW_POLICY_VERSION = 5;

// Which option_groups to send with a v1 mockup task, given the group names this product actually
// has (from /v2/catalog-products/{id}/mockup-styles). Returns [] when nothing matches, which the
// caller must treat as "send no option_groups and take v1's default" -- an empty list would
// otherwise ask for nothing at all and return a filmstrip with no photos.
export function chooseOptionGroups(availableGroups, maxGroups = 4) {
  const ranked = [...new Set(availableGroups)]
    .filter(g => g && !EXCLUDED_GROUP.test(g))
    .map((g, i) => ({ g, i, base: baseGroup(g), r: groupRank(g) }))
    // Unnumbered before numbered within a base, so "Men's" wins over "Men's 2".
    .sort((a, b) => a.r - b.r || a.g.length - b.g.length || a.i - b.i);
  const chosen = [];
  const seenBase = new Set();
  let tookOnModel = false;
  for (const { g, base } of ranked) {
    if (seenBase.has(base)) continue;
    if (ON_MODEL.test(base)) {
      if (tookOnModel) continue;
      tookOnModel = true;
    }
    seenBase.add(base);
    chosen.push(g);
    if (chosen.length >= maxGroups) break;
  }
  return chosen;
}

// Canonical display order for the views that come back, so every product's filmstrip reads the
// same way: the garment front-on, then its three-quarters, then its back, then its detail. Printful's
// own titles are inconsistent in case and wording, so this matches on words rather than equality.
const VIEW_ORDER = [
  /^front$/i, /^front\b/i, /^left front/i, /^right front/i,
  /^left$/i, /^right$/i,
  /^back$/i, /^back\b/i, /^left back/i, /^right back/i,
  /^top$/i, /^inside/i, /detail/i
];

export function viewRank(title) {
  const i = VIEW_ORDER.findIndex(re => re.test(String(title || '')));
  // Anything unrecognised sorts after everything known rather than first, so a title Printful
  // adds later cannot displace the front of the strip.
  return i === -1 ? VIEW_ORDER.length : i;
}

// Rank of the STYLE GROUP a photo came from, for ordering the filmstrip. A view with no group is a
// placement's own default shot -- v1 returns those as the primary `mockup_url` and puts
// `option_group` only on the `extra` entries -- and it sorts LAST, after every group including an
// unrecognised one.
//
// It used to sort first, on the reasoning that a placement's default is the canonical product shot.
// That was wrong in a way only a real filmstrip shows (Aaron, 2026-08-29, on the men's t-shirt and
// then on every product): Printful chooses that default itself, so its TYPE is arbitrary and
// unknowable from the response. A model shot therefore led the strip, the Flat group followed, and
// the rest of the model shots came after it -- model, flat, flat, model, model, model, which reads
// as no order at all. And because a product submits one per camera-visible placement, that is up to
// five type-arbitrary photos ahead of the first grouped one, which is why the symptom was general
// rather than particular to one product.
//
// Sorting them last costs nothing: they are near-duplicates of angles the requested groups already
// supply, so on a product with a full set they fall past MAX_VIEWS and simply do not appear. On a
// product where `chooseOptionGroups` matched nothing, EVERY view is ungrouped, they all tie here,
// and the order is by angle exactly as before.
export function viewGroupRank(group) {
  if (!group) return GROUP_RANK.length + 1;
  return groupRank(group);
}

// Orders and caps a normalised view list: BY TYPE FIRST, then by angle within the type.
//
// It used to round-robin by angle, to stop one angle filling the strip -- the track jacket came back
// as "Front, Back, Back 2, Back 3, Back 4, Product details 2", four photographs of the same side.
// That fixed the flooding and introduced a worse problem (Aaron, 2026-08-29: "it seems to jump back
// and forth between image types"): alternating by angle necessarily alternates between a flat lay, a
// model shot and a ghost shot, so the strip never settles.
//
// Grouping by type fixes both at once, which is why the round-robin is gone rather than layered
// with. Flooding was only ever possible ACROSS groups -- each group supplies at most a couple of
// angles of its own -- so ordering by group and taking them in rank order cannot repeat an angle
// several times before showing anything else. The strip now reads: the garment flat (front, back),
// then worn, then ghosted, then its detail.
// At most half the strip from any ONE group, so a group with a lot of views cannot crowd out every
// other type. Measured across all 18 products: the beanie's Flat group has SIX views and the bucket
// hat's has EIGHT, so both filled the entire strip with flat lays and showed no on-model shot at all
// -- while fourteen other products led flat and then went to a model. Capping at half fixes exactly
// that without costing anything: no product loses a view (every one that showed six still shows six,
// and the short ones -- pillow, bandana, women's tee, pants -- are limited by what Printful has, not
// by this), and eight products trade a fourth near-identical model shot for a ghost, a detail or an
// on-hanger view. A cap of 2 was measured too and is worse: it drops the beanie, gaiter, women's tee
// and pants to four views.
//
// It scales with `max` rather than being a constant because the reversible bucket hat asks for
// double when a genuinely different second design is in play, and its inside faces come back inside
// the SAME groups as its outside ones -- a fixed cap would trim precisely the views that choice
// exists to show.
// A back view is worth much less than its slot suggests, because on every product carrying
// `mirrorPlacements` the back print DEFAULTS to a mirror of the front -- so a second and third one
// are near-copies of pictures already in the strip (Aaron, 2026-08-29: "not that it gets you much to
// see a reverse of the front"). Measured across the catalogue, backs took 23 of 99 slots, and the
// zip hoodie and track jacket spent HALF their strip on them -- Flat Back, Men's Back and Ghost
// Right Back -- while their detail shots never appeared at all.
//
// One is kept, never zero: a customer must be able to see the panel they are paying for, which is
// the whole lesson of the mesh shorts shipping for months with no back view at all.
const BACK_VIEW = /\bback\b/i;
const MAX_BACK_VIEWS = 1;

export function orderViews(views, max = MAX_VIEWS) {
  const perGroup = Math.max(1, Math.ceil(max / 2));
  const ranked = views
    .map((v, i) => ({ v, i, g: viewGroupRank(v.option_group), r: viewRank(v.display_name) }))
    .sort((a, b) => a.g - b.g || a.r - b.r || a.i - b.i);

  // Both caps DEMOTE rather than drop: an over-quota view goes to the back of the queue and still
  // fills a slot nothing better wants. That is what keeps the short products whole -- the pillow,
  // bandana, women's tee and pants are limited by what Printful has, and a hard filter would take
  // views away from exactly the products that can least afford it.
  const taken = new Map();
  let backs = 0;
  const preferred = [];
  const spare = [];
  for (const x of ranked) {
    const used = taken.get(x.g) ?? 0;
    const isBack = BACK_VIEW.test(String(x.v.display_name ?? ''));
    if (used >= perGroup || (isBack && backs >= MAX_BACK_VIEWS)) {
      spare.push(x);
      continue;
    }
    taken.set(x.g, used + 1);
    if (isBack) backs += 1;
    preferred.push(x);
  }

  // Re-sorted after the cut, so whatever survives is still in strict type-then-angle order and a
  // backfilled view cannot land out of sequence at the tail.
  return [...preferred, ...spare]
    .slice(0, max)
    .sort((a, b) => a.g - b.g || a.r - b.r || a.i - b.i)
    .map(x => x.v);
}
