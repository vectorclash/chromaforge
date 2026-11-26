import tinycolor from 'tinycolor2';
import { randomColorHex } from '../../render/prng';
import {
  getSizeScale,
  getElementSizeScale,
  getFrameSizeScale,
  REFERENCE_ELEMENT_SIZE_SCALE
} from '../../render/scale';
import { getGeometrySettings } from '../../render/designSettings';

// How much further than the original generator the top of the Spread slider reaches. Set by
// eye from rendered sheets at the real studio resolution, not from the arithmetic -- see
// CLAUDE.md's `spread` bullet for what each candidate looked like.
const SPREAD_MAX_GAIN = 3;

// Mosaic grid helpers: a cell is keyed by its three integer lattice vertices, sorted, so a
// cell reached by turning another is found by the same key.
function cellKey(v) {
  return v.map(([a, b]) => `${a},${b}`).sort().join('|');
}
// The three cells sharing an edge with this one: each is this cell's edge plus the vertex
// mirrored across it (p + q - r for edge p-q and opposite vertex r).
function cellNeighbours(v) {
  const out = [];
  for (let i = 0; i < 3; i++) {
    const p = v[i], q = v[(i + 1) % 3], o = v[(i + 2) % 3];
    out.push(cellKey([p, q, [p[0] + q[0] - o[0], p[1] + q[1] - o[1]]]));
  }
  return out;
}

// The shorter arc of circle (c, r) from p to q, as a shape path op (render/shapePath.js).
function shortArc(c, r, p, q) {
  const a0 = Math.atan2(p[1] - c[1], p[0] - c[0]);
  let d = Math.atan2(q[1] - c[1], q[0] - c[0]) - a0;
  while (d <= -Math.PI) d += Math.PI * 2;
  while (d > Math.PI) d -= Math.PI * 2;
  return ['A', c[0], c[1], r, a0, a0 + d, d < 0];
}

// How hard the lattice Scale range leans toward its top (see buildLattice). 1 would be
// uniform across the range; below 1 pushes designs toward scaleMax.
const SCALE_SKEW = 0.3;

// Mosaic, Flower and Golden decide everything on ONE fixed area around the centre, in units of
// the frame's short edge -- never the canvas's own width and height -- so a design is the same
// figure on every product and each canvas only crops it, as the Lattice style always was
// (2026-11-20, Aaron: Mosaic "placing geometry in very different places at different sizes",
// some products with geometry and others none). They used to list only the grid cells inside
// this canvas and pick cluster seeds from that list, so a different canvas shape meant a
// different list and the clusters grew somewhere else; measured on his design, the shapes in
// the area every canvas shows matched the studio's 3% on the tee front, 4% on the phone case.
//   STYLE_DOMAIN -- radius of the area a style builds on: past the corners of every canvas it
//                   is drawn on (the shorts' leg-panel frame ~2.1, the phone case at Small ~2.4).
//   STYLE_CORE   -- where cluster seeds start and what the shape budget is counted against: a
//                   disc with the studio canvas's area (16:9 is 1.78 short edges squared), so the
//                   studio keeps the amount of geometry it was tuned with.
const STYLE_DOMAIN = 2.5;
const STYLE_CORE = 0.75;
//   STYLE_RING   -- how far out a symmetric cluster after the first may start (Mosaic, Flower):
//                   about the corners of the studio's 16:9 frame (1.02 short edges), so at full
//                   Symmetry the figure's rings can reach the whole artwork. Its six turns land
//                   on one ring, so it stays one figure about the centre on every product.
const STYLE_RING = 1;

