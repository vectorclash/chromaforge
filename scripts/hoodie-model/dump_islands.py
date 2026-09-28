import bpy, bmesh, json
from mathutils import Vector
from collections import defaultdict
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath='src/scene.gltf')
S=4096
out=[]
for ob in sorted([o for o in bpy.context.scene.objects if o.type=='MESH'], key=lambda o:o.name):
    bm=bmesh.new(); bm.from_mesh(ob.data); bm.transform(ob.matrix_world); bm.normal_update()
    uv=bm.loops.layers.uv.active
    bm.faces.ensure_lookup_table()
    parent=list(range(len(bm.faces)))
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
    isl=defaultdict(list)
    for f in bm.faces: isl[find(f.index)].append(f)
    for k,fs in isl.items():
        polys=[[[round(l[uv].uv.x*S,2), round((1-l[uv].uv.y)*S,2)] for l in f.loops] for f in fs]
        samples=[]
        for f in fs[::max(1,len(fs)//600)]:
            u=sum((Vector((l[uv].uv.x*S,(1-l[uv].uv.y)*S)) for l in f.loops),Vector((0,0)))/len(f.loops)
            c=f.calc_center_median(); n=f.normal
            samples.append([u.x,u.y,c.x,c.y,c.z,n.x,n.y,n.z,f.calc_area()])
        out.append(dict(obj=ob.name, faces=len(fs), polys=polys, samples=samples))
    bm.free()
json.dump(out,open('islands.json','w'))
print('islands',len(out))
