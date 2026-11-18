# AI 游戏开发工作站 · Blender 无头执行器
# 用法: blender -b --factory-startup --python blender_runner.py -- <config.json>
import bpy, sys, json, os, traceback, math, io, contextlib

cfg_path = sys.argv[sys.argv.index('--') + 1]
with open(cfg_path, 'r', encoding='utf-8') as f:
    CFG = json.load(f)
OUT = CFG['out_dir']
os.makedirs(OUT, exist_ok=True)
RESULT = {'ok': False, 'mode': CFG['mode'], 'blender': bpy.app.version_string, 'files': [], 'warnings': []}


def stage(t):
    print('AIGW_STAGE:' + t, flush=True)


def load_any(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == '.blend':
        bpy.ops.wm.open_mainfile(filepath=path, load_ui=False)
        return
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if ext in ('.glb', '.gltf'):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == '.fbx':
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == '.obj':
        (bpy.ops.wm.obj_import if hasattr(bpy.ops.wm, 'obj_import') else bpy.ops.import_scene.obj)(filepath=path)
    elif ext == '.stl':
        (bpy.ops.wm.stl_import if hasattr(bpy.ops.wm, 'stl_import') else bpy.ops.import_mesh.stl)(filepath=path)
    elif ext in ('.usd', '.usda', '.usdc', '.usdz'):
        bpy.ops.wm.usd_import(filepath=path)
    elif ext == '.dae':
        bpy.ops.wm.collada_import(filepath=path)
    else:
        raise RuntimeError('不支持的格式: ' + ext)


def scene_report():
    import bmesh
    dg = bpy.context.evaluated_depsgraph_get()
    objs, total_v, total_t, nonmanifold = [], 0, 0, 0
    mn, mx = [1e18] * 3, [-1e18] * 3
    for o in bpy.context.scene.objects:
        item = {'name': o.name, 'type': o.type, 'location': [round(v, 4) for v in o.location], 'scale': [round(v, 4) for v in o.scale]}
        if o.type == 'MESH':
            ev = o.evaluated_get(dg)
            me = ev.to_mesh()
            me.calc_loop_triangles()
            v, t = len(me.vertices), len(me.loop_triangles)
            bm = bmesh.new(); bm.from_mesh(me)
            nm = sum(1 for e in bm.edges if not e.is_manifold)
            bm.free()
            item.update({'vertices': v, 'triangles': t, 'nonManifoldEdges': nm, 'materials': [m.name for m in o.data.materials if m], 'uvLayers': [u.name for u in o.data.uv_layers]})
            total_v += v; total_t += t; nonmanifold += nm
            for c in o.bound_box:
                w = o.matrix_world @ __import__('mathutils').Vector(c)
                for i in range(3):
                    mn[i] = min(mn[i], w[i]); mx[i] = max(mx[i], w[i])
            ev.to_mesh_clear()
        if o.type == 'ARMATURE':
            item['bones'] = len(o.data.bones)
        if o.animation_data and o.animation_data.action:
            item['action'] = o.animation_data.action.name
        objs.append(item)
    missing = [i.name for i in bpy.data.images if i.source == 'FILE' and i.filepath and not i.packed_file and not os.path.exists(bpy.path.abspath(i.filepath))]
    dims = [round(mx[i] - mn[i], 4) for i in range(3)] if total_v else [0, 0, 0]
    return {'objects': len(objs), 'meshes': sum(1 for o in objs if o['type'] == 'MESH'), 'vertices': total_v, 'triangles': total_t,
            'nonManifoldEdges': nonmanifold, 'materials': len(bpy.data.materials), 'images': len(bpy.data.images), 'missingImages': missing[:50],
            'armatures': sum(1 for o in objs if o['type'] == 'ARMATURE'), 'actions': [a.name for a in bpy.data.actions][:50],
            'dimensions': dims, 'boundsMin': [round(v, 4) for v in mn] if total_v else None, 'objectList': objs[:200]}


def render_preview(path, size=768):
    import mathutils
    scene = bpy.context.scene
    meshes = [o for o in scene.objects if o.type == 'MESH']
    if not meshes:
        return None
    mn, mx = mathutils.Vector((1e18,) * 3), mathutils.Vector((-1e18,) * 3)
    for o in meshes:
        for c in o.bound_box:
            w = o.matrix_world @ mathutils.Vector(c)
            mn = mathutils.Vector(map(min, mn, w)); mx = mathutils.Vector(map(max, mx, w))
    center, radius = (mn + mx) / 2, max((mx - mn).length / 2, 0.01)
    cam_data = bpy.data.cameras.new('AIGW_Cam'); cam_data.lens = 50
    cam = bpy.data.objects.new('AIGW_Cam', cam_data); scene.collection.objects.link(cam)
    d = radius / math.tan(cam_data.angle / 2) * 1.15
    direction = mathutils.Vector((1, -1.2, 0.8)).normalized()
    cam.location = center + direction * d
    cam.rotation_euler = (center - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cam_data.clip_end = d * 10
    scene.camera = cam
    sun = bpy.data.objects.new('AIGW_Sun', bpy.data.lights.new('AIGW_Sun', 'SUN')); sun.data.energy = 3
    sun.rotation_euler = (0.8, 0.2, 0.6); scene.collection.objects.link(sun)
    engines = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items]
    scene.render.engine = 'BLENDER_WORKBENCH' if 'BLENDER_WORKBENCH' in engines else engines[0]
    try:
        scene.display.shading.light = 'STUDIO'; scene.display.shading.color_type = 'MATERIAL'
    except Exception:
        pass
    scene.render.resolution_x = scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    return path


try:
    mode = CFG['mode']
    if CFG.get('input'):
        stage('载入 ' + os.path.basename(CFG['input']))
        load_any(CFG['input'])
    if mode == 'script':
        stage('执行脚本')
        buf = io.StringIO()
        g = {'bpy': bpy, 'OUT_DIR': OUT, 'RESULT': RESULT, '__name__': '__aigw__'}
        with contextlib.redirect_stdout(buf):
            exec(compile(CFG['script'], 'agent_script.py', 'exec'), g)
        RESULT['stdout'] = buf.getvalue()[-20000:]
        print(RESULT['stdout'])
    if mode in ('script', 'inspect', 'convert'):
        stage('统计场景')
        RESULT['scene'] = scene_report()
    if mode == 'convert':
        out = CFG['output']; ext = os.path.splitext(out)[1].lower()
        stage('导出 ' + ext)
        if ext in ('.glb', '.gltf'):
            bpy.ops.export_scene.gltf(filepath=out, export_format='GLB' if ext == '.glb' else 'GLTF_SEPARATE', export_apply=True)
        elif ext == '.fbx':
            bpy.ops.export_scene.fbx(filepath=out, apply_scale_options='FBX_SCALE_UNITS', mesh_smooth_type='FACE', add_leaf_bones=False, path_mode='COPY', embed_textures=True)
        elif ext == '.obj':
            bpy.ops.wm.obj_export(filepath=out)
        elif ext == '.usdc' or ext == '.usd':
            bpy.ops.wm.usd_export(filepath=out)
        else:
            raise RuntimeError('不支持的导出格式: ' + ext)
        RESULT['files'].append(out)
    if CFG.get('save_blend'):
        stage('保存 .blend')
        bpy.ops.wm.save_as_mainfile(filepath=CFG['save_blend'])
        RESULT['files'].append(CFG['save_blend'])
    if CFG.get('preview'):
        stage('渲染预览')
        try:
            p = render_preview(os.path.join(OUT, 'preview.png'))
            if p:
                RESULT['files'].append(p); RESULT['preview'] = p
        except Exception as e:
            RESULT['warnings'].append('预览渲染失败: ' + str(e))
    for root, _, names in os.walk(OUT):
        for n in names:
            fp = os.path.join(root, n)
            if fp not in RESULT['files'] and not n.endswith('.json'):
                RESULT['files'].append(fp)
    RESULT['ok'] = True
except Exception as e:
    RESULT['error'] = str(e)
    RESULT['traceback'] = traceback.format_exc()[-6000:]
    print(RESULT['traceback'])
finally:
    with open(os.path.join(OUT, 'result.json'), 'w', encoding='utf-8') as f:
        json.dump(RESULT, f, ensure_ascii=False, indent=2, default=str)
    stage('完成')
sys.exit(0 if RESULT['ok'] else 1)
