# AIGW Blender Bridge · 工具实现（运行在 Blender 主线程）
# 约定：单位为米，Z 轴向上；角度对外用“度”。写操作结束后压入一个撤销步骤（Ctrl+Z 可撤回）。
import base64
import contextlib
import io
import json
import math
import os
import tempfile
import time

import bmesh
import bpy
import mathutils

from . import safety
from .server import ToolError

MAX_OBJECTS = 300


# ---------- 通用 ----------
def _num(v, name):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise ToolError("%s 必须是数字" % name)
    return float(v)


def _vec3(v, name, default=None):
    if v is None:
        return default
    if not isinstance(v, (list, tuple)) or len(v) != 3:
        raise ToolError("%s 必须是 3 个数字的数组" % name)
    return [_num(x, name) for x in v]


def _obj(name):
    if not isinstance(name, str) or not name:
        raise ToolError("缺少对象名")
    o = bpy.data.objects.get(name)
    if not o:
        raise ToolError("找不到对象「%s」。可先调用 get_scene_info 查看对象名" % name)
    return o


def _r(v, n=4):
    return [round(float(x), n) for x in v]


def _undo(msg):
    try:
        bpy.ops.ed.undo_push(message="AIGW: " + msg)
    except Exception:  # noqa: BLE001 - 后台模式没有撤销栈
        pass


def _collection():
    try:
        c = bpy.context.view_layer.active_layer_collection.collection
        if c:
            return c
    except AttributeError:
        pass
    return bpy.context.scene.collection


def _selected(o):
    try:
        return o.select_get()
    except RuntimeError:
        return False


def _view3d():
    wm = bpy.context.window_manager
    for win in getattr(wm, "windows", []):
        for area in win.screen.areas:
            if area.type == "VIEW_3D":
                region = next((r for r in area.regions if r.type == "WINDOW"), None)
                if region:
                    return win, area, region
    return None


def _override():
    v = _view3d()
    if not v:
        return contextlib.nullcontext()
    win, area, region = v
    return bpy.context.temp_override(window=win, area=area, region=region)


def _select_only(objs):
    vl = bpy.context.view_layer
    for o in vl.objects:
        try:
            o.select_set(False)
        except RuntimeError:
            pass
    for o in objs:
        try:
            o.select_set(True)
        except RuntimeError:
            pass
    if objs:
        vl.objects.active = objs[0]


