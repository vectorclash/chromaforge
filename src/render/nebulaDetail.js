// The 3D flight volume's fine-detail noise (animation3d/nebula3d.js): a tiling 3D Perlin fBm, 64^3,
// integer lattice periods so it wraps exactly. Pure and DOM-free so the nebula's worker can build it
// (render/nebulaWorker.js) -- ~30ms on a desktop, a noticeable hitch on a phone's main thread.
export const DETAIL_SIZE = 64;
export function detailNoiseData() {
  const N = DETAIL_SIZE;
  let h = 2166136261 >>> 0;
  const rand = () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
    h ^= h >>> 16;
    return h / 4294967296;
  };
  const MAXP = 32;
  const grads = new Float32Array(MAXP * MAXP * MAXP * 3);
  for (let i = 0; i < MAXP * MAXP * MAXP; i++) {
    const z = rand() * 2 - 1, a = rand() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    grads.set([r * Math.cos(a), r * Math.sin(a), z], i * 3);
  }
  const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
  const perlin = (x, y, z, P) => {
    const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
    const fx = x - X, fy = y - Y, fz = z - Z;
    let out = 0;
    const u = fade(fx), v = fade(fy), w = fade(fz);
    for (let c = 0; c < 8; c++) {
      const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1;
      const gi = ((((X + dx) % P) * MAXP + ((Y + dy) % P)) * MAXP + ((Z + dz) % P)) * 3;
      const dot = grads[gi] * (fx - dx) + grads[gi + 1] * (fy - dy) + grads[gi + 2] * (fz - dz);
      out += dot * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
    }
    return out;
  };
  const data = new Uint8Array(N * N * N);
  for (let z = 0; z < N; z++)
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        let sum = 0, amp = 1, norm = 0;
        for (let o = 0; o < 4; o++) {
          const P = 4 << o; // lattice cells across the tile: 4, 8, 16, 32
          sum += amp * perlin((x / N) * P, (y / N) * P, (z / N) * P, P);
          norm += amp;
          amp *= 0.5;
        }
        data[(z * N + y) * N + x] = Math.max(0, Math.min(255, Math.round((0.5 + (0.9 * sum) / norm) * 255)));
      }
  return data;
}
