// Minimal by design. This is a gate, not a style programme -- prettier already owns formatting
// (npm run format), and a lint config that reports hundreds of stylistic opinions is one that
// gets ignored, which is worse than none.
//
// Two rules earn their place, because each one maps to a bug that actually reached production:
//
//   no-undef                     -- the class that broke every mockup preview on 2026-09-17
//                                   (a re-export does not bind locally). tsc --checkJs catches
//                                   this too; the overlap is deliberate, since the two tools
//                                   see different files.
//   react-hooks/rules-of-hooks   -- a useRef was added BELOW ProductPage's `if (loading)` early
//                                   return, so the loading render ran fewer hooks than the
//                                   loaded one: React error #310 on every product page, with
//                                   zero build output. That is what prompted
//                                   check-routes-smoke.mjs; this catches it a step earlier.
//
// exhaustive-deps is deliberately a WARNING, not an error. Several effects here intentionally
// omit dependencies (the entrance-animation and crossfade code relies on it), so making it fail
// the build would mean either bad changes or a wall of suppressions.
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'render-service/generated/**', 'public/**'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx,mjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } }
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Everything below is noise-suppression on js.configs.recommended, not a considered
      // opinion -- these fire widely on working code and none of them has ever been a bug here.
      'no-unused-vars': 'off',
      'no-empty': 'off',
      'no-constant-condition': 'off',
      'no-prototype-builtins': 'off'
    }
  }
];