def _hex_to_linear(h):
    h = h.strip().lstrip("#")
    if len(h) != 6:
        raise ToolError("颜色需为 #RRGGBB")
    try:
        srgb = [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
    except ValueError:
        raise ToolError("颜色需为 #RRGGBB") from None
    return [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]


def _color(v):
    if isinstance(v, str):
        return _hex_to_linear(v)
    c = _vec3(v, "color")
    if any(x < 0 or x > 1 for x in c):
        raise ToolError("color 数组取值 0–1（线性空间），或使用 #RRGGBB")
    return c


def _json(obj):
    return json.dumps(obj, ensure_ascii=False, indent=1)


# ---------- 只读 ----------
def get_scene_info(args):
    scene = bpy.context.scene
    limit = int(args.get("limit") or 200)
    limit = max(1, min(limit, MAX_OBJECTS))
    objs = []
    all_objs = list(scene.objects)
    for o in all_objs[:limit]:
        d = {
            "name": o.name, "type": o.type,
            "location": _r(o.location), "rotation_deg": [round(math.degrees(a), 2) for a in o.rotation_euler],
            "scale": _r(o.scale), "dimensions": _r(o.dimensions),
            "parent": o.parent.name if o.parent else None,
            "collections": [c.name for c in o.users_collection],
            "materials": [s.material.name for s in o.material_slots if s.material],
        }
        try:
            d["hidden"] = o.hide_get()
        except RuntimeError:
            pass
        if o.type == "MESH" and o.data:
            d["vertices"] = len(o.data.vertices)
            d["faces"] = len(o.data.polygons)
            d["uv_layers"] = len(o.data.uv_layers)
            d["modifiers"] = [m.type for m in o.modifiers]
        objs.append(d)
    active = bpy.context.view_layer.objects.active if bpy.context.view_layer else None
    info = {
        "file": bpy.data.filepath or "(未保存)",
        "scene": scene.name,
        "unit_system": scene.unit_settings.system, "unit_scale": scene.unit_settings.scale_length,
        "frame_range": [scene.frame_start, scene.frame_end], "fps": scene.render.fps,
        "active_object": active.name if active else None,
        "selected": [o.name for o in all_objs if _selected(o)],
        "object_count": len(all_objs), "objects": objs,
        "blender_version": bpy.app.version_string,
    }
    if len(all_objs) > limit:
        info["note"] = "仅列出前 %d 个对象" % limit
    return _json(info)


def get_material_nodes(args):
    """读取当前对象或指定材质的 Blender Shader Editor 节点和连接。"""
    names = []
    if isinstance(args.get("material_name"), str) and args.get("material_name"):
        names = [args.get("material_name")]
    else:
        active = bpy.context.view_layer.objects.active
        names = [slot.material.name for slot in (active.material_slots if active else []) if slot.material]
    result = []
    for name in names[:20]:
        mat = bpy.data.materials.get(name)
        if not mat or not mat.use_nodes:
            continue
        nodes = [{"name": n.name, "type": n.bl_idname, "label": n.label, "location": [round(n.location.x, 1), round(n.location.y, 1)]} for n in mat.node_tree.nodes]
        links = [{"from": l.from_node.name + "." + l.from_socket.name, "to": l.to_node.name + "." + l.to_socket.name} for l in mat.node_tree.links]
        result.append({"material": mat.name, "nodes": nodes, "links": links})
    return _json({"materials": result, "active_object": bpy.context.view_layer.objects.active.name if bpy.context.view_layer.objects.active else None})


def capture_viewport(args):
    width = int(args.get("width") or 1920)
    width = max(320, min(width, 7680))
    height = int(args.get("height") or 0)
    height = max(0, min(height, 4320))
    render = bool(args.get("render"))
    tmp = os.path.join(tempfile.gettempdir(), "aigw_capture_%d.png" % int(time.time() * 1000))
    method = ""
    v = _view3d()
    if v and not bpy.app.background and not render:
        win, area, region = v
        try:
            with bpy.context.temp_override(window=win, area=area, region=region):
                bpy.ops.screen.screenshot_area(filepath=tmp)
            method = "3D 视口截图"
        except Exception:  # noqa: BLE001
            method = ""
    if not method:
        method = _render_preview(tmp, width, height)
    try:
        img = bpy.data.images.load(tmp, check_existing=False)
        w, h = img.size
        if w > width:
            nh = max(1, int(h * width / w))
            img.scale(width, nh)
            img.filepath_raw = tmp
            img.file_format = "PNG"
            img.save()
            w, h = width, nh
        bpy.data.images.remove(img)
        with open(tmp, "rb") as f:
            data = base64.b64encode(f.read()).decode("ascii")
    finally:
        with contextlib.suppress(OSError):
            os.remove(tmp)
    return [
        {"type": "image", "data": data, "mimeType": "image/png"},
        {"type": "text", "text": "%s，%d×%d 像素" % (method, w, h)},
    ]


def _render_preview(path, width=1920, height=1080):
    """没有可截取的 3D 视口时（后台模式），用临时相机 + Workbench 渲染整个场景。"""
    scene = bpy.context.scene
    meshes = [o for o in scene.objects if o.type in {"MESH", "CURVE", "SURFACE", "META", "FONT"} and o.visible_get()]
    if meshes:
        pts = [o.matrix_world @ mathutils.Vector(c) for o in meshes for c in o.bound_box]
        lo = mathutils.Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
        hi = mathutils.Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    else:
        lo, hi = mathutils.Vector((-1, -1, -1)), mathutils.Vector((1, 1, 1))
    center = (lo + hi) / 2
    radius = max((hi - lo).length / 2, 0.5)
    cam_data = bpy.data.cameras.new("AIGW_TempCamera")
    cam = bpy.data.objects.new("AIGW_TempCamera", cam_data)
    scene.collection.objects.link(cam)
    direction = mathutils.Vector((1.0, -1.2, 0.8)).normalized()
    cam.location = center + direction * radius * 3.0
    cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
    cam_data.clip_end = radius * 20
    r = scene.render
    saved = (scene.camera, r.engine, r.resolution_x, r.resolution_y, r.resolution_percentage, r.filepath, r.image_settings.file_format)
    try:
        scene.camera = cam
        r.engine = "BLENDER_WORKBENCH"
        r.resolution_x, r.resolution_y, r.resolution_percentage = width, (height or round(width * 9 / 16)), 100
        r.image_settings.file_format = "PNG"
        r.filepath = path
        bpy.ops.render.render(write_still=True)
    finally:
        scene.camera, r.engine, r.resolution_x, r.resolution_y, r.resolution_percentage, r.filepath, r.image_settings.file_format = saved
        bpy.data.objects.remove(cam, do_unlink=True)
        bpy.data.cameras.remove(cam_data)
    return "后台渲染预览（Workbench，临时相机）"


def set_mode(args):
    """切换当前 Blender 对象模式，供动画工作区直接进入姿态调整。"""
    mode = str(args.get("mode") or "").upper()
    if mode not in {"OBJECT", "POSE", "EDIT"}:
        raise ToolError("mode 只能是 OBJECT、POSE 或 EDIT")
    active = bpy.context.view_layer.objects.active
    if not active:
        raise ToolError("请先在 Blender 中选择一个对象或骨架")
    if mode == "POSE" and active.type != "ARMATURE":
        raise ToolError("姿态模式需要当前选中对象是骨架；请先在 Blender 中选择骨架")
    if active.mode != mode:
        with _override():
            bpy.ops.object.mode_set(mode=mode)
    return "当前对象「%s」已切换到 %s 模式" % (active.name, {"OBJECT": "对象", "POSE": "姿态", "EDIT": "编辑"}[mode])


# ---------- 编辑 ----------
PRIMITIVES = ["cube", "uv_sphere", "ico_sphere", "cylinder", "cone", "torus", "plane", "monkey", "empty", "camera", "light_point", "light_sun", "light_area", "light_spot"]


def _mesh_from_bmesh(name, build):
    bm = bmesh.new()
    try:
        bm.loops.layers.uv.verify()
        build(bm)
        mesh = bpy.data.meshes.new(name)
        bm.to_mesh(mesh)
    finally:
        bm.free()
    return mesh


def _torus(bm, major, minor, seg_u=48, seg_v=12):
    verts = []
    for i in range(seg_u):
        u = 2 * math.pi * i / seg_u
        ring = []
        for j in range(seg_v):
            vv = 2 * math.pi * j / seg_v
            x = (major + minor * math.cos(vv)) * math.cos(u)
            y = (major + minor * math.cos(vv)) * math.sin(u)
            z = minor * math.sin(vv)
            ring.append(bm.verts.new((x, y, z)))
        verts.append(ring)
    for i in range(seg_u):
        for j in range(seg_v):
            a, b = verts[i][j], verts[(i + 1) % seg_u][j]
            c, d = verts[(i + 1) % seg_u][(j + 1) % seg_v], verts[i][(j + 1) % seg_v]
            bm.faces.new((a, b, c, d))


def create_object(args):
    kind = args.get("type")
    if kind not in PRIMITIVES:
        raise ToolError("type 需为：" + "、".join(PRIMITIVES))
    name = str(args.get("name") or kind.replace("_", " ").title().replace(" ", ""))[:63]
    size = _num(args.get("size", 2.0), "size")
    if size <= 0 or size > 10000:
        raise ToolError("size 需在 0–10000 米之间")
    loc = _vec3(args.get("location"), "location", [0.0, 0.0, 0.0])
    rot = _vec3(args.get("rotation_deg"), "rotation_deg", [0.0, 0.0, 0.0])
    scl = _vec3(args.get("scale"), "scale", [1.0, 1.0, 1.0])
    h = size / 2
    data = None
    smooth = False
    if kind == "cube":
        data = _mesh_from_bmesh(name, lambda bm: bmesh.ops.create_cube(bm, size=size, calc_uvs=True))
    elif kind == "uv_sphere":
        data = _mesh_from_bmesh(name, lambda bm: bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=16, radius=h, calc_uvs=True))
        smooth = True
    elif kind == "ico_sphere":
        data = _mesh_from_bmesh(name, lambda bm: bmesh.ops.create_icosphere(bm, subdivisions=2, radius=h, calc_uvs=True))
        smooth = True
    elif kind == "cylinder":
        data = _mesh_from_bmesh(name, lambda bm: bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=32, radius1=h, radius2=h, depth=size, calc_uvs=True))
    elif kind == "cone":
        data = _mesh_from_bmesh(name, lambda bm: bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=32, radius1=h, radius2=0.0, depth=size, calc_uvs=True))
    elif kind == "torus":
        data = _mesh_from_bmesh(name, lambda bm: _torus(bm, h * 0.75, h * 0.25))
        smooth = True
    elif kind == "plane":
        def build(bm):
            vs = [bm.verts.new((x, y, 0.0)) for x, y in ((-h, -h), (h, -h), (h, h), (-h, h))]
            bm.faces.new(vs)
        data = _mesh_from_bmesh(name, build)
    elif kind == "monkey":
        data = _mesh_from_bmesh(name, lambda bm: bmesh.ops.create_monkey(bm, calc_uvs=True))
        smooth = True
    elif kind == "camera":
        data = bpy.data.cameras.new(name)
    elif kind.startswith("light_"):
        data = bpy.data.lights.new(name, type=kind[6:].upper())
        energy = args.get("energy")
        if energy is not None:
            data.energy = _num(energy, "energy")
    if smooth and data is not None:
        for p in data.polygons:
            p.use_smooth = True
    obj = bpy.data.objects.new(name, data)
    _collection().objects.link(obj)
    obj.location = loc
    obj.rotation_euler = [math.radians(a) for a in rot]
    obj.scale = scl
    with contextlib.suppress(Exception):
        _select_only([obj])
    _undo("创建 " + obj.name)
    return "已创建 %s「%s」，位置 %s" % (kind, obj.name, _r(obj.location, 3))


