// `export { x } from './m'` DOES NOT BIND x IN THE EXPORTING MODULE'S OWN SCOPE.
//
// It forwards the binding to consumers and nothing else, so a module that re-exports a name
// that way and then USES it elsewhere in its own body throws "x is not defined" at runtime.
// The syntax is valid, so a bundler builds it happily; the failure only appears when the code
// path runs.
//
// This shipped live on 2026-09-17. lib/printful.js re-exported capMockupRenderSize from
// render/scale.js while still calling it twice inside capRenderStrategy, which broke every
// mockup preview on the store ("We couldn't generate a preview right now"). Checkout was
// untouched -- it renders at true dimensions through renderPrintFileStrategy and never calls
// that function -- but no customer could preview anything. Nothing caught it: the build passed,
// check-routes-smoke.mjs never clicks Generate so the strategy never ran, and
// check-render-density.mjs imports the function straight from scale.js rather than through the
// module that was broken.
//
// The fix is always the same: `import { x } from './m';` and a separate `export { x };`.
//
//   node scripts/check-reexport-bindings.mjs        # no secrets, no network, ~instant
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../src', import.meta.url).pathname;
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|jsx)$/.test(e)) files.push(p);
  }
})(ROOT);

// Comments only. Strings are deliberately LEFT INTACT here, because the re-export pattern has
// to match the module path inside quotes -- stripping strings first collapses '../render/scale'
// to '' and the pattern then matches nothing, which is how the first version of this check
// passed on the very commit that shipped the bug. (It reported "0 re-export statements checked",
// i.e. it passed vacuously -- the reason a checker must be run against the broken code before
// it is trusted.)
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

// For the "is this name USED elsewhere" test, strings go too -- a name inside a string literal
// is not a reference.
function stripStrings(src) {
  return src
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

let problems = 0, reexports = 0;
for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  const code = stripComments(raw);
  const re = /export\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]\s*;?/g;
  let m;
  while ((m = re.exec(code))) {
    reexports++;
    const names = m[1]
      .split(',')
      .map(s => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    // Everything in this file EXCEPT the re-export statement itself.
    const rest = stripStrings(code.slice(0, m.index) + code.slice(m.index + m[0].length));
    for (const name of names) {
      const used = new RegExp(`\\b${name}\\b`).test(rest);
      if (used) {
        problems++;
        const line = raw.slice(0, raw.indexOf(m[0]) + 1).split('\n').length;
        console.log(`  FAIL ${file.replace(ROOT, 'src')}:${line}`);
        console.log(`       re-exports "${name}" from another module AND uses it in this file.`);
        console.log(`       A re-export does not bind locally -- import it, then export it separately.`);
      }
    }
  }
}
console.log(`\n${files.length} modules scanned, ${reexports} re-export statements checked`);
if (problems) { console.log(`\nFAIL: ${problems} name(s) used but never bound locally.`); process.exit(1); }
console.log('PASS: every re-exported name that is used locally is also imported locally.');