export default class GenerateGeometricShape {
  constructor(
    width,
    height,
    shapeNum,
    colors = [],
    rng = Math.random,
    settings = null,
    geometryLayout = null,
    sizeFrame = null,
    // Per-order render context, like sizeFrame -- never part of a design. A plain multiplier on
    // the finished shape size, so it scales THIS layer only (the stars and radial blobs keep
    // their own size) and consumes no rng(). 1 is exact in IEEE754, so the default is
    // byte-identical. Used by products small enough that the full studio scale buries the
    // geometry -- see PRODUCT_MOCKUP_CONFIG's geometryScaleOptions.
    geometryScale = 1,
    // The lattice model's own random stream (`${seed}-lattice`, made by generateArtwork). Every
    // draw that model makes after the three it shares with the classic generator comes from
    // here, so moving one of its sliders can never shift a layer generated after this one.
    // Callers without a seed (the 3D flight's per-plate configs) leave it out; they then draw
    // from their own `rng`, which is already a stream of its own there.
    latticeRng = null
  ) {
    const geometry = getGeometrySettings(settings);

    let config = {
      width: width,
      height: height,
      shapes: []
    };
    // Passed straight through to GeometricShape.js's renderer -- see its own comment for
    // what 'single'/'mirror' do. Not consumed here at all (no rng() draws depend on it),
    // so it can't desync the settings-dependent rng() consumption invariant the rest of
    // this generator relies on.
    if (geometryLayout) config.legLayout = geometryLayout;

    this.rng = rng;
    this.colors = colors;

    this.shapeVertices =
      geometry.pointsMin + Math.round(rng() * (geometry.pointsMax - geometry.pointsMin));

    // The lattice model (2026-11-20): a separate path rather than a branch inside the classic
    // one below, which every saved design still renders through untouched. See buildLattice.
    if (geometry.model === 'lattice') {
      // Returns the config object, like the end of this constructor (see the note there).
      return this.buildLattice(config, width, height, shapeNum, geometry, sizeFrame, geometryScale, latticeRng || rng);
    }
    // Ring count (shapeDepth): 2-6 at coherence 0 (unchanged from before coherence existed --
    // chaotic triangles hide the ring structure, so more rings never looked odd there), reined
    // in to 2-4 at full coherence, where every ring is a fully visible band and 5-6 of them
    // packed inside the fixed coherentSize clearance below reads as too busy/thin. Interpolated
    // linearly so partial coherence isn't a hard cutoff. Still exactly one rng() draw regardless
    // of coherence, preserving the "settings-dependent rng() consumption is size-independent"
    // invariant the rest of this generator depends on.
    // The min rises too (2 -> 3 at full coherence): with the vector-equilibrium chord
    // cells (see latticeCells), depth 2 has only one ring pair to splay between and reads
    // washed-out/soft rather than as the nested web -- confirmed against real renders at
    // 6 vertices (36 cells vs. depth 3's 72). Threshold deliberately isn't the slider's
    // exact midpoint: `2 + Math.round(coherence)` (the original formula) flips at exactly
    // 0.5 with no ramp -- an extra ring (and the cell-count jump that comes with it, since
    // cell count grows with ring-pair count) landing at exactly the halfway point directly
    // fed the "50% looks like 100%" complaint alongside the cellKeep fix below. Moved to
    // 0.85 -- close enough to full coherence to still avoid the washed-out depth-2 look
    // there, but out of the 0-0.7 range where cellKeep's own ramp is doing the real work.
    const maxShapeDepth = 6 - Math.round(2 * geometry.coherence);
    const minShapeDepth = 2 + (geometry.coherence >= 0.85 ? 1 : 0);
    this.shapeDepth = minShapeDepth + Math.round(rng() * (maxShapeDepth - minShapeDepth));
    this.shapeAng = 360 / this.shapeVertices;
    // Orientation-independent (see render/scale.js's getElementSizeScale) -- chaotic shapes
    // have no containment requirement (unlike coherentSize below), so there's no reason to
    // anchor their size to the short axis only, which was making them relatively bigger on
    // near-square/portrait canvases than on wide ones.
    //
    // The minimum term is a FRACTION of the size scale, not an absolute pixel count. It used
    // to read `150 + ...`, described as "an intentional absolute minimum (avoids degenerate
    // near-zero shapes at tiny sizes)". The intent was fine; a fixed pixel value was the wrong
    // mechanism, and it was a real bug (v8 -> v9, 2026-07-29, found by Aaron comparing a
    // Printful order preview against the live product page): this formula is otherwise fully
    // resolution-relative, so an absolute term makes a render's composition depend on the
    // pixel size it happens to be rendered at. Mockup previews render through
    // capMockupRenderSize while print files render at true printfile dimensions, so previews
    // systematically showed LARGER shapes than the print they were previewing -- on the mesh
    // shorts, whose 11250px sheet is capped to 2000px (a 5.6x ratio, the largest in the
    // catalogue), the first shape spanned 37.6% of the sheet in the preview against 22.9% in
    // the print, +65%. That also explains those mockups reading washed-out pastel: oversized
    // translucent shapes stack toward white. A relative floor is scale-invariant, so a small
    // canvas now gets proportionally small shapes -- which is what "the same composition at any
    // size" means, and is not degenerate.
    // 150/2160 is chosen to reproduce the old value EXACTLY at the studio's own default
    // resolution, so the canvas people actually design on does not move at all; every other
    // size is what shifts. The two terms are rounded SEPARATELY, matching the old
    // `150 + Math.round(...)` exactly rather than rounding their sum -- rounding the sum would
    // differ by up to 1px at the reference and give up that guarantee for nothing.
    // Consumes the same single rng() draw, so no downstream layer shifts.
    const CHAOTIC_MIN_FRACTION = 150 / REFERENCE_ELEMENT_SIZE_SCALE;
    const chaoticSizeScale = getElementSizeScale(width, height, sizeFrame);
    // `spread` (see designSettings.js) controls how big the chaotic shapes are, through TWO
    // terms on the slider's upper half: a SKEW of this draw's distribution, and a raised
    // CEILING. They do different jobs and it needs both -- the skew is what makes small shapes
    // rare (a plain multiplier would make giants and dwarves equally more likely), and the
    // ceiling is what lets the biggest designs get bigger at all.
    //
    // The draw stays uniform; the exponent bends it. An exponent below 1 is concave, so it
    // pushes a uniform variate toward the top of its range -- at spread 1 (exponent 0.3) the
    // bottom quarter of the range is drawn ~1% of the time against 25% for a flat draw, and
    // the 10th-percentile design ends up as large as the flat draw's AVERAGE one. Above 1 it
    // does the opposite, so the slider's lower half is a genuine "keep them small" setting
    // rather than dead travel.
    //
    // Deliberately piecewise-linear about 0.5 with exponent exactly 1 there, the same trick
    // `size` uses above and for the same reason: 0.5 has to reproduce the original generator
    // BYTE-for-byte (Math.pow(u, 1) returns u exactly), because that is what every design
    // saved before this key existed resolves to. A single straight line across [0, 1] could
    // not put 1.0 at the midpoint without dictating both endpoints.
    //
    // The upper half also raises the CEILING, on a second, steeper line -- exactly the shape
    // `size` uses below, and for the same reason it was given one (Aaron, 2026-09-17: "I
    // constantly change the settings to make the geometry go as large as it can. It can
    // definitely go much larger"). Skew alone could only redistribute designs inside the old
    // range; it could not make the biggest one bigger, which is the half of the slider he
    // actually lives at.
    //
    // The knee is at 0.5 -- the DNA default and the byte-identity point -- NOT at the studio
    // default. Tying it to the studio default would weld a generator constant to a number
    // documented as free to move, and moving that number would then silently reshape the
    // whole curve.
    const spreadAbove = Math.max(0, geometry.spread - 0.5) / 0.5;
    const spreadExponent = geometry.spread <= 0.5 ? 3 - 4 * geometry.spread : 1 - 0.7 * spreadAbove;
    // 1x at 0.5 (exactly -- multiplying by 1 is exact in IEEE754, so the default stays
    // byte-identical) up to SPREAD_MAX_GAIN at 1.
    const spreadAmplitude = 1 + (SPREAD_MAX_GAIN - 1) * spreadAbove;
    // Exactly one rng() draw, in the same position as before -- the skew is arithmetic on the
    // value, never a second draw -- so every layer generated after this one is unmoved. The
    // two terms stay rounded SEPARATELY for the reason given above.
    const chaoticSizeDraw = Math.pow(rng(), spreadExponent);
    const chaoticSize =
      Math.round(chaoticSizeScale * CHAOTIC_MIN_FRACTION) +
      Math.round((chaoticSizeDraw * chaoticSizeScale * spreadAmplitude) / 3);
    // At full coherence the lattice radius (shapeSize * shapeDepth, drawn from the canvas
    // centre) is user-controlled via geometry.size: 0.15 * sizeScale (fairly small, ~30%
    // of the short dimension's half) at size=0, up through 0.375 * sizeScale (the original
    // fixed factor, fitting with the original 12.5% margin) at size=0.5, the default --
    // deliberately piecewise-linear rather than one straight line across the whole [0, 1]
    // range, since a single line pins its midpoint at exactly (low+high)/2, and 0.375 is
    // already load-bearing as the exact midpoint of the ORIGINAL [0.15, 0.6] range (so
    // pre-existing designs, which have no `size` field and fall back to the 0.5 default,
    // keep rendering byte-identical). Raising the high end (Aaron's call, 2026-07-06: the
    // old 0.6 ceiling "should be much higher") without breaking that invariant meant
    // extending only the size>0.5 half onto a steeper second line, up to 1.8 * sizeScale at
    // size=1 (3x the old 0.6 ceiling -- a dramatic overflow, most of the polygon extending
    // well past the canvas edge). Deliberately keeps using getSizeScale (min(w,h)), not
    // getElementSizeScale -- containment/overflow amount should key off the short axis, not
    // the orientation-independent element scale, so a non-square canvas doesn't bleed
    // differently depending on which axis is short.
    // In between coherence 0 and 1, interpolate -- the chaotic size can be far larger than
    // the canvas (that off-screen bleed IS the chaos), so raising coherence steadily reins
    // it in AND, as a side effect of this same lerp, steadily hands control to the size
    // setting -- at coherence 0 shapeSize collapses to exactly chaoticSize regardless of
    // size (0 * anything = 0), so the size slider has no effect until coherence rises,
    // matching the "the higher the coherence, the more accurate/controllable" request.
    // Pure arithmetic on the single depth draw above; no rng() consumption depends on
    // coherence or size.
    const sizeFactor =
      geometry.size <= 0.5
        ? 0.15 + geometry.size * 0.45
        : 0.375 + (geometry.size - 0.5) * 2.85;
    const coherentSize = (getFrameSizeScale(width, height, sizeFrame) * sizeFactor) / this.shapeDepth;
    this.shapeSize = (chaoticSize + (coherentSize - chaoticSize) * geometry.coherence) * geometryScale;

    this.points = this.pointsArray(this.shapeSize);

    // shapeNum (from generateArtwork.js) is unscaled -- this loop always builds the full,
    // size-independent count (each buildShape() call's rng() consumption doesn't depend on
    // width/height, only on this.colors.length, which is fixed per design).
    for (let i = 0; i < shapeNum; i++) {
      config.shapes.push(this.buildShape());
    }
    // REAL bug, found via a live customer order (2026-07-20): this used to slice the kept
    // count by getCountScale(width, height), same as GenerateStarField/
    // GenerateLargeRadialField -- but for geometry specifically that meant a mockup preview
    // (rendered client-side capped at RENDER_CAP=2000, see lib/printful.js) could keep a
    // visibly smaller SUBSET of these shapes than the real, uncapped print render at true
    // printfile resolution -- not a smaller picture of the same composition, a genuinely
    // different one (confirmed live: the same seed rendered at a mockup's capped size vs.
    // its print's real size was missing entire shapes, including one that dominated the
    // print's center). The coherent lattice-cell path below already exempts itself from
    // getCountScale for exactly this reason ("a thumbnail must show the same complete shape
    // as a print") -- this makes the chaotic-shape path match that same standard, since the
    // business requirement is that geometry must render as identically as possible across
    // resolutions, even though stars/gradients are allowed to vary. Safe to do without
    // affecting the rng()-consumption invariant: buildShape() already runs shapeNum times
    // unconditionally above regardless of size, so this only changes how much of that
    // already-generated, size-independent result gets kept, not what gets drawn from rng().
    //
    // `density` (see designSettings.js) is the deliberate, studio-controlled version of the
    // slice this bug fix removed. Critically it is NOT a function of width/height, so it
    // can't reintroduce the mockup/print divergence above -- every placement of a given
    // design keeps the same shapes regardless of its printfile size. Default 1 keeps all of
    // them, exactly as this line did before the setting existed.
    let keepCount = Math.max(1, Math.round(shapeNum * geometry.density));
    // Coherence trades these chaotic random triangles away for ordered lattice cells
    // (below): at 1, none survive -- only the clean polygon remains. Applied as a min()
    // against whatever density already allowed, so the two compose rather than override:
    // high coherence still wins (it must reach 0 survivors at 1) and low density can only
    // ever remove more, never add back.
    if (geometry.coherence > 0) {
      keepCount = Math.min(keepCount, Math.round(shapeNum * (1 - geometry.coherence)));
    }
    config.shapes = config.shapes.slice(0, keepCount);

    if (geometry.coherence > 0) {
      // The recognizable-shape half of coherence: fill the lattice's actual cells (the
      // triangles that tessellate the regular polygon) instead of arbitrary 3-point
      // triangles. A `coherence` fraction of all cells is drawn, shuffled so a partial
      // fill scatters organically rather than always growing from the centre; at 1 that's
      // every cell -- a perfect fully-filled polygon. Deliberately NOT sliced by
      // getCountScale: the filled polygon is the design itself, so a thumbnail must show
      // the same complete shape as a print (cell count tops out at 12 vertices x depth 6 =
      // 132 triangles, trivial at any size). All rng() consumed here (the shuffle + each
      // cell's colors) depends only on vertex/depth/coherence -- size-independent, so the
      // cross-size determinism guarantee holds.
      const cells = this.latticeCells();
      this.shuffle(cells);
      // A straight `cells.length * coherence` (the original formula) undersold how fast
      // this fills visually: the cells overlap heavily by design (see latticeCells'
      // comment on hard-light blending), so a modest fraction of them already covers most
      // of the polygon's area -- confirmed by measuring actual painted-pixel density
      // inside the shape's own footprint at each coherence step (a scratch
      // render-service/spike-coherence.js harness, not committed): the linear formula hit
      // ~80% visual density by coherence 0.1-0.3 and never moved much past that the rest
      // of the way to 1 (Aaron's report: "at 50% it feels like it's almost 100%"). Raising
      // this to an exponent backs off cellKeep hard at low coherence and lets it catch up
      // near the top, which measured out much closer to a linear density ramp (~50% density
      // at 0.3, ~80% at 0.7, ~83% -- the format's actual ceiling -- only at 1). 2.5 was the
      // best fit tried (1.5/2/3 also tested); not a formula with special meaning, just the
      // exponent that matched real measured density best.
      const cellKeep = Math.round(cells.length * Math.pow(geometry.coherence, 2.5));
      // The shuffle above only decides WHICH cells survive a partial fill (scattered, not
      // center-out). Draw order is deterministic: cells reaching the outer rings render
      // first (behind) and cells connecting toward the centre render last (on top) --
      // with shuffled order, a big outer chord panel drawn late would sit over the inner
      // web and swallow its edges (user-reported: points looked disconnected). Sort by
      // outermost vertex radius descending, then innermost ascending-depth (a splay
      // triangle reaching further inward layers above that same ring's own star
      // triangles). Pure arithmetic on already-selected cells: no rng(), so consumption
      // and the cross-size determinism guarantee are untouched. Keys are quantized to
      // integer RING indices, not raw radii: pointsArray rounds coordinates to pixels, so
      // two vertices nominally on the same ring have slightly different raw radii, and
      // that rounding noise varies with canvas size -- raw-radius keys could order two
      // same-ring cells differently at different sizes, desyncing which rng() colors each
      // cell gets between a mockup and its print. Ring-index keys make every intended tie
      // exact; ties fall back to the shuffled order, which is itself size-independent.
      const ringOf = p => Math.round(Math.sqrt(p[0] * p[0] + p[1] * p[1]) / this.shapeSize);
      const maxRing = c => Math.max(ringOf(c[0]), ringOf(c[1]), ringOf(c[2]));
      const minRing = c => Math.min(ringOf(c[0]), ringOf(c[1]), ringOf(c[2]));
      const kept = cells.slice(0, cellKeep);
      kept.sort((a, b) => maxRing(b) - maxRing(a) || minRing(b) - minRing(a));
      for (let i = 0; i < kept.length; i++) {
        config.shapes.push(this.buildShape(kept[i]));
      }
    }

    // Every Generate* class returns its config object from the constructor rather than an
    // instance. tsc objects (a constructor's return must be assignable to the instance type),
    // but this is the pattern the whole render pipeline is built on and rewriting it would
    // touch code where any behavioural change rewrites saved artwork. Suppressed, not fixed.
    // @ts-expect-error -- constructor deliberately returns a config object, not an instance.
    return config;
  }

