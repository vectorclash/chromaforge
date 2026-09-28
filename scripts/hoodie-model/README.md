# Hoodie hero model: how `public/models/hoodie/hoodie.glb` was built

This branch (`hoodie-hero-preview`) swaps the homepage's 3D tee for a hoodie. It was tried on
2026-09-28 and **not shipped**: Aaron preferred the tee. He did say it matched a real Printful
mockup almost exactly, so it is kept here in case it's wanted later (for example, if the
sweatshirt gets made from this same model). Everything the app needs is in
`src/components/TshirtPreview.jsx` (`HERO_GARMENT`, the `HOODIE_*` constants and
`composeHoodieSheet`). These scripts are only needed to rebuild the model itself.

## Source

"Apricot printed hooded casual Hoodie" by Style3D CG, CC-BY-4.0:
https://sketchfab.com/3d-models/apricot-printed-hooded-casual-hoodie-211f12b2949346e9ab24a20bf15528c8
Download the **glTF** version (you need a Sketchfab login). The 50MB download is not in the
repo. Unzip it so this layout exists in a scratch working directory:

```
work/
  src/scene.gltf, src/scene.bin, src/textures/...   (the download)
  *.py, tpl-list.tsv, tpl_pieces.json, layout.json  (copied from here)
```

## Steps (run inside `work/`, `B=/Applications/Blender.app/Contents/MacOS/Blender`)

1. `$B -b --factory-startup -P dump_islands.py`: every UV island's outline and 3D samples go
   to `islands.json` (about 12MB, so it isn't committed).
2. `python3 classify.py`: adds each island's bounds, 3D centre and UV-to-3D directions.
   **The island indices hard-coded in `layout.py` and `build.py` (28 = front, 30 = back, ...) come
   from this dump.** They were stable across runs here. If anything differs (a new Blender
   version, a new download), check them against this script's printout before building.
3. `tpl_pieces.json` is already measured. To re-measure: fetch Printful's templates for product
   388 (`printful-catalog?id=388&templates=1`, one PNG per `tpl-list.tsv` row, saved as
   `tpl-<id>.png`, which needs a browser User-Agent or the CDN returns 403), then run
   `python3 tpl_measure.py`.
4. `python3 layout.py` writes `layout.json`, which holds the atlas rects and each piece's
   print-file region. `HOODIE_PIECES` in TshirtPreview.jsx is a copy of it, so keep the two
   in sync.
5. `$B -b --factory-startup -P build.py -- build/hoodie-raw.glb` re-lays the UVs, merges the
   model into one mesh and material, and converts it to metres.
6. Optimize, with the same tool the tee used:
   ```
   npx @gltf-transform/cli dedup    build/hoodie-raw.glb build/p1.glb
   npx @gltf-transform/cli weld     build/p1.glb build/p2.glb
   npx @gltf-transform/cli simplify build/p2.glb build/p3.glb --ratio 0.17 --error 0.001
   npx @gltf-transform/cli quantize build/p3.glb build/p4.glb
   npx @gltf-transform/cli prune    build/p4.glb build/hoodie.glb --keep-attributes true
   ```
   `--keep-attributes true` is required. The material has no texture (the app supplies it), so
   plain `prune` treats the UVs as unused and silently deletes them.

## Checks

- `$B -b --factory-startup -P verify_uv.py`: no UV may move out of its rect during
  simplification. It measured 0.23 atlas units at most.
- `python3 debug_atlas.py`, then
  `$B -b --factory-startup -P render_views.py -- build/hoodie.glb renders/dbg debug_atlas.png`:
  every label must read unmirrored and upright, seen from outside.
- `hood_edges.py` is how the hood's orientation was established: it classifies each hood edge by
  what it touches. Re-run it if the hood ever looks wrong.
- `ndotl.py` measures the lighting term behind `meanNdotL`. It gives **0.504 on the tee** where
  the code documents 0.743 (which is exactly N.L for a surface facing the camera head-on). The
  hoodie therefore takes the tee's 0.743 plus the difference between the two models (0.666 -
  0.504), which lands it at the tee's verified brightness either way.
