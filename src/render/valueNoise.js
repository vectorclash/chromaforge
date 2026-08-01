// Deterministic value noise — no RNG involved, so the same coordinates always give the same
// value and a field built from it needs no seed of its own.
//
// Originally from temp/sound-generator's stars.js, lifted into `animation3d/tunnelScene.js`
// for the 3D tunnel's noise-clustered star placement. Pulled out here when the About
// section's hexagon dust needed the same clumping: tunnelScene is a lazily-imported three.js
// module, and importing it for twenty lines of arithmetic would drag three.js into the home
// page's bundle.
//
// Plain JS with no dependencies, so both the Vite app and the plain-Node preview harness that
// renders `components/home/aboutBackground.js` can use it.

export function nHash(x, y, z) {
  const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

export function nLerp(a, b, t) {
  return a + (b - a) * t;
}

export function nSmooth(t) {
  return t * t * (3 - 2 * t);
}

export function valueNoise(x, y, z) {
  const ix = Math.floor(x),
    iy = Math.floor(y),
    iz = Math.floor(z);
  const fx = nSmooth(x - ix),
    fy = nSmooth(y - iy),
    fz = nSmooth(z - iz);
  return nLerp(
    nLerp(
      nLerp(nHash(ix, iy, iz), nHash(ix + 1, iy, iz), fx),
      nLerp(nHash(ix, iy + 1, iz), nHash(ix + 1, iy + 1, iz), fx),
      fy
    ),
    nLerp(
      nLerp(nHash(ix, iy, iz + 1), nHash(ix + 1, iy, iz + 1), fx),
      nLerp(nHash(ix, iy + 1, iz + 1), nHash(ix + 1, iy + 1, iz + 1), fx),
      fy
    ),
    fz
  );
}