def set_transform(args):
    o = _obj(args.get("name"))
    rel = bool(args.get("relative"))
    loc = _vec3(args.get("location"), "location")
    rot = _vec3(args.get("rotation_deg"), "rotation_deg")
    scl = _vec3(args.get("scale"), "scale")
    if loc is None and rot is None and scl is None:
        raise ToolError("至少提供 location、rotation_deg、scale 之一")
    if loc is not None:
        o.location = [a + b for a, b in zip(o.location, loc)] if rel else loc
    if rot is not None:
        r = [math.radians(a) for a in rot]
        o.rotation_euler = [a + b for a, b in zip(o.rotation_euler, r)] if rel else r
    if scl is not None:
        o.scale = [a * b for a, b in zip(o.scale, scl)] if rel else scl
    _undo("变换 " + o.name)
    return "「%s」位置 %s，旋转 %s°，缩放 %s" % (o.name, _r(o.location, 3), [round(math.degrees(a), 2) for a in o.rotation_euler], _r(o.scale, 3))


def rename_object(args):
    o = _obj(args.get("name"))
    new = str(args.get("new_name") or "").strip()
    if not new or len(new) > 63:
        raise ToolError("new_name 需为 1–63 个字符")
    old = o.name
    o.name = new
    _undo("重命名 " + old)
    return "已将「%s」重命名为「%s」%s" % (old, o.name, "" if o.name == new else "（名称已被占用，Blender 自动加了后缀）")


