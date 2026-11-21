// A MOCKUP MUST COMPOSE THE SAME PIECE AS THE PRINT FILE IT STANDS IN FOR.
//
// Mockup previews render through capMockupRenderSize (cheap, capped, client-side) while the
// real print file renders at the printfile's true dimensions on Fly. Any generator property
// that varies with canvas size therefore makes the preview a customer approves differ from the
// garment they receive. That is not hypothetical: until v14, getCountScale kept only a
// size-scaled subset of the stars and radial blobs, and on the t-shirt front the mockup dropped
// blobs the print kept on 61 of 101 stored designs -- one of them (SubatomicDiffraction-db0d)
// losing the single alpha-0.97 blob that carried its entire colour identity, so the approved
// preview was flat blue-purple and the print file a full rainbow.
//
// This asserts the property directly rather than trusting that nothing reintroduces it: for
// every product and every placement in the catalogue, generate at the MOCKUP size and at the
// TRUE PRINTFILE size and require identical element counts in every layer.
//
// Deliberately compares two sizes through the SAME real generator rather than deriving both
// from one call -- a check whose two sides come from one source can only confirm it is
// self-consistent (the checkCoverage lesson in CLAUDE.md's Printful section).
//
// Element SIZES are expected to differ across ASPECTS and are not checked here; that is
// recompose-per-ratio working as designed. Only counts are a fidelity property.
//
//   node scripts/check-render-density.mjs        # needs no secrets, no network
import { generateArtwork } from '../render-service/generated/render-lib.js';
import { capMockupRenderSize } from '../src/render/scale.js';
import { shapeOutline } from '../src/render/shapePath.js';

// Real printfile dimensions per product, as the catalogue reports them: every distinct non-label
// print file across all variants, read from /mockup-generator/printfiles on 2026-11-20 (the table
// before that was hand-copied and wrong for 12 of 20 products). Kept here rather than fetched so
// the check needs no API key and cannot be made green by a network failure.
const PRINTFILES = {
  257:[[4200,5400],[3000,1800]], 261:[[3900,4950],[2475,1500]], 388:[[6000,6000]],
  320:[[5037,6600]], 717:[[5250,6000],[5250,3750]], 693:[[11250,4350]],
  784:[[9750,8100]], 604:[[10200,7500]], 801:[[6600,6900]], 390:[[4650,5400],[7950,2700]],
  615:[[5100,5700]], 654:[[2700,3150]], 274:[[3150,5550],[1500,2625]], 744:[[2250,1500]],
  83:[[2250,2250],[2550,2550],[2850,2850],[3150,1950],[3450,3450]], 630:[[4125,4125]],
  458:[[3900,3900]], 420:[[2850,2850]], 276:[[4050,5100]], 798:[[1392,2220]]
};
const SEEDS = ['bffvnasl','1vsx8atp','qos0t1c0','aa11bb22','s8x2k9df'];
// The lattice model (2026-11-20) is what the studio makes new work with, so every style is
// checked at no symmetry and at full symmetry (the densest figure).
const LATTICE = ['lattice', 'mosaic', 'flower', 'golden'].flatMap(style => [0, 1].map(coherence => (
  { geometry:{ present:true, model:'lattice', style, coherence } }
)));
const SETTINGS = [null, { geometry:{ present:true, coherence:0, spread:0.7 } }, { geometry:{ present:false } }, ...LATTICE];

function counts(seed, settings, w, h) {
  const c = generateArtwork(seed, w, h, [], settings);
  return {
    blobs:(c.radialFieldConfig?.radGradients||[]).length,
    stars:(c.starFieldConfig?.stars||[]).length,
    small: c.starFieldConfig?.smallStarAmount ?? (c.starFieldConfig?.smallStars||[]).length,
    shapes:(c.geometryConfig?.shapes||[]).length
  };
}

let checked = 0, failed = 0;
for (const [id, files] of Object.entries(PRINTFILES)) {
  for (const [pw, ph] of files) {
    const cap = capMockupRenderSize(pw, ph);
    for (const seed of SEEDS) for (const settings of SETTINGS) {
      const m = counts(seed, settings, cap.width, cap.height);
      const p = counts(seed, settings, pw, ph);
      checked++;
      for (const k of ['blobs','stars','small','shapes']) {
        if (m[k] !== p[k]) {
          failed++;
          console.log(`  FAIL product ${id} ${pw}x${ph}  seed ${seed}  ${k}: mockup ${m[k]} vs print ${p[k]}`);
        }
      }
    }
  }
}
console.log(`\n${checked} product/placement x seed x settings combinations compared`);
if (failed) {
  console.log(`\nFAIL: ${failed} count mismatches. A mockup would misrepresent the print.`);
  console.log('Something scales an element COUNT by canvas size. That belongs in a');
  console.log('size-independent design setting, never in a function of width/height.');
  process.exit(1);
}
console.log('PASS: every mockup composes the same piece as the print file it stands in for.');

// ONE FIGURE ON EVERY PRODUCT (2026-11-20). The lattice model's styles must build the same
// structure on every canvas SHAPE, as the Lattice style does: a figure in units of the short
// edge around the centre, which each canvas only crops. The check above compares two sizes of
// one canvas and could not see Mosaic, Flower and Golden laying out a different figure on each
// product (shipped that way for an hour; on Aaron's design the shapes every canvas shows matched
// the studio's 3% on the tee front). Here: for each lattice-model style, the shapes whose centres
// lie in the area every canvas shows (0.45 short edges each way) must match the studio canvas's,
// on every printfile, to within 1% of a short edge. Verified to fail on the code before the fix
// (worst 0% Mosaic, 2% Flower, 0% Golden) and pass after (100% everywhere, Lattice included).
const STUDIO = [3840, 2160];
const centres = (w, h, cfg) => {
  const s = Math.min(w, h);
  const out = [];
  for (const sh of cfg?.shapes || []) {
    const p = shapeOutline(sh);
    const x = p.reduce((a, q) => a + q[0], 0) / p.length / s;
    const y = p.reduce((a, q) => a + q[1], 0) / p.length / s;
    if (Math.abs(x) <= 0.45 && Math.abs(y) <= 0.45) out.push([x, y]);
  }
  return out;
};
const covered = (A, B) => A.every(([x, y]) => B.some(([u, v]) => Math.hypot(x - u, y - v) < 0.01));
let shapeChecks = 0, shapeFailed = 0;
for (const settings of LATTICE) for (const seed of SEEDS) {
  const ref = centres(...STUDIO, generateArtwork(seed, ...STUDIO, [], settings).geometryConfig);
  for (const [id, files] of Object.entries(PRINTFILES)) for (const [pw, ph] of files) {
    shapeChecks++;
    const got = centres(pw, ph, generateArtwork(seed, pw, ph, [], settings).geometryConfig);
    if (!covered(ref, got) || !covered(got, ref)) {
      shapeFailed++;
      if (shapeFailed <= 12) console.log(`  FAIL ${settings.geometry.style} sym${settings.geometry.coherence}  seed ${seed}  product ${id} ${pw}x${ph}: a different figure from the studio's`);
    }
  }
}
console.log(`\n${shapeChecks} style x seed x product canvas comparisons against the studio canvas`);
if (shapeFailed) {
  console.log(`\nFAIL: ${shapeFailed} canvases build a different figure. A style must decide everything in`);
  console.log('short-edge units around the centre, never from the canvas width and height.');
  process.exit(1);
}
console.log('PASS: every geometry style builds the same figure on every product, cropped by its canvas.');
