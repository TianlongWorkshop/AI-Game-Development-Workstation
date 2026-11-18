import bpy, sys, json, os, math
from mathutils import Vector

args = sys.argv[sys.argv.index('--')+1:]
mode, output = args[0], os.path.realpath(args[1])
os.makedirs(output, exist_ok=True)

def note(stage):
    print('AIGW_STAGE:' + stage, flush=True)

if mode == 'verify':
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=os.path.join(output, 'asset.glb'))
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    result = {'ok': len(meshes)>0, 'meshes': len(meshes), 'vertices': sum(len(o.data.vertices) for o in meshes), 'triangles': sum(sum(len(p.vertices)-2 for p in o.data.polygons) for o in meshes), 'blender': bpy.app.version_string}
    if not result['ok'] or result['vertices'] == 0:
        raise RuntimeError('Reimport produced no mesh geometry')
    with open(os.path.join(output, 'validation.json'), 'x', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    note('验证通过')
    sys.exit(0)

bpy.ops.wm.read_factory_settings(use_empty=True)
recipe = args[2]
note('创建几何体')

def mat(name, color, rough=.7, metal=0):
    m=bpy.data.materials.new(name); m.diffuse_color=(*color,1); m.use_nodes=True
    bsdf=m.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value=(*color,1)
    bsdf.inputs['Roughness'].default_value=rough; bsdf.inputs['Metallic'].default_value=metal
    return m

wood=mat('Warm oak',(.32,.13,.045)); stone=mat('Weathered limestone',(.42,.46,.44)); steel=mat('Dark steel',(.08,.105,.12),.35,.8)
def box(name, loc, scale, material, bevel=.035):
    bpy.ops.mesh.primitive_cube_add(size=1,location=loc);o=bpy.context.object;o.name=name;o.dimensions=scale
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    o.data.materials.append(material)
    if bevel:
        b=o.modifiers.new('Soft edges','BEVEL'); b.width=bevel; b.segments=2
        o.modifiers.new('Weighted normals','WEIGHTED_NORMAL')
    return o

def cylinder(name,z,radius,depth,material,vertices=24):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices,radius=radius,depth=depth,location=(0,0,z))
    o=bpy.context.object;o.name=name;o.data.materials.append(material)
    b=o.modifiers.new('Chamfer','BEVEL');b.width=.025;b.segments=2;o.modifiers.new('Weighted normals','WEIGHTED_NORMAL')
    return o

if recipe=='crate':
    for i in range(5):
        x=-.64+i*.32
        for y in [-.78,.78]: box('Side plank', (x,y,.8), (.30,.12,1.55),wood,.018)
        box('Lid plank',(x,0,1.58),(.30,1.5,.12),wood,.018)
        box('Floor plank',(x,0,.05),(.30,1.5,.10),wood,.018)
        for side in [-1,1]: box('End plank',(side*.78,x,.8),(.12,.30,1.55),wood,.018)
    for x in [-.78,.78]:
        for y in [-.78,.78]: box('Metal corner',(x,y,.81),(.13,.13,1.72),steel,.015)
    for z in [.15,1.42]:
        for y in [-.86,.86]: box('Reinforcement',(0,y,z),(1.72,.06,.16),steel,.015)
elif recipe=='pillar':
    box('Plinth',(0,0,.12),(1.65,1.65,.24),stone)
    cylinder('Base ring',.36,.78,.24,stone)
    cylinder('Column shaft',1.65,.52,2.4,stone)
    for z in [.58,1.25,1.95,2.7]: cylinder('Collar',z,.56,.08,stone)
    cylinder('Capital ring',2.95,.72,.22,stone)
    box('Capital',(0,0,3.14),(1.55,1.55,.22),stone)
elif recipe=='blockout':
    box('Main platform',(0,0,.15),(7,5,.3),stone)
    for x in [-2.8,2.8]:
        for y in [-1.8,1.8]: box('Structural column',(x,y,1.8),(.55,.55,3.3),stone)
    for i in range(4): box('Entry step',(0,-2.6-i*.36,.12-i*.04),(2.5,.38,.24),stone,.015)
    box('Roof beam A',(0,-1.8,3.5),(6.4,.65,.35),wood)
    box('Roof beam B',(0,1.8,3.5),(6.4,.65,.35),wood)
else:
    raise RuntimeError('Unsupported recipe')

assets=[o for o in bpy.context.scene.objects if o.type=='MESH']
note('导出资产')
bpy.ops.object.select_all(action='DESELECT')
for o in assets: o.select_set(True)
bpy.context.view_layer.objects.active=assets[0]
bpy.ops.export_scene.gltf(filepath=os.path.join(output,'asset.glb'),export_format='GLB',use_selection=True,export_apply=True)

# Lighting and camera remain in the editable .blend; the GLB contains asset meshes only.
points=[o.matrix_world@Vector(p) for o in assets for p in o.bound_box]
lo=Vector([min(p[i] for p in points) for i in range(3)]); hi=Vector([max(p[i] for p in points) for i in range(3)])
center=(lo+hi)/2; span=max(hi-lo)
bpy.ops.object.camera_add(location=center+Vector((span*1.5,-span*1.8,span*1.15)))
camera=bpy.context.object;camera.rotation_euler=(center-camera.location).to_track_quat('-Z','Y').to_euler();camera.data.type='ORTHO';camera.data.ortho_scale=span*1.65;bpy.context.scene.camera=camera
for name, offset, power, size in [('Key',(2,-3,5),1000,4),('Fill',(-3,-1,2),650,3),('Rim',(1,4,4),1200,3)]:
    bpy.ops.object.light_add(type='AREA',location=center+Vector(offset)*max(span/2,1));lamp=bpy.context.object;lamp.name=name;lamp.data.energy=power*max(span/2,1)**2;lamp.data.shape='DISK';lamp.data.size=size;lamp.rotation_euler=(center-lamp.location).to_track_quat('-Z','Y').to_euler()
scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=16;scene.cycles.device='CPU'
if scene.world is None:
    scene.world=bpy.data.worlds.new('Studio world')
scene.world.color=(.18,.18,.18);scene.render.resolution_x=800;scene.render.resolution_y=640;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG';scene.render.filepath=os.path.join(output,'preview.png')
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(output,'asset.blend'))
note('渲染预览')
bpy.ops.render.render(write_still=True)
note('生成完成')