def delete_objects(args):
    names = args.get("names")
    if not isinstance(names, list) or not names or len(names) > 100:
        raise ToolError("names 需为 1–100 个对象名")
    objs = [_obj(n) for n in names]
    for o in objs:
        bpy.data.objects.remove(o, do_unlink=True)
    _undo("删除 %d 个对象" % len(objs))
    return "已删除：" + "、".join(names)


def set_material(args):
    o = _obj(args.get("name"))
    if o.type not in {"MESH", "CURVE", "SURFACE", "META", "FONT"}:
        raise ToolError("「%s」类型为 %s，不能赋材质" % (o.name, o.type))
    mname = str(args.get("material_name") or ("M_" + o.name))[:63]
    mat = bpy.data.materials.get(mname) or bpy.data.materials.new(mname)
    mat.use_nodes = True
    bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        bsdf = mat.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
    if args.get("color") is not None:
        c = _color(args["color"])
        bsdf.inputs["Base Color"].default_value = (*c, 1.0)
        mat.diffuse_color = (*c, 1.0)
    for key, sock in (("metallic", "Metallic"), ("roughness", "Roughness")):
        if args.get(key) is not None:
            val = _num(args[key], key)
            if not 0 <= val <= 1:
                raise ToolError("%s 取值 0–1" % key)
            bsdf.inputs[sock].default_value = val
            if key == "metallic":
                mat.metallic = val
            else:
                mat.roughness = val
    if args.get("emission_strength") is not None:
        s = _num(args["emission_strength"], "emission_strength")
        sock = bsdf.inputs.get("Emission Strength")
        if sock is not None:
            sock.default_value = s
            col = bsdf.inputs.get("Emission Color") or bsdf.inputs.get("Emission")
            if col is not None and args.get("color") is not None:
                col.default_value = (*_color(args["color"]), 1.0)
    slots = o.data.materials
    if args.get("replace", True):
        slots.clear()
    if mat.name not in [m.name for m in slots if m]:
        slots.append(mat)
    _undo("材质 " + mat.name)
    return "已为「%s」设置材质「%s」" % (o.name, mat.name)


