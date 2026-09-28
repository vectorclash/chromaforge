import bpy, bmesh, json
from mathutils import Vector, kdtree
from collections import defaultdict
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath='src/scene.gltf')
S=4096
objs={o.name:o for o in bpy.context.scene.objects if o.type=='MESH'}
def world_verts(name):
    ob=objs[name]; return [ob.matrix_world@v.co for v in ob.data.vertices]
def kd_of(points):
    kd=kdtree.KDTree(len(points))
    for i,p in enumerate(points): kd.insert(p,i)
    kd.balance(); return kd
# reference sets
body=kd_of(world_verts('Object_6')+world_verts('Object_7'))
strips=kd_of(world_verts('Object_4'))  # includes strips, cuffs, drawstrings; hood strips are near the hood opening
def boundary(obname, rect):
    ob=objs[obname]
    bm=bmesh.new(); bm.from_mesh(ob.data); bm.transform(ob.matrix_world)
    uv=bm.loops.layers.uv.active
    x0,y0,w,h=rect
    faces=[]
    for f in bm.faces:
        cu=sum((l[uv].uv.x for l in f.loops))/len(f.loops)*S; cv=(1-sum((l[uv].uv.y for l in f.loops))/len(f.loops))*S
        if x0-2<=cu<=x0+w+2 and y0-2<=cv<=y0+h+2: faces.append(f)
    # UV-edge adjacency counting
    cnt=defaultdict(int); info={}
    for f in faces:
        ls=list(f.loops)
        for i,l in enumerate(ls):
            n=ls[(i+1)%len(ls)]
            a=(round(l[uv].uv.x,5),round(l[uv].uv.y,5)); b=(round(n[uv].uv.x,5),round(n[uv].uv.y,5))
            k=tuple(sorted([a,b])); cnt[k]+=1; info[k]=(l.vert.co.copy(),n.vert.co.copy())
    pts=[]
    for k,c in cnt.items():
        if c==1:
            (a,b)=k; p=(info[k][0]+info[k][1])/2
            pts.append(((a[0]+b[0])/2*S,(1-(a[1]+b[1])/2)*S,p))
    bm.free(); return pts
res={}
for key,obname,rect,other in [('hood_right_out','Object_10',[2161,1985,906,1165],'Object_11'),('hood_left_out','Object_11',[1063,2024,906,1165],'Object_10')]:
    pts=boundary(obname,rect)
    okd=kd_of(world_verts(other))
    cls=defaultdict(list)
    for u,v,p in pts:
        d_other=okd.find(p)[2]; d_body=body.find(p)[2]; d_strip=strips.find(p)[2]
        lab=min([('center_back_seam',d_other),('neckline',d_body),('opening',d_strip)],key=lambda t:t[1])
        if lab[1]>12: lab=('far',lab[1])
        cls[lab[0]].append((u,v))
    out={}
    for k,l in cls.items():
        us=[a for a,b in l]; vs=[b for a,b in l]
        out[k]=dict(n=len(l),u_mean=round(sum(us)/len(us)-rect[0]),v_mean=round(sum(vs)/len(vs)-rect[1]),u_range=[round(min(us)-rect[0]),round(max(us)-rect[0])],v_range=[round(min(vs)-rect[1]),round(max(vs)-rect[1])])
    res[key]=out
    print(key,'rect',rect)
    for k,o in out.items(): print('   ',k,o)