  // Point triples (literal [x,y] coordinates, not indices) of the coherent structure's
  // cells: a "vector equilibrium" web of long chords, not a disjoint tessellation. Two
  // families, both spanning the figure vertex-to-vertex:
  //   1. Per ring, every "star" chord triangle (k, k+skip, k+2*skip) for every skip up to
  //      V/2 -- this traces the complete chord graph of each ring (same edge set as all
  //      C(V,3) triangles, verified by wireframe comparison, at V*floor(V/2) cells per
  //      ring instead of C(V,3), which matters at V=12 where C(V,3)=220).
  //   2. Between every PAIR of rings (not just adjacent), for each outer-ring vertex k and
  //      each skip j, the symmetric splay triangle (outer k, inner k+j, inner k-j) -- the
  //      long chords fanning from each vertex down into every nested ring.
  // This replaced an earlier disjoint fan/band tessellation (center fan + each ring-band
  // quad fanned from its own centroid) that filled the polygon completely but read as a
  // faceted gemstone; the user wanted the classic vector-equilibrium look (nested rings
  // with every vertex chord-connected across the whole figure), reference-matched via
  // rendered wireframes before landing. Cells now overlap heavily by design --
  // GeometricShape.js fills with 'hard-light' compositing, so overlaps blend rather than
  // occlude. Derives points-per-ring from the array itself rather than assuming
  // shapeVertices iterations, so a floating-point wobble in pointsArray's `ang < 360`
  // accumulation could never desync the indexing. No rng() here: cell geometry/count
  // depends only on vertices/depth -- size-independent, preserving cross-size determinism.
  latticeCells() {
    const perRing = (this.points.length - 1) / this.shapeDepth;
    const idx = (ring, k) => 1 + (ring - 1) * perRing + (((k % perRing) + perRing) % perRing);
    // floor((V-1)/2), NOT floor(V/2): for even V, skip = V/2 makes the star triangle's
    // third point wrap onto its first ((k, k+V/2, k+V) = (k, k+V/2, k)) and the splay
    // triangle's two inner points coincide (k+V/2 == k-V/2 mod V) -- zero-area cells that
    // render as nothing but still consume color rng() and partial-coherence slots.
    const maxSkip = Math.floor((perRing - 1) / 2);
    const cells = [];
    for (let ring = 1; ring <= this.shapeDepth; ring++) {
      for (let skip = 1; skip <= maxSkip; skip++) {
        for (let k = 0; k < perRing; k++) {
          cells.push([
            this.points[idx(ring, k)],
            this.points[idx(ring, k + skip)],
            this.points[idx(ring, k + 2 * skip)]
          ]);
        }
      }
    }
    for (let outer = 2; outer <= this.shapeDepth; outer++) {
      for (let inner = 1; inner < outer; inner++) {
        for (let k = 0; k < perRing; k++) {
          for (let j = 1; j <= maxSkip; j++) {
            cells.push([
              this.points[idx(outer, k)],
              this.points[idx(inner, k + j)],
              this.points[idx(inner, k - j)]
            ]);
          }
        }
      }
    }
    return cells;
  }

