# blender -b -P build.py -- <out.glb>
import bpy, bmesh, json, sys
from collections import defaultdict
out_path=sys.argv[sys.argv.index('--')+1]
L=json.load(open('layout.json')); A=L['atlas']
isl=json.load(open('islands.json'))
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath='src/scene.gltf')
S=4096
objs={o.name:o for o in bpy.context.scene.objects if o.type=='MESH'}
# target for each dumped island (by obj + bbox): ('piece', rect, T) | ('strip', rect, T) | ('white',)
targets={}
piece_by_island={p['island']:p for p in L['pieces']}
hro=[p for p in L['pieces'] if p['key']=='hoodRightOut'][0]['rect']
hlo=[p for p in L['pieces'] if p['key']=='hoodLeftOut'][0]['rect']
wx,wy,ww,wh=L['white']; white_inner=[wx+16,wy+16,ww-32,wh-32]
strip_islands=[4,5,16,17,18,19,20,21]
# inside shell -> its outside piece
INNER_OF={29:28,31:30,27:26,33:32,35:34,1:0,37:36,13:12,15:14}
for i,d in enumerate(isl):
    key=(d['obj'],tuple(round(v) for v in d['bbox']))
    if i in piece_by_island:
        p=piece_by_island[i]; targets[key]=('piece',p['rect'],p['T'])
    elif i in INNER_OF:
        # an inside surface shows its own piece's print, the way the tee's do: left white, the
        # back panel's inside read as a white patch through the neckline on every design
        p=piece_by_island[INNER_OF[i]]; targets[key]=('piece',p['rect'],p['T'])
    elif i in strip_islands:
        r=hro if d['c'][0]<0 else hlo
        # a thin band just inside the hood panel's face-opening edge (right edge on the
        # wearer's-right piece, left edge on the left piece, after normalisation)
        x=r[0]+r[2]-10 if d['c'][0]<0 else r[0]+4
        targets[key]=('strip',[x,r[1]+4,6,r[3]-8],'flipY')
    else:
        targets[key]=('white',white_inner,'id')
def transform(un,vn,T):
    if T in ('flipX','rot180'): un=1-un
    if T in ('flipY','rot180'): vn=1-vn
    return un,vn
used=defaultdict(int)
for name,ob in objs.items():
    me=ob.data
    bm=bmesh.new(); bm.from_mesh(me)
    uv=bm.loops.layers.uv.active
    parent=list(range(len(bm.faces))); bm.faces.ensure_lookup_table()
    def find(a):
        while parent[a]!=a: parent[a]=parent[parent[a]]; a=parent[a]
        return a
    vmap=defaultdict(list)
    for f in bm.faces:
        for l in f.loops: vmap[(l.vert.index, round(l[uv].uv.x,5), round(l[uv].uv.y,5))].append(f.index)
    for fs in vmap.values():
        for f in fs[1:]:
            ra,rb=find(fs[0]),find(f)
            if ra!=rb: parent[ra]=rb
    groups=defaultdict(list)
    for f in bm.faces: groups[find(f.index)].append(f)
    for fs in groups.values():
        us=[l[uv].uv.x*S for f in fs for l in f.loops]; vs=[(1-l[uv].uv.y)*S for f in fs for l in f.loops]
        x0,y0=min(us),min(vs); w,h=max(us)-x0,max(vs)-y0
        key=(name,(round(x0),round(y0),round(w),round(h)))
        # tolerate 1px rounding differences against the dump
        tk=None
        for k in targets:
            if k[0]==name and all(abs(a-b)<=1 for a,b in zip(k[1],key[1])): tk=k; break
        assert tk, f'no target for {key}'
        kind,rect,T=targets[tk]; used[kind]+=1
        rx,ry,rw,rh=rect
        for f in fs:
            for l in f.loops:
                un=(l[uv].uv.x*S-x0)/w if w else 0.5
                vn=((1-l[uv].uv.y)*S-y0)/h if h else 0.5
                un,vn=transform(un,vn,T)
                X=rx+un*rw; Y=ry+vn*rh
                l[uv].uv=(X/A, 1-Y/A)
    bm.to_mesh(me); bm.free()
print('remapped islands', dict(used))
# one material for everything: plain white fabric; the app supplies the texture at runtime
mat=bpy.data.materials.new('fabric'); mat.use_nodes=True
bsdf=mat.node_tree.nodes['Principled BSDF']
bsdf.inputs['Base Color'].default_value=(1,1,1,1); bsdf.inputs['Roughness'].default_value=0.92; bsdf.inputs['Metallic'].default_value=0
mat.use_backface_culling=False
for ob in objs.values():
    ob.data.materials.clear(); ob.data.materials.append(mat)
    # drop the tangent/normal-map dependency entirely: no normal map ships
# join into one mesh, bake transforms, metres
bpy.ops.object.select_all(action='DESELECT')
for ob in objs.values(): ob.select_set(True)
bpy.context.view_layer.objects.active=list(objs.values())[0]
bpy.ops.object.join()
ob=bpy.context.view_layer.objects.active; ob.name='hoodie'; ob.data.name='hoodie'
bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
ob.scale=(0.001,0.001,0.001); bpy.ops.object.transform_apply(scale=True)
# remove the now-empty import hierarchy
for o in list(bpy.context.scene.objects):
    if o.type!='MESH': bpy.data.objects.remove(o)
# keep only the first UV map
while len(ob.data.uv_layers)>1: ob.data.uv_layers.remove(ob.data.uv_layers[-1])
bpy.ops.export_scene.gltf(filepath=out_path, export_format='GLB', export_texcoords=True, export_normals=True,
    export_tangents=False, export_materials='EXPORT', export_yup=True, use_selection=False, export_apply=True)
print('exported', out_path, 'tris', sum(len(p.vertices)-2 for p in ob.data.polygons))
