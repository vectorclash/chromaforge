// Ambient declarations for globals this app genuinely uses but which no package types.
// Kept deliberately narrow: each entry is a real runtime global, not a way to silence tsc.

// createjs / EaselJS is loaded by a <script> tag in index.html (and by render-service's
// shim.js in Node), not imported, so nothing declares it. GeometricShape.js is the only
// consumer -- it uses Shape/Container/Stage for the geometry layer's gradient fills and
// composite operations. See CLAUDE.md's note on why createjs stays.
interface Window {
  createjs: any;
}

// Vite injects import.meta.env at build time. The "vite/client" types cover this, but they
// are declared here too because tsconfig.check.json type-checks plain .js modules that are
// also run directly by Node scripts (render-service, scripts/), where vite/client is not in
// scope.
interface ImportMeta {
  env: any;
}