  // THE LATTICE MODEL (2026-11-20, Aaron). Everything is drawn from the ring lattice -- rings of
  // `Sides` evenly spaced points around a centre, the structure that builds Metatron's cube and,
  // fully connected, the vector equilibrium. Two kinds of shape share it:
  //   - free picks: triangles of three lattice points, kept only if well proportioned and not
  //     tiny ("clean picks" -- no needles, no specks);
  //   - families: one lattice cell together with every turn of it around the figure, so a
  //     partial fill is still symmetric. All families together are the full web -- exactly the
  //     cells classic full coherence draws.
  // The controls map onto it directly: Sides (pointsMin/Max), Rings (ringsMin/Max), Scale (how
  // far the figure reaches), Shapes (density: how many are drawn) and Symmetry (coherence: how
  // many free picks are traded for families). None of them changes another's meaning, which is
  // what the classic path could not offer (Size and Spread each live at one end of Coherence).
  //
  // Random draws: the SHARED stream gives exactly three -- sides (already taken), rings, and a
  // per-design size nudge -- the same three slots the classic generator takes first. Everything
  // else comes from `side`, so dragging any slider here leaves every later layer of the design
  // (overlay, blends) exactly where it was.
  //
  // Size independence: every decision -- which triangle is clean enough, which family is kept,
  // draw order -- is made on the lattice in RING-SPACING units (`unit`), never on rounded pixel
  // coordinates, so a mockup and its print choose identical shapes.
  buildLattice(config, width, height, shapeNum, g, sizeFrame, geometryScale, side) {
    const shared = this.rng;
    const ringsLo = Math.min(g.ringsMin, g.ringsMax);
    const ringsHi = Math.max(g.ringsMin, g.ringsMax);
    this.shapeDepth = ringsLo + Math.round(shared() * (ringsHi - ringsLo));
    this.shapeAng = 360 / this.shapeVertices;
    const nudge = shared();

    // Scale: the figure's outer radius as a multiple of half the frame's short edge, 0.5x at 0
    // to 4x at 1 on a log curve (each step looks like the same amount bigger). The setting is a
    // RANGE and each design takes its own place in it from `nudge`, skewed toward the top
    // (u^SCALE_SKEW, concave) so the default range lands mostly large -- the same trick as the
    // classic Spread. A pinned range (min = max) is that exact size on every design.
    const lo = Math.min(g.scaleMin, g.scaleMax);
    const hi = Math.max(g.scaleMin, g.scaleMax);
    const scale = lo + (hi - lo) * Math.pow(nudge, SCALE_SKEW);
    const reach = 0.5 * Math.pow(8, scale) * geometryScale;
    const half = getFrameSizeScale(width, height, sizeFrame) / 2;
    // Mosaic style: the same three shared draws are already taken, so switching style moves
    // no later layer. See buildMosaic.
    if (g.style === 'mosaic' || g.style === 'flower' || g.style === 'golden') {
      this.rng = side;
      const short = half * 2 * geometryScale;
      if (g.style === 'mosaic') config.shapes = this.buildMosaic(width, height, scale, short, g);
      else if (g.style === 'flower') config.shapes = this.buildFlower(width, height, scale, short, g);
      else config.shapes = this.buildGolden(width, height, scale, short, g);
      return config;
    }
    this.shapeSize = (half * reach) / this.shapeDepth;
    this.points = this.pointsArray(this.shapeSize);
    this.unit = this.pointsArray(1, false);
    this.rng = side;

    const perRing = (this.points.length - 1) / this.shapeDepth;
    const ringOf = i => (i === 0 ? 0 : 1 + Math.floor((i - 1) / perRing));

    // Free picks. A triangle must cover at least 3% of the frame's short edge squared (the
    // area that read well in the lab), but never more than 6% of the lattice's own footprint
    // asks, so a small figure can still be built from its own points.
    const halfInUnits = this.shapeDepth / reach;
    const minArea = Math.min(0.12 * halfInUnits * halfInUnits, 0.06 * this.shapeDepth * this.shapeDepth);
    const freeCount = Math.round(shapeNum * g.density * (1 - g.coherence));
    const free = [];
    for (let i = 0; i < freeCount; i++) {
      const order = this.between(0, this.points.length - 1);
      const tri = this.cleanTriple(order, minArea);
      free.push(this.buildShape(tri.map(k => this.points[k])));
    }

    // Families, chosen whole. Fewer at low Symmetry on a gentle curve, all of them at the top;
    // Shapes thins them too, so a partial web at full Symmetry is still symmetric.
    let cells = [];
    if (g.coherence > 0) {
      const orbits = this.latticeOrbits();
      this.shuffle(orbits);
      const keep = Math.max(1, Math.round(orbits.length * Math.pow(g.coherence, 1.5) * g.density));
      cells = orbits.slice(0, keep).flat();
      // Same order as classic full coherence: cells reaching the outer rings behind, cells
      // reaching toward the centre on top. Stable sort, so ties keep the shuffled order.
      const maxRing = c => Math.max(ringOf(c[0]), ringOf(c[1]), ringOf(c[2]));
      const minRing = c => Math.min(ringOf(c[0]), ringOf(c[1]), ringOf(c[2]));
      cells.sort((a, b) => maxRing(b) - maxRing(a) || minRing(b) - minRing(a));
    }

    config.shapes = free.concat(cells.map(c => this.buildShape(c.map(k => this.points[k]))));
    return config;
  }

