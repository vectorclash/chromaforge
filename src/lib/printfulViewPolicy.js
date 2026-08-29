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
//   Lifestyle*/Flat Lifestyle/Person/Couple's/Duet/Boy's/Girl's -- staged scenes. They photograph a
//     mood, often showing a sliver of the garment at an angle that says nothing about the buyer's
//     own artwork, which is the only thing this filmstrip exists to show.
//   Halloween/Holiday season/Spring-summer vibes -- seasonal. They would date the product page and
//     change under us without warning.
//   Product specs -- NOT photographs. On the track jacket (801) these are size-chart cards rendered
//     in English/French/German/Italian/Japanese/Spanish, six near-identical documents.
const EXCLUDED_GROUP = /lifestyle|halloween|holiday|vibes|couple|duet|person|boy's|girl's|product specs/i;

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
  /^standing$/i, /^on hanger$/i, /^in hand$/i
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

// Orders and caps a normalised view list.
//
// Ordering alone is not enough, and the first version proved it: the track jacket came back as
// "Front, Back, Back 2, Back 3, Back 4, Product details 2" -- four photographs of the same side and
// one of the front. Asking for several style groups means several groups each supply their own back
// shot (flat, on-model, ghost), and the normaliser suffixes the collisions, so a rank-only sort
// happily fills the strip with one angle.
//
// So this ROUND-ROBINS by base view name: one of each distinct angle in rank order, then the
// seconds. A buyer scanning a filmstrip wants front, back, a three-quarter and a detail -- variety
// of angle beats a second opinion on the same angle -- and `perBase` stops any one angle taking
// more than its share even when the cap leaves room.
export function orderViews(views, max = MAX_VIEWS, perBase = 2) {
  const bases = new Map();
  views.forEach((v, i) => {
    // Digits can sit anywhere in Printful's titles, not just at the end -- the bucket hat returns
    // "Front Outside", "Front 2 Outside", "Right Front Outside". Stripping only a trailing number
    // left those as three distinct bases and filled the strip with fronts. Remove any standalone
    // number so repeats of one angle collapse wherever the numbering lands.
    const base = String(v.display_name || '').replace(/\b\d+\b/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!bases.has(base)) bases.set(base, { r: viewRank(v.display_name), i, items: [] });
    bases.get(base).items.push(v);
  });
  const ranked = [...bases.values()].sort((a, b) => a.r - b.r || a.i - b.i);
  const out = [];
  for (let round = 0; round < perBase && out.length < max; round++) {
    for (const b of ranked) {
      if (out.length >= max) break;
      if (b.items[round]) out.push(b.items[round]);
    }
  }
  return out;
}
