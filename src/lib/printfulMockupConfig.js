// PRODUCT_MOCKUP_CONFIG lives in its own pure-data module (no imports) so it can be
// consumed both by the app (via lib/printful.js, which re-exports the helpers around it)
// and by plain-Node tooling -- specifically scripts/check-printful-catalog.mjs, the
// scheduled catalog-drift check. printful.js itself can't be imported under plain Node:
// its dependency chain reads `import.meta.env` (lib/supabase.js), which only exists in
// Vite's runtime.
// Confirmed live: every product below is constructed as an all-over cut-and-sew garment
// or panel (printed fabric pieces sewn together), not DTG-on-a-flat-placement, so they all
// use the same Printful "technique" value, and all require a stitch_color product option --
// Printful rejects the task without it even though it's not obviously implied by anything
// in getPrintfileSpecs. GET /products/{id} -> result.product.options lists which values are
// valid (e.g. the tote bag/crossbody bag only accept black/clear, not white), but it is NOT
// a reliable list of which products REQUIRE the option: the windbreaker (615) omits
// stitch_color from v1 entirely while v2 rejects any task without it (see 615's entry).
// There's no generic way to detect "required" from either response, so this is a small
// hand-verified map rather than something derived.
//
// `mockupStyleIds` picks which photographed camera angles come back (GET
// /v2/catalog-products/{id}/mockup-styles lists the options -- each product has dozens:
// Flat Front/Back, Men's/Women's on-model, Lifestyle, Ghost, etc.). Every entry below
// requests the catalog's "Flat Front" + "Flat Back" style pair, confirmed live to return
// two distinct images. Omitting mockup_style_ids entirely makes Printful silently default
// to one single style no matter how many placements are submitted.
//
// `placements` is a DIFFERENT axis: it's which panels of the garment have artwork on them
// *within* a single photo, not how many photos come back. A "Front" style photo of a hoodie
// shows the front torso, hood, both sleeves, and the pocket all at once -- each is its own
// placement, and any placement left out renders as blank/undecorated fabric in that panel
// (confirmed live -- a front+back-only submission left the hood/sleeves/pocket plain white
// in an otherwise-correct front photo). So `placements` here is every placement visible
// from the Front/Back styles requested, not a trimmed-down subset -- the one exception is
// the track jacket (801), where submitting `details` together with the sleeve placements
// confirmed live to fail the whole task outright with an opaque "Internal Server Error"
// (isolated by testing subsets: front+back+sleeves+pocket succeeds, front+back+details
// alone succeeds, but adding sleeves and details together fails every time). Its placement
// list below omits `details` for that reason -- front+back+sleeves+pocket already renders
// every visible panel. Label/inside-label/inside-pocket placements are never included since
// they're not visible in any Front/Back photo. A real print order still needs every
// placement filled in regardless of what's visible in a preview photo -- that's a separate,
// not-yet-built concern (no checkout exists yet) from generating a mockup.
// `colorLabel` / `colorHint` -- override for products where Printful's variant "color" does
// not mean the colour of the garment. Only the windbreaker (615) needs it so far; the tote's
// Black/Red/Yellow really are three differently coloured bags, so it keeps the default
// "Color" and no hint.
// `mirrorPlacements` -- placements rendered horizontally flipped so the pattern continues
// across a garment's visible side seams instead of restarting at each. Set on every product
// with a distinct back panel; see the bucket hat (654) below for the geometry of WHY
// mirroring the back closes BOTH seams rather than just one, and renderArtwork.js for where
// the flip happens. Two facts make this safe across the range, both checked rather than
// assumed (2026-07-25): every one of these products' back print area is centered in its
// template to within 2px of 3000 (0.07%), and a garment's front/back panels are themselves
// symmetric about their own vertical centerline, so a full-canvas mirror maps the panel onto
// itself instead of shifting artwork relative to fabric.
// Deliberately NOT set on three products:
//   274 tote bag -- no distinct 'back' placement at all; one canvas wraps the whole bag.
//   693 mesh shorts and 784 wide-leg joggers -- both DO have a back placement in their
//     printfile mapping, but both are `twoLegCanvas` (see below): each canvas is physically
//     CUT IN HALF into two legs, so front and back don't meet as one cylinder at two side
//     seams. Each leg has its own outseam and inseam, and the simple
//     front's-right-edge-meets-back's-left-edge argument that makes mirroring correct
//     everywhere else does not hold. Would need its own seam analysis before being enabled.
// It's exposed as a per-order customer toggle (ProductPage's "Side seams"), default on.
export const PRODUCT_MOCKUP_CONFIG = {
  257: {
    technique: 'cut-sew',
    productOptions: [{ name: 'stitch_color', value: 'white' }],
    placements: ['default', 'back', 'sleeve_left', 'sleeve_right'],
    mockupStyleIds: [15714, 15715],
    mirrorPlacements: ['back']
  }, // men's t-shirt
  388: {
    technique: 'cut-sew',
    productOptions: [{ name: 'stitch_color', value: 'white' }],
    placements: ['front', 'back', 'sleeve_left', 'sleeve_right', 'hood', 'pocket'],
    mockupStyleIds: [20169, 20170],
    mirrorPlacements: ['back'],

    // The kangaroo pocket's physical region within the FRONT placement's own canvas, as a
    // src->dest region mapping (see renderAndUploadPrintFiles/pocketCrop below for the
    // general mechanism). Every placement on this product shares one 6000x6000 printfile
    // that Printful "covers" each panel template with -- so by default the pocket panel
    // got the same full artwork scaled down onto it, a small echo of the front floating on
    // top of the front (looked bad, user-confirmed). With this set, the pocket placement
    // instead uploads a region of the front canvas, so it visually continues the front
    // artwork behind it. A single region whose `dest` fills the whole output (as here) is
    // the simplest case of the general mechanism -- see the zip hoodie (717) below for a
    // product needing more than one region.
    // The `src` rect is SOLVED, not eyeballed: Printful's mockup-generator templates
    // (printful-catalog?templates=1) are the actual cut-piece sewing patterns with
    // print-area rects, so the pocket piece's side-seam lines (measured in its own
    // template, least-squares fit at 5 rows) and the pocket notch dashed on the front
    // torso template (same lines in front-file coordinates, slopes agreed within ~3%)
    // give a solvable line-to-line mapping; the third constraint anchors the pocket
    // piece's bottom cut edge to the torso piece's hem cut line (both are consumed by the
    // same hem seam). The window falls slightly outside the front file (that's real: the
    // pocket piece is physically wider at the hem than the front print's own bleed there)
    // -- out-of-bounds areas land in cut-away bleed and are edge-clamped by drawRegion,
    // never white. Residual error budget ~0.4in, under the ~1in garment sewing tolerance.
    pocketCrop: {
      regions: [{ src: { x: -0.012, y: 0.155, w: 1.033, h: 1.033 }, dest: { x: 0, y: 0, w: 1, h: 1 } }]
    }
  }, // hoodie
  320: {
    technique: 'cut-sew',
    productOptions: [{ name: 'stitch_color', value: 'white' }],
    placements: ['front', 'back', 'sleeve_left', 'sleeve_right'],
    mockupStyleIds: [18428, 18429],
    mirrorPlacements: ['back']
  }, // sweatshirt
  261: {
    technique: 'cut-sew',
    productOptions: [{ name: 'stitch_color', value: 'white' }],
    placements: ['default', 'back', 'sleeve_left', 'sleeve_right'],
    mockupStyleIds: [15777, 15778],
    mirrorPlacements: ['back']
  }, // women's t-shirt
  274: {
    technique: 'cut-sew',
    productOptions: [{ name: 'stitch_color', value: 'black' }],
    // No separate 'back' placement exists for this product (only 'default' + 'pocket') --
    // the single default printfile wraps the whole bag, so it renders correctly on both
    // the Front and Back styles without needing a second placement. 'pocket' is an inside
    // pocket, not visible in either style, but harmless to include for completeness.
    placements: ['default', 'pocket'],
    mockupStyleIds: [16394, 16395]
  }, // tote bag
  83: {
    technique: 'cut-sew',
    productOptions: [{ name: 'stitch_color', value: 'white' }],
    placements: ['front', 'back'],
    // Unlike every other product, the pillow's Default Front/Back style ids are
    // restricted_to_variants per SIZE (each size is photographed separately), so a single
    // mockupStyleIds pair only works for one variant -- Printful rejects the task for the
    // rest. mockupStyleIdsByVariant (checked first, see resolveMockupStyleIds) maps each
    // catalog variant id to its own Default Front/Back pair, pulled live from
    // GET /v2/catalog-products/83/mockup-styles. mockupStyleIds stays as the 18"x18"
    // fallback for any variant Printful adds later.
    mockupStyleIds: [12675, 12676],
    mirrorPlacements: ['back'],
    mockupStyleIdsByVariant: {
      49853: [31042, 31050], // 14"x14"
      49854: [31049, 31051], // 16"x16"
      4532: [12675, 12676], // 18"x18"
      9513: [12677, 12678], // 20"x12"
      11075: [12673, 12674] // 22"x22"
    }
  }, // pillow
  693: {
    technique: 'cut-sew',
    productOptions: [{ name: 'stitch_color', value: 'white' }],
    // No "Flat Back" style exists in this product's mockup-styles catalog (just Front,
    // on-model, and lifestyle angles) -- front is the only flat preview available.
    placements: ['front'],
    mockupStyleIds: [8603],
    // front AND back (Printful printfile 472, 11250x4350 -- a 2.6:1 ratio) are one flat
    // canvas physically cut into the two legs when sewn. See twoLegCanvas's own comment
    // below (784) for what this flag does.
    twoLegCanvas: true
  }, // mesh shorts
  717: {
    technique: 'cut-sew',
    productOptions: [{ name: 'stitch_color', value: 'white' }],
    placements: ['front', 'back', 'sleeve_left', 'sleeve_right', 'hood', 'pocket'],
    mockupStyleIds: [257, 265],
    mirrorPlacements: ['back'],

    // This product's FRONT is two separate zip panels side by side in one canvas (split
    // by the center zipper), and 'pocket' is two separate welt pockets -- one per panel --
    // combined into ONE placement file, on its OWN printfile (507, 5250x3750 landscape),
    // a DIFFERENT aspect ratio than the front's (506, 5250x6000 portrait).
    // ONE region fills the entire output canvas (dest {0,0,1,1}) -- confirmed across
    // several real mockups to be the only structure that's ever defect-free here. Any
    // attempt at a smaller/precisely-positioned dest (matching individual welt pockets,
    // or a sub-rect read off a calibration grid) reliably produced a visible hard seam:
    // whatever area falls outside a partial dest still gets covered by a differently-
    // scaled fallback layer, and that mismatch is what shows as a seam -- there is no
    // known layout for this product where a sub-rect dest doesn't hit this. With dest at
    // 100%, there's no separate fallback area to ever show through, whatever portion the
    // mockup pipeline itself later crops away is simply invisible, same as it would be
    // for any upload.
    // w=1, h=0.625 (=outH/srcH exactly, 3750/6000, both files 5250 wide) is a 1:1
    // physical-pixel crop with zero overhang -- deliberately not adjusted, since overhang
    // beyond a few percent produces its own defect (edge-clamp strips stretched into
    // visible flat-color bars). y is the only tuned value: calibrated against a series of
    // real mockups (increasing y visibly shifts the design "up", decreasing shifts "down")
    // and landed at 0.36 -- close enough that the difference vs. a real print run is
    // expected to matter more than further precision here.
    pocketCrop: {
      regions: [{ src: { x: 0, y: 0.36, w: 1, h: 0.625 }, dest: { x: 0, y: 0, w: 1, h: 1 } }]
    }
  }, // zip hoodie
  784: {
    technique: 'cut-sew',
    productOptions: [{ name: 'stitch_color', value: 'white' }],
    placements: ['front', 'back'],
    mockupStyleIds: [22595, 22596],
    // front/back printfile is 9750x8100 (1.2:1) -- milder than the shorts' 2.6:1, but the
    // same physical situation: one flat canvas cut into two legs. See twoLegCanvas.
    twoLegCanvas: true
  }, // wide-leg joggers
  801: {
    technique: 'cut-sew',
    productOptions: [{ name: 'stitch_color', value: 'white' }],
    // 'details' omitted -- confirmed live to fail the task when combined with the sleeve
    // placements (see comment above). This set already covers every visible panel.
    placements: ['front', 'back', 'sleeve_left', 'sleeve_right', 'pocket'],
    mockupStyleIds: [23286, 23287],
    mirrorPlacements: ['back']
    // No pocketCrop here, deliberately: checked this product's 'pocket' placement against
    // its mockup-generator templates (printful-catalog?id=801&templates=1, template
    // 494610) and it's the INSIDE pocket bag lining -- never visible on the worn or
    // photographed garment (same non-issue as the tote/crossbody bag's 'pocket'). There's
    // no echo-of-the-front problem to fix because nobody ever sees this placement.
  }, // track jacket
  744: {
    technique: 'cut-sew',
    productOptions: [{ name: 'stitch_color', value: 'black' }],
    placements: ['front', 'back', 'pocket', 'details'],
    mockupStyleIds: [21376, 21377],
    mirrorPlacements: ['back']
  }, // crossbody bag
  615: {
    technique: 'cut-sew',
    // This product's two variant COLOURS (Black/White) are not two jackets. Verified against
    // Printful's own per-variant photos: both are the identical white jacket, and the only
    // difference is the zipper tape and seam stitching. That is why v1 omits the
    // stitch_color option here (below) -- the choice already exists in the variant
    // dimension -- and it makes "Color" an actively misleading label, since the fabric is
    // white either way and fully covered by the customer's artwork regardless.
    colorLabel: 'Stitching',
    colorHint: 'Both options are the same white jacket — this picks the zipper and seam stitching color.',
    // v1 GET /products/615 does NOT list stitch_color in result.product.options at all --
    // but v2 mockup-tasks rejects the task outright without it ("The required product
    // option: `stitch_color` is missing"), and v2 GET /catalog-products/615 DOES list it
    // (white/clear/black). Confirmed live both ways, 2026-07-25. Two consequences:
    // getStitchColorOption reads the v1 list, so this product shows no stitch-color picker
    // and silently uses the value below (the pre-picker behavior every product had, so it
    // degrades cleanly rather than breaking); and check-printful-catalog.mjs has to fall
    // back to the v2 option list for it -- see that script's option check.
    productOptions: [{ name: 'stitch_color', value: 'white' }],
    // hood_inner and facing are also real placements on this product, deliberately left out
    // here: they're the hood lining and the inner zip placket, neither visible in a Flat
    // Front/Back photo (same treatment as the sweatshirt's interior panels). A real order
    // still fills them -- resolvePlacementEntries runs unfiltered at checkout.
    placements: ['front', 'back', 'sleeve_left', 'sleeve_right', 'hood'],
    mockupStyleIds: [3963, 3972],
    mirrorPlacements: ['back']
  }, // windbreaker
  390: {
    technique: 'cut-sew',
    productOptions: [{ name: 'stitch_color', value: 'white' }],
    // 'details' is INCLUDED here, unlike the track jacket (801) where combining it with the
    // sleeve placements fails the whole task -- verified live on this product that the same
    // combination completes fine (2026-07-25). It's also load-bearing rather than optional:
    // a front/back/sleeves-only submission renders the ribbed waistband and both pocket
    // welts as blank white fabric, a wide unprinted band across the bottom of an otherwise
    // fully-printed jacket (compared byte-for-byte against the with-details mockup of the
    // same variant). 801 has that same gap in its preview today and can't close it for as
    // long as Printful rejects the combination there.
    placements: ['front', 'back', 'sleeve_left', 'sleeve_right', 'details'],
    mockupStyleIds: [3033, 3034],
    mirrorPlacements: ['back']
  }, // bomber jacket
  654: {
    technique: 'cut-sew',
    productOptions: [{ name: 'stitch_color', value: 'white' }],
    // Reversible: outside_front/outside_back and inside_front/inside_back are four
    // separately printed panels, and the customer wears either face out. But NO mockup
    // style photographs the inside -- this product's catalog lists "Front Inside"/"Back
    // Inside" styles (4900/4865) that come back BYTE-IDENTICAL to their Outside
    // counterparts (4863/4864), verified by md5 on a real 4-style task; and submitting only
    // the outside placements produces byte-identical photos to submitting all four, so the
    // inside placements contribute nothing to any preview. So the mockup set is the two
    // outside placements only (including the inside ones would just burn renders, and the
    // duplicate style ids would show the customer the same photo twice -- useMockup dedupes
    // by style_id, which can't catch two ids serving one image). The inside panels are
    // still really printed: checkout submits every placement unfiltered.
    placements: ['outside_front', 'outside_back'],
    mockupStyleIds: [4863, 4864],
    // The printed-but-unphotographed inside panels above are exactly why this override
    // exists -- see getGeometryPlacementOptions in printful.js.
    geometryPlacementKeys: ['outside_front', 'outside_back', 'inside_front', 'inside_back'],
    // Each face's printfile carries TWO cut pieces -- half the crown side-wall and half the
    // brim -- so front and back meet at the two side seams Printful's own template labels
    // "Visible seams". Both halves otherwise render the identical image (they share printfile
    // 410, one cache entry), so the composition restarts at each seam; confirmed on a real
    // side-view mockup (style 4899), where the pattern plainly breaks down the middle of the
    // crown and again across the brim.
    // Mirroring the BACK half closes BOTH seams from one render, which is the non-obvious
    // part: going around the crown, the front's right edge meets the back's left edge, and a
    // mirrored back's left edge IS the front's right edge -- then continuing round, the
    // mirrored back's right edge is the front's left edge, exactly what the other seam leads
    // into. The flip is safe against these cut pieces because both sit near-centered in the
    // 3000x3000 template (crown x~137-600, brim x~70-655, center 364), so a full-canvas
    // mirror maps each piece essentially onto itself, reversed.
    // The result is bilaterally symmetric, NOT an endless wrap -- endless wrap would need a
    // horizontally tileable composition, which this generator can't produce, so mirroring is
    // the only fix available that closes both seams at once. That's a taste call, hence the
    // customer-facing toggle in ProductPage (default on).
    mirrorPlacements: ['outside_back', 'inside_back'],
    // The garment is reversible, so printing one design on both faces wastes the format --
    // ProductPage offers an optional SECOND design for the inside placements (see
    // getSecondaryDesignConfig and renderAndUploadPrintFiles' secondaryDesign param).
    // Optional by design: with none picked, both faces render from the one design exactly as
    // every other product does, and the shared printfile (410) means it stays a single render.
    // The label placements deliberately aren't listed -- the mark is branding, not artwork,
    // and splitting it across two designs would add a render for something nobody reads as
    // belonging to one face. Note the customer can never SEE this choice on the product: no
    // mockup style photographs the inside (see the placements comment above), so the UI has
    // to say so rather than implying the preview covers it.
    secondaryDesign: {
      placements: ['inside_front', 'inside_back'],
      primaryLabel: 'Outside',
      label: 'Inside',
      // Rendered under the picker, verbatim.
      note: "Printful can't photograph the inside of this hat, so a second design won't show up in the preview above — you'll first see it on the hat itself."
    }
  } // reversible bucket hat
};

