// Manual verification script, not part of the deployed service: renders a real saved
// design at a moderate size first (fast), then at true print resolution, and writes both
// PNGs to disk for visual inspection. Run with: node spike-test.js
import fs from 'node:fs';
import { renderDesign, GENERATOR_VERSION } from './render.js';

const design = {
  seed: 'w5xej1o2',
  colors: ['#FF0059', '#FFBB00', '#EAFF00', '#00E5FF', '#4C00FF'],
  generatorVersion: 2
};

console.log('GENERATOR_VERSION:', GENERATOR_VERSION, '(design expects:', design.generatorVersion, ')');

console.time('moderate render (800x800)');
const moderate = await renderDesign({ seed: design.seed, colors: design.colors, width: 800, height: 800 });
console.timeEnd('moderate render (800x800)');
fs.writeFileSync('spike-moderate.png', moderate);
console.log('Wrote spike-moderate.png,', moderate.length, 'bytes');

console.time('print-resolution render (4200x5400)');
const printRes = await renderDesign({ seed: design.seed, colors: design.colors, width: 4200, height: 5400 });
console.timeEnd('print-resolution render (4200x5400)');
fs.writeFileSync('spike-print.png', printRes);
console.log('Wrote spike-print.png,', printRes.length, 'bytes');
