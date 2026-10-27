# Area-weighted mean of max(0, N.L) over the camera-visible garment, three.js key light (2,3,4).
import bpy, sys, math
import numpy as np
from mathutils import Vector
path=sys.argv[sys.argv.index('--')+1]; mode=sys.argv[sys.argv.index('--')+2]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=path)
sc=bpy.context.scene
meshes=[o for o in sc.objects if o.type=='MESH']
lo=Vector((1e9,)*3); hi=Vector((-1e9,)*3)
for o in meshes:
    for c in o.bound_box:
        w=o.matrix_world@Vector(c); lo=Vector(map(min,lo,w)); hi=Vector(map(max,hi,w))
center=(lo+hi)/2; size=hi-lo; radius=size.length/2
L=Vector((2,-4,3)).normalized()   # three.js (2,3,4) in Blender axes
mat=bpy.data.materials.new('ndl'); mat.use_nodes=True; nt=mat.node_tree
for n in list(nt.nodes): nt.nodes.remove(n)
g=nt.nodes.new('ShaderNodeNewGeometry'); vn=nt.nodes.new('ShaderNodeVectorMath'); vn.operation='SCALE'
mix=nt.nodes.new('ShaderNodeMath'); mix.operation='MULTIPLY_ADD'  # sign = 1 - 2*backfacing
nt.links.new(g.outputs['Backfacing'],mix.inputs[0]); mix.inputs[1].default_value=-2; mix.inputs[2].default_value=1
nt.links.new(g.outputs['True Normal'],vn.inputs[0]); nt.links.new(mix.outputs[0],vn.inputs['Scale'])
dot=nt.nodes.new('ShaderNodeVectorMath'); dot.operation='DOT_PRODUCT'; dot.inputs[1].default_value=L
nt.links.new(vn.outputs[0],dot.inputs[0])
mx=nt.nodes.new('ShaderNodeMath'); mx.operation='MAXIMUM'; mx.inputs[1].default_value=0; nt.links.new(dot.outputs['Value'],mx.inputs[0])
em=nt.nodes.new('ShaderNodeEmission'); nt.links.new(mx.outputs[0],em.inputs['Strength']); em.inputs['Color'].default_value=(1,1,1,1)
out=nt.nodes.new('ShaderNodeOutputMaterial'); nt.links.new(em.outputs[0],out.inputs['Surface'])
for o in meshes:
    o.data.materials.clear(); o.data.materials.append(mat)
cam=bpy.data.cameras.new('c'); cam.lens_unit='FOV'; cam.sensor_fit='VERTICAL'; cam.angle_y=math.radians(28); cam.clip_start=0.01; cam.clip_end=100
co=bpy.data.objects.new('c',cam); sc.collection.objects.link(co); sc.camera=co
dist = radius*3.1 if mode=='sphere' else size.z/(0.9136*2*math.tan(math.radians(14)))
co.location=center+Vector((0,-dist,0)); co.rotation_euler=(math.radians(90),0,0)
sc.render.engine='CYCLES'; sc.cycles.samples=1; sc.cycles.use_denoising=False; sc.cycles.pixel_filter_type='BOX'; sc.cycles.filter_width=0.01
sc.render.resolution_x=sc.render.resolution_y=500; sc.render.film_transparent=True
sc.view_settings.view_transform='Raw' if 'Raw' in [i.identifier for i in type(sc.view_settings).bl_rna.properties['view_transform'].enum_items] else 'Standard'
sc.render.image_settings.file_format='OPEN_EXR'; sc.render.filepath='/tmp/ndl.exr'
bpy.ops.render.render(write_still=True)
img=bpy.data.images.load('/tmp/ndl.exr'); px=np.array(img.pixels[:]).reshape(-1,4)
m=px[:,3]>0.5
print('RESULT',mode,'dist',round(dist,4),'mean N.L %.4f'%px[m,0].mean(),'p5 %.3f p95 %.3f'%(np.percentile(px[m,0],5),np.percentile(px[m,0],95)),'coverage',m.mean().round(3))
