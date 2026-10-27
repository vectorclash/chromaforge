// Step 7 of the hoodie build (see README.md): the inside of every body piece shows plain white
// fabric instead of the print, as on a real all-over-print hoodie.
//
//   node scripts/hoodie-model/unprint-inside.mjs <in.glb> <out.glb>
//
// The model holds each printed piece TWICE, an outside shell and an inside one a fraction of a
// millimetre behind it, both mapped onto the same atlas rect (build.py's INNER_OF), so the print
// showed through the neckline, the cuffs and up the hem. In the served mesh each shell is its own
// connected component, and the nine body pieces (front, back, both sleeves, pocket, both bands,
// both cuffs) are exactly the rects that hold two components; the inside shell is the one with
// FEWER triangles in all nine, established by colouring the two and looking from outside, from
// below and into the neck. The hood keeps its print on both faces (Printful prints the lining),
// and is one component per rect, so it is never touched.
//
// The inside shells' UVs move by (+1, +1), off the atlas: the app's sheet texture clamps to its
// edge, and the sheet's corner is the white margin composeHoodieSheet fills, so they sample
// white. A whole-number shift leaves the knit normal map exactly where it was (it repeats), and
// the UVs move, not change shape, so nothing about the lighting moves either. That needs float
// UVs: KHR_mesh_quantization's normalized shorts only reach 0..1. Costs ~50KB.
//
// No dependencies: it reads and rewrites the .glb's JSON and binary chunks directly.
import fs from 'fs';

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error('usage: node unprint-inside.mjs <in.glb> <out.glb>');
  process.exit(1);
}

const glb = fs.readFileSync(inPath);
const jsonLen = glb.readUInt32LE(12);
const gltf = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));
const bin = glb.subarray(20 + jsonLen + 8, 20 + jsonLen + 8 + glb.readUInt32LE(20 + jsonLen));

const prim = gltf.meshes[0].primitives[0];
const uvAcc = gltf.accessors[prim.attributes.TEXCOORD_0];
if (uvAcc.componentType === 5126) {
  console.error('TEXCOORD_0 is already float: this file has been through this step.');
  process.exit(1);
}

const read = (acc, comps) => {
  const view = gltf.bufferViews[acc.bufferView];
  const size = { 5121: 1, 5123: 2, 5125: 4 }[acc.componentType];
  const stride = view.byteStride || size * comps;
  const base = (view.byteOffset || 0) + (acc.byteOffset || 0);
  const max = { 5121: 255, 5123: 65535 }[acc.componentType];
  const out = new Float64Array(acc.count * comps);
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < comps; c++) {
      const o = base + i * stride + c * size;
      const v = size === 1 ? bin.readUInt8(o) : size === 2 ? bin.readUInt16LE(o) : bin.readUInt32LE(o);
      out[i * comps + c] = acc.normalized ? v / max : v;
    }
  }
  return out;
};

const idx = read(gltf.accessors[prim.indices], 1);
const uv = read(uvAcc, 2);
const nv = uvAcc.count;

// Connected components over shared vertices.
const parent = Array.from({ length: nv }, (_, i) => i);
const find = x => {
  while (parent[x] !== x) x = parent[x] = parent[parent[x]];
  return x;
};
for (let t = 0; t < idx.length; t += 3) {
  for (const k of [1, 2]) {
    const a = find(idx[t]), b = find(idx[t + k]);
    if (a !== b) parent[a] = b;
  }
}
const comps = new Map();
for (let t = 0; t < idx.length; t += 3) {
  const root = find(idx[t]);
  const c = comps.get(root) || { tris: 0, verts: new Set(), u0: 1, v0: 1 };
  c.tris++;
  for (let k = 0; k < 3; k++) {
    const v = idx[t + k];
    c.verts.add(v);
    c.u0 = Math.min(c.u0, uv[2 * v]);
    c.v0 = Math.min(c.v0, uv[2 * v + 1]);
  }
  comps.set(root, c);
}

// Group by the atlas rect each component sits in (its UV origin, in atlas pixels).
const byRect = new Map();
for (const c of comps.values()) {
  const key = `${Math.round(c.u0 * 2048)},${Math.round(c.v0 * 2048)}`;
  if (!byRect.has(key)) byRect.set(key, []);
  byRect.get(key).push(c);
}
const pairs = [...byRect].filter(([, list]) => list.length === 2);
if (pairs.length !== 9) {
  console.error(`expected the 9 body pieces to hold two shells each, found ${pairs.length}: the model changed, re-check which shell is inside before trusting this`);
  process.exit(1);
}

const out = Float32Array.from(uv);
let moved = 0;
for (const [key, list] of pairs) {
  const [outside, inside] = [...list].sort((a, b) => b.tris - a.tris);
  for (const v of inside.verts) {
    out[2 * v] += 1;
    out[2 * v + 1] += 1;
  }
  moved += inside.tris;
  console.log(`rect ${key}: outside ${outside.tris} tris, inside ${inside.tris} tris -> white`);
}

// Rebuild the binary chunk: every bufferView still in use, plus the float UVs, 4-byte aligned.
// The served file INTERLEAVES position, normal and UV in one view, so the old UV view usually
// stays (positions and normals live in it); only a view no accessor reads any more is dropped.
const uvBytes = Buffer.from(out.buffer);
gltf.bufferViews.push({ buffer: 0, byteLength: uvBytes.length, target: 34962 });
const newUvView = gltf.bufferViews.length - 1;
Object.assign(uvAcc, { bufferView: newUvView, componentType: 5126, byteOffset: 0 });
delete uvAcc.normalized;
delete uvAcc.min;
delete uvAcc.max;

const used = new Set(gltf.accessors.map(a => a.bufferView));
const remap = new Map();
const views = [];
const parts = [];
let offset = 0;
gltf.bufferViews.forEach((view, i) => {
  if (!used.has(i)) return;
  const data = i === newUvView ? uvBytes : bin.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
  const pad = (4 - (offset % 4)) % 4;
  if (pad) parts.push(Buffer.alloc(pad));
  offset += pad;
  remap.set(i, views.length);
  views.push({ ...view, byteOffset: offset });
  parts.push(data);
  offset += data.length;
});
gltf.bufferViews = views;
gltf.accessors.forEach(a => (a.bufferView = remap.get(a.bufferView)));
const newBin = Buffer.concat([...parts, Buffer.alloc((4 - (offset % 4)) % 4)]);
gltf.buffers[0].byteLength = newBin.length;

let json = Buffer.from(JSON.stringify(gltf), 'utf8');
json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
const header = Buffer.alloc(12);
header.write('glTF', 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + json.length + 8 + newBin.length, 8);
const chunk = (data, type) => {
  const h = Buffer.alloc(8);
  h.writeUInt32LE(data.length, 0);
  h.writeUInt32LE(type, 4);
  return Buffer.concat([h, data]);
};
fs.writeFileSync(outPath, Buffer.concat([header, chunk(json, 0x4e4f534a), chunk(newBin, 0x004e4942)]));
console.log(`${moved} inside triangles now sample the sheet's white margin; wrote ${outPath} (${fs.statSync(outPath).size} bytes)`);
