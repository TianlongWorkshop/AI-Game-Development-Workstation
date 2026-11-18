import bpy, sys, os, json
from mathutils import Vector

mode, input_path = sys.argv[sys.argv.index('--') + 1:]
with open(input_path, encoding='utf-8') as f:
    spec = json.load(f)
output = spec['output']
glb = os.path.join(output, 'rigged.glb')
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

def xyz(position):
    # glTF is Y up; Blender imports glTF into Z up.
    return Vector((position[0], -position[2], position[1]))

if mode == 'create':
    bpy.ops.import_scene.gltf(filepath=spec['asset']['path'])
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    if not meshes:
        raise RuntimeError('Source GLB has no meshes')
    if any(o.type == 'ARMATURE' for o in bpy.context.scene.objects):
        raise RuntimeError('Source already contains an armature; edit existing binding in Blender to avoid replacing it')
    armature = bpy.data.armatures.new('ManualRig')
    rig = bpy.data.objects.new('ManualRig', armature)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    joints = spec['content']['joints']
    by_id = {j['id']: j for j in joints}
    bones = {}
    for joint in joints:
        bone = armature.edit_bones.new(joint['id'])
        bone.head = xyz(joint['position'])
        children = [j for j in joints if j.get('parentId') == joint['id']]
        if children:
            tail = xyz(children[0]['position'])
        elif joint.get('parentId'):
            delta = bone.head - xyz(by_id[joint['parentId']]['position'])
            tail = bone.head + delta.normalized() * max(delta.length * .25, .025)
        else:
            tail = bone.head + Vector((0, 0, .05))
        if (tail - bone.head).length < .00001:
            raise RuntimeError('Zero length bone ' + joint['id'])
        bone.tail = tail
        bones[joint['id']] = bone
    for joint in joints:
        if joint.get('parentId'):
            bones[joint['id']].parent = bones[joint['parentId']]
    bpy.ops.object.mode_set(mode='OBJECT')
    for joint in joints:
        rig.data.bones[joint['id']]['display_name'] = joint['name']
    if spec['weights'] == 'automatic':
        bpy.ops.object.select_all(action='DESELECT')
        for mesh in meshes:
            mesh.select_set(True)
        rig.select_set(True)
        bpy.context.view_layer.objects.active = rig
        bpy.ops.object.parent_set(type='ARMATURE_AUTO')
        unweighted = sum(1 for obj in meshes for vertex in obj.data.vertices if not any(g.weight > .000001 for g in vertex.groups))
        if unweighted:
            raise RuntimeError(str(unweighted) + ' vertices lack weights; no successful skinning receipt written')
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(output, 'rigged.blend'))
    bpy.ops.export_scene.gltf(filepath=glb, export_format='GLB', export_skins=True, export_animations=False)
elif mode == 'verify':
    # Independent Blender process verifies the saved native rig and glTF import.
    bpy.ops.wm.open_mainfile(filepath=os.path.join(output, 'rigged.blend'), load_ui=False)
    rigs = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']
    if len(rigs) != 1:
        raise RuntimeError('Expected one armature in saved blend')
    rig = rigs[0]
    for joint in spec['content']['joints']:
        bone = rig.data.bones.get(joint['id'])
        if bone is None or (bone.head_local - xyz(joint['position'])).length > .0001:
            raise RuntimeError('Saved joint differs from human position: ' + joint['id'])
        if (bone.parent.name if bone.parent else None) != joint.get('parentId'):
            raise RuntimeError('Saved hierarchy differs from draft')
    bone_count = len(rig.data.bones)
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=glb)
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    rigs = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']
    weighted = sum(1 for obj in meshes for v in obj.data.vertices if any(g.weight > .000001 for g in v.groups))
    vertices = sum(len(o.data.vertices) for o in meshes)
    ok = vertices > 0 and (spec['weights'] == 'none' or (len(rigs) == 1 and weighted == vertices))
    receipt = {'ok': ok, 'bonesInBlend': bone_count, 'reimportedArmatures': len(rigs), 'vertices': vertices, 'weightedVertices': weighted, 'mode': spec['weights'], 'positionsAndHierarchyVerified': True, 'animationTested': False, 'blender': bpy.app.version_string}
    with open(os.path.join(output, 'rig-validation.json'), 'w', encoding='utf-8') as f:
        json.dump(receipt, f, ensure_ascii=False, indent=2)
    if not ok:
        raise RuntimeError('Independent skin reimport failed')
else:
    raise RuntimeError('Unknown mode')