  // MOSAIC STYLE (2026-11-20, Aaron; from the 11/19 lab's "isometric mosaic"). An equilateral
  // triangle grid at two scales -- coarse cells, and a fine grid a third their size whose
  // vertices include every coarse vertex -- each filled by clusters grown cell to cell from a
  // few seed cells. Coarse is drawn first, fine on top.
  //   Scale    -> coarse cell side, 0.08x the frame's short edge at 0 to ~0.5x at 1.
  //   Shapes   -> how much of each grid the clusters fill.
  //   Symmetry -> the chance each cluster is copied into all six turns about the centre (the
  //               grid maps onto itself every 60 degrees about the vertex at the canvas centre),
  //               so the top of the slider is a six-fold snowflake.
  // Every decision is made on integer grid coordinates, never pixels, so a mockup and its print
  // grow the identical clusters. All draws here come from the lattice stream.
  buildMosaic(width, height, scale, short, g) {
    const r = this.rng;
    const coarse = short * 0.08 * Math.pow(6, scale);
    const turned = r() < 0.5; // grid orientation: a point or a flat side toward the top
    const shapes = [];
    const layers = [
      { side: coarse, fill: (0.2 + r() * 0.2) * g.density },
      { side: Math.max(coarse / 3, short * 0.04), fill: (0.1 + r() * 0.1) * g.density }
    ];
    for (const layer of layers) {
      const cells = this.isoCells((STYLE_DOMAIN * short) / layer.side + 1);
      // A six-fold cluster starts within 0.35 of the short edge of the centre, so its turns
      // gather into one figure on screen instead of landing off the sides of a wide canvas.
      const near = (short * 0.35) / layer.side;
      const core = (short * STYLE_CORE) / layer.side;
      const ring = (short * STYLE_RING) / layer.side;
      const chosen = this.growClusters(cells, layer.fill, 2 + Math.floor(r() * 3), g.coherence, near, core, ring);
      for (const cell of chosen) shapes.push(this.buildShape(this.isoPoints(cell.v, layer.side, turned)));
    }
    return shapes;
  }

