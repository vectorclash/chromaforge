// Fails if something that looks like a secret is committed. This repo is public, so a secret in
// any tracked file is a leaked secret, including in a comment.
//
// It exists because the shared key behind the cron jobs sat in migration 0014 from 2026-07-19 to
// 2026-11-04. GitHub's secret scanning was on and did not flag it: providers' keys have recognizable
// prefixes, and this was plain hex, so nothing marked it as a key. Hence the hex and named-value
// rules below, on top of the provider prefixes.
//
//   node scripts/check-no-secrets.mjs               # the current tracked files
//   node scripts/check-no-secrets.mjs --ref=dabf0de # the tree at a commit (fails: the real leak)
//
// Findings name the file, line and rule. The matched text is never printed, because CI logs on a
// public repo are public too. It reads files only; no secrets, no network.
//
// A long hex string that is genuinely public gets its hash added to PUBLIC_HEX, never its file to a
// skip list, so a real key added next to a public ID in the same file is still caught.
//
// NOT covered: git history (replace a leaked key, because deleting it from a file does not unpublish
// it) and a secret with no recognizable shape that is not assigned to a telling name.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const RULES = [
  ['Stripe secret or restricted key', /\b[sr]k_(live|test)_[A-Za-z0-9]{10,}/],
  ['Stripe webhook secret', /\bwhsec_[A-Za-z0-9]{10,}/],
  ['Supabase secret key', /\bsb_secret_[A-Za-z0-9_-]{10,}/],
  ['JSON Web Token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/],
  ['Instagram token', /\bIGAA[A-Za-z0-9_-]{20,}/],
  ['Private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  [
    'Value assigned to a secret-like name',
    /(?:api[_-]?key|secret|token|password|passwd|auth[_-]?key|-key)['"]?\s*(?:[:=,]|=>)\s*['"][A-Za-z0-9_\-+/=.]{20,}['"]/i
  ]
];
const LONG_HEX = /(?<![0-9a-zA-Z])[0-9a-fA-F]{32,}(?![0-9a-zA-Z])/g;

// First 16 characters of the SHA-256 of each long hex value known to be public.
const PUBLIC_HEX = new Set([
  '1a19f1c75a8c6ff4', // Sketchfab ID of the t-shirt model (its CC-BY attribution)
  'a092dac4a71e42b9', // Sketchfab ID of the hoodie model (its CC-BY attribution)
  // Printful's public template image URLs (scripts/hoodie-model/tpl-list.tsv)
  '236912568635e5aa',
  '98bd2b23d0f9337f',
  'e1ccb4fcbafab718',
  '568715258f0df936',
  '0ab277f573147160',
  '0810978e555628f4',
  '652eb551eb6a751d'
]);

const git = (...args) => execFileSync('git', args, { maxBuffer: 1 << 28 });
const ref = process.argv.find(a => a.startsWith('--ref='))?.slice('--ref='.length);
const paths = (ref ? git('ls-tree', '-r', '--name-only', '-z', ref) : git('ls-files', '-z'))
  .toString()
  .split('\0')
  .filter(Boolean);
const read = path => {
  if (ref) return git('show', `${ref}:${path}`);
  try {
    return readFileSync(path);
  } catch {
    return null; // tracked but deleted in the working tree
  }
};

const findings = [];
let scanned = 0;
for (const path of paths) {
  const bytes = read(path);
  if (!bytes || bytes.subarray(0, 8192).includes(0)) continue; // binary
  scanned++;
  bytes
    .toString('utf8')
    .split('\n')
    .forEach((line, index) => {
      const at = `${path}:${index + 1}`;
      for (const [name, rule] of RULES) if (rule.test(line)) findings.push(`${at}  ${name}`);
      for (const [hex] of line.matchAll(LONG_HEX)) {
        const hash = createHash('sha256').update(hex).digest('hex').slice(0, 16);
        if (!PUBLIC_HEX.has(hash)) findings.push(`${at}  Long hex string (hash ${hash})`);
      }
    });
}

// Finding nothing because nothing was read must not look like a pass.
if (scanned < 100) {
  console.error(`FAIL: only ${scanned} files were scanned, so this result means nothing.`);
  process.exit(1);
}
if (findings.length > 0) {
  console.error(`FAIL: ${findings.length} possible secret(s) in ${scanned} files:\n`);
  for (const finding of findings) console.error(`  ${finding}`);
  console.error(
    '\nIf one is a real secret, replace it now and keep the new value out of the repo. If it is genuinely\n' +
      "public hex, add its hash to PUBLIC_HEX in this script. Named values can be moved to a secret store."
  );
  process.exit(1);
}
console.log(`PASS: no secrets found in ${scanned} tracked text files.`);
