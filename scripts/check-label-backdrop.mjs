// Each label mark must sample the artwork it is ACTUALLY printed over.
//
//   node scripts/check-label-backdrop.mjs
//
// Needs no API key, no network and no canvas -- labelBackdropChoice is a pure function, which is
// why it was pulled out of the render path. It answers the question that is easy to get wrong and
// invisible once wrong: on the reversible bucket hat the outside label sits on the front face and
// the inside label on the INSIDE face, and those carry different designs whenever the customer has
// chosen a second one. Sampling the front for both would pick the inside mark's ink from artwork
// that is not underneath it, and the only symptom would be an occasionally illegible printed mark.
//
// It also pins the other half: on every product but the hat, `label_inside` is a sewn-in tag that
// paints its own dark panel and samples nothing at all.
import { labelBackdropChoice, frontPlacementKey } from '../src/lib/printfulPlacements.js';
import { PRODUCT_MOCKUP_CONFIG } from '../src/lib/printfulMockupConfig.js';

const OUT = { id: 'outside', seed: 'aaaa' };
const IN = { id: 'inside', seed: 'bbbb' };
const hat = PRODUCT_MOCKUP_CONFIG[654];
const base = {
  design: OUT,
  frontKey: 'outside_front',
  frontSpec: { id: 'outside-sheet' },
  insideFaceKey: 'inside_front',
  insideFaceSpec: { id: 'inside-sheet' },
  labelOutsideRegion: hat.labelOutsideRegion,
  labelInsideRegion: hat.labelInsideRegion
};

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const sig = c => ({ transparent: c.transparent, design: c.backdropDesign?.id ?? null, spec: c.backdropSpec?.id ?? null, region: !!c.region });

// --- the hat, with a DIFFERENT second design on the inside faces ---
const two = { ...base, secondaryDesign: IN, hasSecondary: true };
check('hat / two designs / outside label reads the OUTSIDE artwork',
  sig(labelBackdropChoice('label_outside', two)),
  { transparent: true, design: 'outside', spec: 'outside-sheet', region: true });
check('hat / two designs / inside label reads the INSIDE artwork',
  sig(labelBackdropChoice('label_inside', two)),
  { transparent: true, design: 'inside', spec: 'inside-sheet', region: true });

// --- the hat, one design on both faces ---
const one = { ...base, secondaryDesign: null, hasSecondary: false };
check('hat / one design / outside label reads it',
  sig(labelBackdropChoice('label_outside', one)),
  { transparent: true, design: 'outside', spec: 'outside-sheet', region: true });
check('hat / one design / inside label reads it too, off the inside sheet',
  sig(labelBackdropChoice('label_inside', one)),
  { transparent: true, design: 'outside', spec: 'inside-sheet', region: true });

// --- every other product: the inside label stays an opaque sewn tag ---
const tee = { design: OUT, frontKey: 'default', frontSpec: { id: 'front' },
  labelOutsideRegion: null, labelInsideRegion: null, hasSecondary: false };
check('t-shirt / inside label is NOT transparent and samples nothing',
  sig(labelBackdropChoice('label_inside', tee)),
  { transparent: false, design: 'outside', spec: 'front', region: false });
check('t-shirt / outside label transparent but region-less -> keeps dark ink',
  sig(labelBackdropChoice('label_outside', tee)),
  { transparent: true, design: 'outside', spec: 'front', region: false });

// --- a product with a calibrated OUTSIDE label but a sewn inside tag (mesh shorts) ---
const shorts = { design: OUT, frontKey: 'front', frontSpec: { id: 'front' },
  labelOutsideRegion: PRODUCT_MOCKUP_CONFIG[693].labelOutsideRegion,
  labelInsideRegion: PRODUCT_MOCKUP_CONFIG[693].labelInsideRegion || null, hasSecondary: false };
check('shorts / outside label samples the front',
  sig(labelBackdropChoice('label_outside', shorts)),
  { transparent: true, design: 'outside', spec: 'front', region: true });
check('shorts / inside label untouched by this change',
  sig(labelBackdropChoice('label_inside', shorts)),
  { transparent: false, design: 'outside', spec: 'front', region: false });

// --- and the input the choice function TAKES, derived the way the real caller derives it ---
//
// This is the case that was missing, and its absence is why a real bug shipped green: every check
// above hands frontKey in, so all of them passed while lib/printful.js resolved it to null on the
// hat -- whose front face is 'outside_front', not 'front' -- and the outside label printed dark
// ink over any artwork, however dark. A null front key silently disables the whole feature for a
// product, so it is asserted per product rather than in the abstract.
const FRONT_ENTRIES = {
  654: [['outside_front', 410], ['outside_back', 410], ['inside_front', 410], ['label_outside', 411]],
  693: [['front', 472], ['back', 472], ['label_outside', 400]],
  257: [['default', 94], ['label_inside', 64]]
};
check('hat / the front face resolves (it is outside_front, not front)',
  frontPlacementKey(FRONT_ENTRIES[654]), 'outside_front');
check('shorts / the front face resolves', frontPlacementKey(FRONT_ENTRIES[693]), 'front');
check('t-shirt / the front face resolves (default)', frontPlacementKey(FRONT_ENTRIES[257]), 'default');
check('a label-only entry list resolves to no front face',
  frontPlacementKey([['label_outside', 411]]), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