def export_model(args):
    path = args.get("path")
    if not isinstance(path, str) or not os.path.isabs(path):
        raise ToolError("path 必须是绝对路径，例如 D:/MyGame/Exports/SM_Crate.fbx")
    ext = os.path.splitext(path)[1].lower()
    if ext not in {".fbx", ".glb", ".gltf"}:
        raise ToolError("只支持导出 .fbx / .glb / .gltf")
    parent = os.path.dirname(path)
    if not os.path.isdir(os.path.dirname(parent) or parent):
        raise ToolError("上级目录不存在：%s" % parent)
    os.makedirs(parent, exist_ok=True)
    names = args.get("objects")
    if names:
        if not isinstance(names, list) or len(names) > 200:
            raise ToolError("objects 需为对象名数组（最多 200 个）")
        objs = [_obj(n) for n in names]
    else:
        objs = [o for o in bpy.context.scene.objects if _selected(o)] or [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not objs:
        raise ToolError("没有可导出的对象")
    backup = None
    if os.path.exists(path):
        if not args.get("overwrite"):
            raise ToolError("文件已存在：%s。如需覆盖请设置 overwrite=true（会先自动备份旧文件）" % path)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        backup = os.path.splitext(path)[0] + ".bak-" + stamp + ext
        os.replace(path, backup)
    with _override():
        _select_only(objs)
        if ext == ".fbx":
            bpy.ops.export_scene.fbx(
                filepath=path, use_selection=True, apply_unit_scale=True, apply_scale_options="FBX_SCALE_UNITS",
                axis_forward="-Z", axis_up="Y", use_mesh_modifiers=True, mesh_smooth_type="FACE",
                add_leaf_bones=False, bake_anim=bool(args.get("include_animation")), path_mode="AUTO")
        else:
            bpy.ops.export_scene.gltf(filepath=path, use_selection=True, export_format="GLB" if ext == ".glb" else "GLTF_SEPARATE", export_apply=True)
    if not os.path.exists(path):
        raise ToolError("导出命令已执行但没有生成文件")
    size = os.path.getsize(path)
    return "已导出 %d 个对象到 %s（%.1f KB）%s" % (len(objs), path, size / 1024, "；旧文件已备份为 " + backup if backup else "")


def run_python(args):
    code = args.get("code")
    try:
        tree = safety.check(code)
    except safety.UnsafeCode as e:
        raise ToolError("脚本未通过安全检查：%s" % e) from None
    out = io.StringIO()

    def _print(*a, **k):
        k.pop("file", None)
        print(*a, file=out, **k)

    ns = {"__builtins__": safety.restricted_builtins(_print), "__name__": "aigw_script", "bpy": bpy, "bmesh": bmesh, "mathutils": mathutils, "math": math, "Vector": mathutils.Vector}
    try:
        exec(compile(tree, "<aigw_script>", "exec"), ns)  # noqa: S102 - 已经过静态检查与用户审批
    except Exception as e:  # noqa: BLE001
        raise ToolError("脚本运行出错：%s: %s\n已有输出：%s" % (type(e).__name__, e, out.getvalue()[-2000:])) from None
    finally:
        _undo("执行脚本")
    text = out.getvalue()
    if "result" in ns:
        text += ("\n" if text else "") + "result = " + repr(ns["result"])[:4000]
    return text[-8000:] or "脚本已执行（无输出）"


# ---------- 工具清单 ----------
_vec = {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 3}
TOOLS = [
    {"name": "get_scene_info", "title": "读取场景", "fn": get_scene_info,
     "description": "读取当前 Blender 场景：对象名、类型、位置、旋转（度）、缩放、尺寸、材质、面数、选中与激活对象。单位米，Z 轴向上。修改任何对象前先调用它确认对象名。",
     "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer", "description": "最多列出的对象数，默认 200"}}},
     "annotations": {"readOnlyHint": True}},
    {"name": "get_material_nodes", "title": "读取材质节点", "fn": get_material_nodes,
     "description": "读取当前 Blender 对象材质的 Shader Editor 节点、位置和连接，用于材质工作区检查与 AI 建议。",
     "inputSchema": {"type": "object", "properties": {"material_name": {"type": "string"}}},
     "annotations": {"readOnlyHint": True}},
    {"name": "capture_viewport", "title": "视口截图", "fn": capture_viewport, "timeout": 120,
     "description": "截取 Blender 3D 视口（后台模式下改为临时相机渲染），返回 PNG 图像，用于确认修改效果。",
     "inputSchema": {"type": "object", "properties": {"width": {"type": "integer", "description": "最大宽度像素，320–7680，默认 1920"}, "height": {"type": "integer", "description": "渲染预览高度，0 表示按 16:9 计算"}, "render": {"type": "boolean", "description": "强制使用高清 Workbench 渲染，而不是当前窗口截图"}}},
     "annotations": {"readOnlyHint": True}},
    {"name": "set_mode", "title": "切换对象 / 姿态模式", "fn": set_mode,
     "description": "切换当前选中 Blender 对象的对象模式、姿态模式或编辑模式。姿态模式要求当前选中骨架。",
     "inputSchema": {"type": "object", "required": ["mode"], "properties": {"mode": {"type": "string", "enum": ["OBJECT", "POSE", "EDIT"]}}}},
    {"name": "create_object", "title": "创建对象", "fn": create_object,
     "description": "创建基础物体：cube、uv_sphere、ico_sphere、cylinder、cone、torus、plane、monkey、empty、camera、light_point/sun/area/spot。可指定名称、尺寸（米）、位置、旋转（度）、缩放。",
     "inputSchema": {"type": "object", "required": ["type"], "properties": {
         "type": {"type": "string", "enum": PRIMITIVES}, "name": {"type": "string"},
         "size": {"type": "number", "description": "边长或直径（米），默认 2"},
         "location": _vec, "rotation_deg": _vec, "scale": _vec,
         "energy": {"type": "number", "description": "灯光功率（瓦），仅灯光"}}}},
    {"name": "set_transform", "title": "移动 / 旋转 / 缩放", "fn": set_transform,
     "description": "设置对象的位置、旋转（度）或缩放。relative=true 时在现有值上叠加（缩放为相乘）。",
     "inputSchema": {"type": "object", "required": ["name"], "properties": {
         "name": {"type": "string"}, "location": _vec, "rotation_deg": _vec, "scale": _vec, "relative": {"type": "boolean"}}}},
    {"name": "rename_object", "title": "重命名对象", "fn": rename_object,
     "description": "重命名对象，例如按游戏资产规范改为 SM_Crate_01。",
     "inputSchema": {"type": "object", "required": ["name", "new_name"], "properties": {"name": {"type": "string"}, "new_name": {"type": "string"}}}},
    {"name": "set_material", "title": "设置材质", "fn": set_material,
     "description": "为网格对象创建或复用 Principled BSDF 材质并赋予。color 用 #RRGGBB（sRGB）；metallic、roughness 取 0–1；可设 emission_strength。replace 默认 true（替换已有材质槽）。",
     "inputSchema": {"type": "object", "required": ["name"], "properties": {
         "name": {"type": "string", "description": "对象名"}, "material_name": {"type": "string"},
         "color": {"type": "string", "description": "#RRGGBB"}, "metallic": {"type": "number"}, "roughness": {"type": "number"},
         "emission_strength": {"type": "number"}, "replace": {"type": "boolean"}}}},
    {"name": "export_model", "title": "导出模型", "fn": export_model, "timeout": 300,
     "description": "导出对象为 FBX（推荐给 UE，单位与轴向已按 UE 习惯设置）或 GLB/glTF。path 为绝对路径；objects 不填时导出选中对象，没有选中则导出全部网格。文件已存在时需 overwrite=true，并会先备份旧文件。",
     "inputSchema": {"type": "object", "required": ["path"], "properties": {
         "path": {"type": "string"}, "objects": {"type": "array", "items": {"type": "string"}},
         "overwrite": {"type": "boolean"}, "include_animation": {"type": "boolean"}}}},
    {"name": "delete_objects", "title": "删除对象", "fn": delete_objects,
     "description": "从场景删除指定对象（可在 Blender 中撤销）。",
     "inputSchema": {"type": "object", "required": ["names"], "properties": {"names": {"type": "array", "items": {"type": "string"}}}},
     "annotations": {"destructiveHint": True}},
    {"name": "run_python", "title": "执行 Python 脚本", "fn": run_python, "timeout": 120,
     "description": "在 Blender 中执行一段 Python（可用 bpy、bmesh、mathutils、math），用于其他工具覆盖不到的操作。每次都需要用户审批；禁止文件删除、子进程、网络与保存/退出 Blender。打印输出或设置变量 result 返回结果。",
     "inputSchema": {"type": "object", "required": ["code"], "properties": {"code": {"type": "string"}}}},
]