  // FLOWER STYLE (2026-11-20, Aaron; from the mode mockups). The Flower of Life: circles of
  // radius R centred on a triangular lattice of spacing R, filled only where two neighbours
  // overlap, so every shape is a lens-shaped petal. Clusters of CENTRES are grown and each chosen
  // centre gets all six of its petals -- the Seed of Life rosette. Two scales, the fine lattice a
  // third of the coarse one, so it shares the coarse lattice's centres.
  //   Scale    -> circle radius, 0.08x the frame's short edge at 0 to ~0.33x at 1.
  //   Shapes   -> how many rosettes.
  //   Symmetry -> the chance a cluster is copied into all six turns about the centre.
  // Petals are true arcs (render/shapePath.js); decisions are made on integer lattice
  // coordinates, so a mockup and its print grow the same flower.
  buildFlower(width, height, scale, short, g) {
    const r = this.rng;
    const turned = r() < 0.5;
    const big = short * (0.08 + 0.25 * scale);
    const layers = [
      { R: big, fill: (0.22 + r() * 0.12) * g.density },
      { R: big / 3, fill: (0.08 + r() * 0.08) * g.density }
    ];
    const shapes = [];
    const SIX = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
    for (const { R, fill } of layers) {
      const at = (a, b) => {
        const x = (a + b / 2) * R;
        const y = ((b * Math.sqrt(3)) / 2) * R;
        return turned ? [-y, x] : [x, y];
      };
      // Centres on the fixed domain, decided in lattice units (see STYLE_DOMAIN), so the list
      // and its order are the same at every canvas size and shape.
      const domain = (STYLE_DOMAIN * short) / R + 1;
      const n = Math.ceil(domain / (Math.sqrt(3) / 2)) + Math.ceil(domain) + 2;
      const centres = new Map();
      for (let b = -n; b <= n; b++) {
        for (let a = -n; a <= n; a++) {
          const d = Math.hypot(a + b / 2, (b * Math.sqrt(3)) / 2);
          if (d > domain) continue;
          centres.set(`${a},${b}`, { a, b, d });
        }
      }
      const chosen = this.growGraph(centres, {
        fill,
        seeds: 2 + Math.floor(r() * 3),
        symmetry: g.coherence,
        near: (short * 0.3) / R,
        core: (short * STYLE_CORE) / R,
        ring: (short * STYLE_RING) / R,
        neighbours: ({ a, b }) => SIX.map(([da, db]) => `${a + da},${b + db}`),
        turn: key => {
          const [a, b] = key.split(',').map(Number);
          return `${-b},${a + b}`;
        },
        turns: 6
      });
      const done = new Set();
      const h = (R * Math.sqrt(3)) / 2;
      for (const { a, b } of chosen) {
        const A = at(a, b);
        for (const [da, db] of SIX) {
          const pair = [`${a},${b}`, `${a + da},${b + db}`].sort().join('|');
          if (done.has(pair)) continue;
          done.add(pair);
          const B = at(a + da, b + db);
          const M = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
          const px = -(B[1] - A[1]) / R;
          const py = (B[0] - A[0]) / R;
          const P1 = [M[0] + px * h, M[1] + py * h];
          const P2 = [M[0] - px * h, M[1] - py * h];
          const shape = this.buildShape([P1, M, P2]);
          shape.path = [['M', P1[0], P1[1]], shortArc(A, R, P1, P2), shortArc(B, R, P2, P1)];
          shape.curve = { discs: [[A, R], [B, R]] }; // see render/shapePath.js
          shapes.push(shape);
        }
      }
    }
    return shapes;
  }

  // GOLDEN STYLE (2026-11-20, Aaron; "Nautilus" in the mockups, renamed for the golden ratio).
  // A golden spiral: quarter-circle wedges, each smaller than the last by the golden ratio and
  // turned a quarter, most with a band through them.
  //   Scale    -> the outermost wedge's radius, 0.5x the frame's short edge at 0 to 1.4x at 1.
  //   Shapes   -> how many wedges carry a band (and, low down, how many wedges are kept).
  //   Symmetry -> arms: one spiral below 0.15, up to four turned about the eye at the top, the
  //               eye moving to the centre as it rises.
  buildGolden(width, height, scale, short, g) {
    const r = this.rng;
    const PHI = (1 + Math.sqrt(5)) / 2;
    const STEPS = 11;
    const arms = g.coherence < 0.15 ? 1 : 1 + Math.ceil(g.coherence * 3);
    const dir = r() < 0.5 ? 1 : -1;
    const a0 = r() * Math.PI * 2;
    const off = 1 - g.coherence;
    // In short-edge units, like everything else (see STYLE_DOMAIN): it was a fraction of the
    // canvas's height and width separately, so the spiral sat somewhere else on every product.
    const eye = [(r() - 0.5) * short * 0.4 * off, (r() - 0.5) * short * 0.4 * off];
    const size0 = short * (0.5 + 0.9 * scale);
    // The spiral built outside-in around its own origin: arc k has radius size0/PHI^k, and each
    // centre steps toward the eye so consecutive arcs join.
    /** @type {Array<[number[], number, number]>} */
    const arcs = [];
    let C = [0, 0];
    let th = 0;
    for (let k = 0; k < STEPS; k++) {
      const a = size0 / Math.pow(PHI, k);
      arcs.push([C, a, th]);
      const next = size0 / Math.pow(PHI, k + 1);
      C = [C[0] + (a - next) * Math.cos(th + (dir * Math.PI) / 2), C[1] + (a - next) * Math.sin(th + (dir * Math.PI) / 2)];
      th += (dir * Math.PI) / 2;
    }
    const limit = C; // where the spiral closes in: placed on the eye
    const shapes = [];
    for (let arm = 0; arm < arms; arm++) {
      const turn = a0 + (arm * Math.PI * 2) / arms;
      const cos = Math.cos(turn), sin = Math.sin(turn);
      const T = (/** @type {number[]} */ [x, y]) => {
        const dx = x - limit[0], dy = y - limit[1];
        return [eye[0] + dx * cos - dy * sin, eye[1] + dx * sin + dy * cos];
      };
      for (const [Ck, a, th0] of arcs) {
        const keepWedge = r() < 0.55 + 0.45 * g.density;
        const keepBand = r() < 0.75 * g.density;
        const c = T(Ck);
        const s0 = th0 + turn;
        const s1 = s0 + (dir * Math.PI) / 2;
        const at = (rad, ang) => [c[0] + rad * Math.cos(ang), c[1] + rad * Math.sin(ang)];
        if (keepWedge) {
          const shape = this.buildShape([at(a, s0), c, at(a, s1)]);
          shape.path = [['M', c[0], c[1]], ['L', ...at(a, s0)], ['A', c[0], c[1], a, s0, s1, dir < 0]];
          shape.curve = { discs: [[c, a]], sector: [s0, s1] };
          shapes.push(shape);
        }
        if (keepBand) {
          const mid = (s0 + s1) / 2;
          const shape = this.buildShape([c, at(a * 0.8, mid), at(a, mid)]);
          shape.path = [
            ['M', ...at(a, s0)],
            ['A', c[0], c[1], a, s0, s1, dir < 0],
            ['L', ...at(a * 0.62, s1)],
            ['A', c[0], c[1], a * 0.62, s1, s0, dir > 0]
          ];
          shape.curve = { discs: [[c, a]], hole: [c, a * 0.62], sector: [s0, s1] };
          shapes.push(shape);
        }
      }
    }
    return shapes;
  }

