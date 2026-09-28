import bpy, bmesh, json, sys
from collections import defaultdict
L=json.load(open('layout.json')); A=L['atlas']
def islands(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    ob=[o for o in bpy.context.scene.objects if o.type=='MESH'][0]
    bm=bmesh.new(); bm.from_mesh(ob.data); uv=bm.loops.layers.uv.active
    res=[]
    rects=[(p['key'],p['rect']) for p in L['pieces']]
    per=defaultdict(lambda:[1e9,1e9,-1e9,-1e9])
    outside=0
    for f in bm.faces:
        for l in f.loops:
            X=l[uv].uv.x*A; Y=(1-l[uv].uv.y)*A
            hit=None
            for k,(x,y,w,h) in rects:
                if x-1<=X<=x+w+1 and y-1<=Y<=y+h+1: hit=k; break
            if hit is None:
                wx,wy,ww,wh=L['white']
                if not (wx<=X<=wx+ww and wy<=Y<=wy+wh): outside+=1
                continue
            b=per[hit]; b[0]=min(b[0],X); b[1]=min(b[1],Y); b[2]=max(b[2],X); b[3]=max(b[3],Y)
    return dict(per), outside, len(bm.faces)
a,oa,fa=islands('build/hoodie-raw.glb'); b,ob_,fb=islands('build/hoodie.glb')
print('faces',fa,'->',fb,' loops outside every rect: raw',oa,'final',ob_)
worst=0
for k in a:
    d=max(abs(x-y) for x,y in zip(a[k],b[k])); worst=max(worst,d)
    print(f'{k:13s} raw {[round(v,1) for v in a[k]]}  final {[round(v,1) for v in b[k]]}  maxdiff {d:.2f}')
print('WORST bbox drift (atlas units of 2048):',round(worst,2))
