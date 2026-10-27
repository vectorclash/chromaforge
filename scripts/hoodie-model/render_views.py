# usage: blender -b -P render_views.py -- <gltf/glb path> <out prefix> [basecolor override png]
import bpy, sys, math
from mathutils import Vector
argv=sys.argv[sys.argv.index('--')+1:]
path, prefix = argv[0], argv[1]
override = argv[2] if len(argv)>2 else None
bpy.ops.wm.read_factory_settings(use_empty=True)
if path.endswith('.blend'): bpy.ops.wm.open_mainfile(filepath=path)
else: bpy.ops.import_scene.gltf(filepath=path)
sc=bpy.context.scene
meshes=[o for o in sc.objects if o.type=='MESH']
if override:
    img=bpy.data.images.load(override)
    for m in bpy.data.materials:  # NEWTEX
        if not m.use_nodes: continue
        nt=m.node_tree
        if any(n.type=='TEX_IMAGE' for n in nt.nodes): continue
        b=[n for n in nt.nodes if n.type=='BSDF_PRINCIPLED']
        if not b: continue
        t=nt.nodes.new('ShaderNodeTexImage'); t.image=img
        nt.links.new(t.outputs['Color'], b[0].inputs['Base Color'])
    for m in bpy.data.materials:
        if not m.use_nodes: continue
        for n in m.node_tree.nodes:
            if n.type=='TEX_IMAGE' and n.image and 'baseColor' in n.image.name: n.image=img
# emissive off (the model's emissive map would wash things out)
for m in bpy.data.materials:
    if m.use_nodes:
        for n in m.node_tree.nodes:
            if n.type=='BSDF_PRINCIPLED': n.inputs['Emission Strength'].default_value=0.0
lo=Vector((1e9,)*3); hi=Vector((-1e9,)*3)
for o in meshes:
    for c in o.bound_box:
        w=o.matrix_world@Vector(c); lo=Vector(map(min,lo,w)); hi=Vector(map(max,hi,w))
center=(lo+hi)/2; radius=(hi-lo).length/2
cam=bpy.data.cameras.new('cam'); cam.lens_unit='FOV'; cam.sensor_fit='VERTICAL'; cam.angle_y=math.radians(28)
co=bpy.data.objects.new('cam',cam); sc.collection.objects.link(co); sc.camera=co
cam.clip_end=radius*20
# world: soft grey
w=bpy.data.worlds.new('w'); sc.world=w; w.use_nodes=True
w.node_tree.nodes['Background'].inputs[0].default_value=(0.55,0.55,0.58,1); w.node_tree.nodes['Background'].inputs[1].default_value=1.0
sun=bpy.data.lights.new('key','SUN'); sun.energy=2.5; so=bpy.data.objects.new('key',sun); sc.collection.objects.link(so)
so.rotation_euler=(math.radians(50),0,math.radians(-30))
sc.render.engine='BLENDER_EEVEE'
sc.render.resolution_x=sc.render.resolution_y=700
sc.render.film_transparent=True
sc.view_settings.view_transform='Standard'
views={'front':0,'q34':-35,'side':-90,'back':180,'sideL':90}
for name,yaw in views.items():
    a=math.radians(yaw); d=radius*3.1
    co.location=center+Vector((math.sin(a)*d,-math.cos(a)*d,0))
    co.rotation_euler=(math.radians(90),0,a)
    sc.render.filepath=f'{prefix}-{name}.png'
    bpy.ops.render.render(write_still=True)
print('radius',radius,'center',center)