  // Clusters grown across any graph of items (a Map of key -> item, each item with `d`, its
  // distance from the centre in the units `near` is given in). Like growClusters, which Mosaic
  // keeps for its own triangle grid: a random walk from a few seeds until `fill` of the items
  // are taken, each cluster copied into all `turns` turns (`turn` maps a key to the key one turn on) with
  // probability `symmetry`, those
  // clusters starting within `near` of the centre. Returns items in the order taken.
  growGraph(items, { fill, seeds, symmetry, near, core, ring, neighbours, turn, turns }) {
    const r = this.rng;
    const keys = [...items.keys()];
    if (!keys.length) return [];
    const central = keys.filter(k => items.get(k).d <= Math.max(near, 1));
    // As growClusters: seeds and the budget from the fixed core, not the whole domain.
    const coreKeys = keys.filter(k => items.get(k).d <= Math.max(core, 1));
    const ringKeys = keys.filter(k => items.get(k).d <= Math.max(ring, 1));
    const want = Math.max(1, Math.round(coreKeys.length * fill));
    const perSeed = Math.max(1, Math.round(want / seeds));
    const taken = new Set();
    const out = [];
    let centred = false;
    for (let s = 0; s < seeds && taken.size < want; s++) {
      const mirror = r() < symmetry;
      const size = mirror ? Math.max(1, Math.round(perSeed / turns)) : perSeed;
      // See growClusters: only the first symmetric cluster is held to the centre.
      const pool = !mirror ? (coreKeys.length ? coreKeys : keys) : !centred && central.length ? central : ringKeys;
      if (mirror) centred = true;
      const start = pool[Math.floor(r() * pool.length)];
      const cluster = [start];
      const inCluster = new Set(cluster);
      const front = [start];
      while (cluster.length < size && front.length) {
        const fi = Math.floor(r() * front.length);
        const next = neighbours(items.get(front[fi])).filter(k => items.has(k) && !inCluster.has(k));
        if (!next.length) {
          front.splice(fi, 1);
          continue;
        }
        const k = next[Math.floor(r() * next.length)];
        inCluster.add(k);
        cluster.push(k);
        front.push(k);
      }
      const add = k => {
        if (items.has(k) && !taken.has(k)) {
          taken.add(k);
          out.push(items.get(k));
        }
      };
      for (const k of cluster) {
        add(k);
        if (!mirror) continue;
        let key = k;
        for (let t = 1; t < turns; t++) {
          key = turn(key); // keys, not items: a turn may pass off the canvas and come back on
          add(key);
        }
      }
    }
    return out;
  }

  // The grid's cells covering the canvas (plus a cell of margin), in the geometry container's
  // own coordinates (origin at the canvas centre, which the container turns 90 degrees -- so
  // the local x span is the canvas HEIGHT). Lattice point (a, b) sits at a*e1 + b*e2 with
  // e1 = (1, 0), e2 = (1/2, sqrt(3)/2); cell keys are those integer coordinates.
  isoCells(domain) {
    // Decided in lattice units only (integer coordinates, distances in cell sides), so the cell
    // list -- and its order, which the clusters' random picks index into -- is identical at every
    // canvas size and shape. Points are made for the chosen cells alone (isoPoints).
    const H = Math.sqrt(3) / 2;
    const n = Math.ceil(domain / H) + Math.ceil(domain) + 2;
    const cells = new Map();
    for (let b = -n; b <= n; b++) {
      for (let a = -n; a <= n; a++) {
        for (const up of [true, false]) {
          const v = up ? [[a, b], [a + 1, b], [a, b + 1]] : [[a + 1, b], [a + 1, b + 1], [a, b + 1]];
          let sx = 0, sy = 0;
          for (const [p, q] of v) {
            sx += p + q / 2;
            sy += q * H;
          }
          const d = Math.hypot(sx / 3, sy / 3);
          if (d > domain) continue;
          cells.set(cellKey(v), { v, d });
        }
      }
    }
    return cells;
  }

  // A cell's corners in the container's coordinates (see isoCells).
  isoPoints(v, side, turned) {
    const h = (Math.sqrt(3) / 2) * side;
    return v.map(([a, b]) => {
      const x = (a + b / 2) * side;
      const y = b * h;
      return turned ? [-y, x] : [x, y];
    });
  }

  // Clusters grown by a random walk across shared edges, from `seeds` seed cells, until they
  // hold `fill` of the grid. Each cluster is, with probability `symmetry`, copied into its
  // six turns about the origin (cells turned off the canvas are dropped). Returned in the
  // order grown, which is the draw order.
  growClusters(cells, fill, seeds, symmetry, near, core, ring) {
    const r = this.rng;
    const keys = [...cells.keys()];
    if (!keys.length) return [];
    const central = keys.filter(k => cells.get(k).d <= Math.max(near, 1));
    // Seeds and the shape budget come from the fixed core (STYLE_CORE), not the whole domain:
    // the domain reaches far past a square canvas, and a budget counted against all of it, or a
    // seed dropped anywhere in it, would leave most canvases nearly empty.
    const coreKeys = keys.filter(k => cells.get(k).d <= Math.max(core, 1));
    const ringKeys = keys.filter(k => cells.get(k).d <= Math.max(ring, 1));
    const want = Math.max(1, Math.round(coreKeys.length * fill));
    const taken = new Set();
    const out = [];
    const perSeed = Math.max(1, Math.round(want / seeds));
    let centred = false;
    for (let s = 0; s < seeds && taken.size < want; s++) {
      const mirror = r() < symmetry;
      // A mirrored cluster is copied six times, so it grows a sixth as far.
      const size = mirror ? Math.max(1, Math.round(perSeed / 6)) : perSeed;
      // Only the FIRST symmetric cluster starts near the centre, so the figure has a heart; the
      // rest start anywhere out to STYLE_RING, and their six turns land as a ring at that
      // distance (2026-11-21, Aaron: at full Symmetry the figure "gets a lot smaller
      // and never covers the full artwork"). With every symmetric seed held to `near`, full
      // Symmetry packed the whole budget inside ~0.4 short edges of the centre: measured over 24
      // seeds at 3840x2160, Mosaic reached 43% of the half-diagonal and Flower 60%, against
      // ~95-100% with no symmetry. Same draws as before; only which cell a seed lands on moves.
      const pool = !mirror ? (coreKeys.length ? coreKeys : keys) : !centred && central.length ? central : ringKeys;
      if (mirror) centred = true;
      const start = pool[Math.floor(r() * pool.length)];
      const cluster = [start];
      const inCluster = new Set(cluster);
      const front = [start];
      while (cluster.length < size && front.length) {
        const fi = Math.floor(r() * front.length);
        const next = cellNeighbours(cells.get(front[fi]).v).filter(k => cells.has(k) && !inCluster.has(k));
        if (!next.length) {
          front.splice(fi, 1);
          continue;
        }
        const k = next[Math.floor(r() * next.length)];
        inCluster.add(k);
        cluster.push(k);
        front.push(k);
      }
      const add = k => {
        if (cells.has(k) && !taken.has(k)) {
          taken.add(k);
          out.push(cells.get(k));
        }
      };
      for (const k of cluster) {
        add(k);
        if (!mirror) continue;
        let v = cells.get(k).v;
        for (let t = 1; t < 6; t++) {
          v = v.map(([a, b]) => [-b, a + b]); // 60 degrees about the origin vertex
          add(cellKey(v));
        }
      }
    }
    return out;
  }

  // The first triple, in this shape's own random ordering of the lattice, that is fat
  // (quality = 12*sqrt(3)*area/perimeter^2 above 0.35, where 1 is equilateral) and big enough.
  // If none of the first 16 points makes one, the best-scoring triple seen is used.
  cleanTriple(order, minArea) {
    const n = Math.min(order.length, 16);
    let best = null;
    let bestScore = -1;
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        for (let c = b + 1; c < n; c++) {
          const p = this.unit[order[a]], q = this.unit[order[b]], r = this.unit[order[c]];
          const area = Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1])) / 2;
          const per =
            Math.hypot(q[0] - p[0], q[1] - p[1]) + Math.hypot(r[0] - q[0], r[1] - q[1]) + Math.hypot(p[0] - r[0], p[1] - r[1]);
          const quality = per > 0 ? (12 * Math.sqrt(3) * area) / (per * per) : 0;
          if (quality > 0.35 && area > minArea) return [order[a], order[b], order[c]];
          const score = quality * Math.min(1, area / minArea);
          if (score > bestScore) {
            bestScore = score;
            best = [order[a], order[b], order[c]];
          }
        }
      }
    }
    return best;
  }

  // latticeCells, grouped into rotational families of lattice INDICES: each family is one cell
  // and its turns around the figure. Same cells, same counts as latticeCells.
  latticeOrbits() {
    const perRing = (this.points.length - 1) / this.shapeDepth;
    const idx = (ring, k) => 1 + (ring - 1) * perRing + (((k % perRing) + perRing) % perRing);
    const maxSkip = Math.floor((perRing - 1) / 2);
    const orbits = [];
    for (let ring = 1; ring <= this.shapeDepth; ring++) {
      for (let skip = 1; skip <= maxSkip; skip++) {
        const orbit = [];
        for (let k = 0; k < perRing; k++) orbit.push([idx(ring, k), idx(ring, k + skip), idx(ring, k + 2 * skip)]);
        orbits.push(orbit);
      }
    }
    for (let outer = 2; outer <= this.shapeDepth; outer++) {
      for (let inner = 1; inner < outer; inner++) {
        for (let j = 1; j <= maxSkip; j++) {
          const orbit = [];
          for (let k = 0; k < perRing; k++) orbit.push([idx(outer, k), idx(inner, k + j), idx(inner, k - j)]);
          orbits.push(orbit);
        }
      }
    }
    return orbits;
  }

  pointsArray(r, round = true) {
    let radius = r;
    let points = [];

    points.push([0, 0]);

    for (let h = 1; h <= this.shapeDepth; h++) {
      for (let ang = 0; ang < 360; ang += this.shapeAng) {
        let rad = (ang * Math.PI) / 180;
        let newX = 0 + radius * h * Math.cos(rad);
        let newY = 0 + radius * h * Math.sin(rad);

        points.push(round ? [Math.round(newX), Math.round(newY)] : [newX, newY]);
      }
    }

    return points;
  }

  // With no argument: the original chaotic behaviour, three random lattice points (one
  // between() shuffle of rng() draws). With `cellPoints` (a literal [x,y] triple from
  // latticeCells(), which may include a computed centroid not in this.points at all): those
  // exact points, no positional rng() at all -- the colors below still draw identically
  // either way.
  buildShape(cellPoints = null) {
    let shape = {
      colors: [],
      points: []
    };

    if (cellPoints) {
      shape.points.push(cellPoints[0], cellPoints[1], cellPoints[2]);
    } else {
      let randomPoints = this.between(0, this.points.length - 1);

      shape.points.push(
        this.points[randomPoints[0]],
        this.points[randomPoints[1]],
        this.points[randomPoints[2]]
      );
    }

    if (this.colors.length > 0) {
      // A fresh spin of the ORIGINAL palette every call -- shuffleColors used to mutate
      // this.colors in place, so each call spun whatever the PREVIOUS call had already
      // spun it to, not the true original. That's a cumulative random walk: individually
      // each step is a small, bounded +-10 degree nudge, but walked call after call it
      // drifts smoothly and can travel a full hue rotation over dozens of shapes. For
      // chaotic (randomly positioned) shapes that drift is invisible noise; for the
      // coherent lattice, build order IS spatial order (ring by ring, angle by angle), so
      // the same smooth drift became a visible spiral -- confirmed live: even after fixing
      // the color-aliasing bug below (each shape its own array, not a shared reference),
      // the spiral persisted, because the underlying palette state was still walking.
      // Spinning fresh from the untouched original every time bounds each shape to +-10
      // degrees of the TRUE base color, with no memory of prior calls to walk through.
      const spun = this.shuffleColors(this.colors);
      // No spun.length === 1 case: a one-colour palette is expanded centrally before any
      // generator sees it (see expandMonochromePalette). What was here mixed in a random
      // greyscale as a raw tinycolor object -- see GenerateLargeRadialField's note.
      if (spun.length === 2) {
        shape.colors.push(
          spun[0],
          spun[1],
          tinycolor(spun[0])
            .spin(-20 + this.rng() * 40)
            .toHexString()
        );
      } else {
        shape.colors = spun;
      }
    } else {
      shape.colors.push(
        randomColorHex(this.rng),
        randomColorHex(this.rng),
        randomColorHex(this.rng)
      );
    }

    this.shuffle(shape.colors);

    return shape;
  }

  // Pure -- returns a new array, same length, each entry independently spun +-10 degrees.
  // Deliberately does not mutate `array` (see buildShape's comment on why a mutating
  // version caused a cumulative hue drift across shapes). Same number of rng() draws
  // either way (one per element), so this doesn't change rng() consumption/determinism.
  shuffleColors(array) {
    return array.map(c => tinycolor(c).spin(-10 + this.rng() * 20).toHexString());
  }

  shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      let j = Math.floor(this.rng() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }

  getRandomNumber(min, max) {
    let ranNumber = this.rng() * (max - min) + min;
    return ranNumber;
  }

  between(startNumber, endNumber) {
    let baseNumber = [];
    let randNumber = [];
    for (let i = startNumber; i <= endNumber; i++) {
      baseNumber[i] = i;
    }

    for (let i = endNumber; i > startNumber; i--) {
      let tempRandom = startNumber + Math.floor(this.rng() * (i - startNumber));
      randNumber[i] = baseNumber[tempRandom];
      baseNumber[tempRandom] = baseNumber[i];
    }

    randNumber[startNumber] = baseNumber[startNumber];

    return randNumber;
  }
}
