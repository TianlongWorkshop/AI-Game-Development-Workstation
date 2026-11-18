# AIGW Unreal Bridge · 编辑器工具（全部在游戏线程执行）
# 约定：长度单位厘米，Z 轴向上，X 轴向前；旋转用度，顺序 [X 翻滚 Roll, Y 俯仰 Pitch, Z 偏航 Yaw]，与细节面板一致。
import base64
import io
import json
import math
import os
import re
import tempfile
import time

import unreal

from . import safety
from .server import Deferred, ToolError

INSTRUCTIONS = (
    "你正在通过 AIGW Unreal Bridge 操作 Unreal Editor。约定：长度单位厘米，Z 轴向上；旋转为度，顺序 [Roll(X), Pitch(Y), Yaw(Z)]，"
    "与细节面板一致。修改前先用 get_level_info 确认 Actor 名称；改完用 capture_viewport（可先 focus_viewport 对准目标）截图核对。"
    "多步修改请先 begin_undo_group，结束后 end_undo_group，这样用户按一次 Ctrl+Z 即可整体撤销。PIE 运行中不能编辑关卡。"
    "新建的材质实例、导入的资产默认放在 /Game/AIGW 下，不会自动保存，需要用户确认后再保存。"
)

SHAPES = {"cube": "Cube", "sphere": "Sphere", "cylinder": "Cylinder", "cone": "Cone", "plane": "Plane"}
CLASSES = {
    "point_light": "PointLight", "spot_light": "SpotLight", "directional_light": "DirectionalLight", "rect_light": "RectLight",
    "sky_light": "SkyLight", "camera": "CameraActor", "player_start": "PlayerStart", "fog": "ExponentialHeightFog",
    "sky_atmosphere": "SkyAtmosphere", "post_process_volume": "PostProcessVolume", "text": "TextRenderActor",
}
SPAWN_TYPES = sorted(list(SHAPES) + list(CLASSES))
MATERIAL_DIR = "/Game/AIGW/Materials"
IMPORT_DIR = "/Game/AIGW/Imported"
UNDO_GROUP_IDLE = 300.0

UE_ALLOWED_IMPORTS = {
    "unreal", "math", "random", "json", "re", "itertools", "collections", "functools", "statistics", "colorsys", "time",
    "datetime", "string", "typing", "dataclasses", "enum", "copy",
}
UE_BLOCKED_CALLS = set(safety.BLOCKED_CALLS) | {
    "save_current_level", "save_all_dirty_levels", "save_dirty_packages", "save_asset", "save_directory", "save_loaded_asset",
    "save_loaded_assets", "save_packages", "save_map", "delete_asset", "delete_directory", "delete_loaded_asset",
    "delete_loaded_assets", "rename_asset", "rename_directory", "rename_assets", "consolidate_assets", "execute_console_command",
    "quit_editor", "request_exit", "close_editor", "load_level", "new_level", "new_level_from_template", "load_module",
    "import_asset_tasks", "export_assets", "run_commandlet",
}


# ---------- 基础 ----------
def _sub(cls):
    return unreal.get_editor_subsystem(cls)


def _eas():
    return _sub(unreal.EditorActorSubsystem)


def _les():
    return _sub(unreal.LevelEditorSubsystem)


def _ues():
    return _sub(unreal.UnrealEditorSubsystem)


def _world():
    return _ues().get_editor_world()


def _in_pie():
    try:
        return bool(_les().is_in_play_in_editor())
    except Exception:  # noqa: BLE001
        return _ues().get_game_world() is not None


def _no_pie():
    if _in_pie():
        raise ToolError("PIE 正在运行，不能编辑关卡。请先调用 pie（action=stop）")


def _num(v, name):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise ToolError("%s 需为有限数字" % name)
    return float(v)


def _vec3(v, name, default=None):
    if v is None:
        return default
    if not isinstance(v, (list, tuple)) or len(v) != 3:
        raise ToolError("%s 需为 3 个数字的数组" % name)
    return [_num(x, name) for x in v]


def _r(x, n=2):
    return round(float(x), n)


def _loc(a):
    v = a.get_actor_location()
    return [_r(v.x), _r(v.y), _r(v.z)]


def _rot(a):
    r = a.get_actor_rotation()
    return [_r(r.roll), _r(r.pitch), _r(r.yaw)]


def _scale(a):
    s = a.get_actor_scale3d()
    return [_r(s.x, 3), _r(s.y, 3), _r(s.z, 3)]


def _rotator(v):
    return unreal.Rotator(roll=v[0], pitch=v[1], yaw=v[2])


def _actors():
    return [a for a in _eas().get_all_level_actors() if a]


def _find(name):
    if not isinstance(name, str) or not name.strip():
        raise ToolError("需要 Actor 名称")
    acts = _actors()
    hits = [a for a in acts if a.get_actor_label() == name] or [a for a in acts if a.get_name() == name] or [a for a in acts if a.get_path_name() == name]
    if not hits:
        raise ToolError("找不到 Actor「%s」。可先调用 get_level_info 查看名称" % name)
    if len(hits) > 1:
        raise ToolError("有 %d 个 Actor 都叫「%s」，请改用 get_level_info 返回的 name（内部名）" % (len(hits), name))
    return hits[0]


def _mesh_comp(a):
    try:
        return a.get_component_by_class(unreal.StaticMeshComponent)
    except Exception:  # noqa: BLE001
        return None


def _hex_to_linear(h):
    m = re.fullmatch(r"#?([0-9a-fA-F]{6})", str(h or "").strip())
    if not m:
        raise ToolError("颜色需为 #RRGGBB")
    out = []
    for i in (0, 2, 4):
        c = int(m.group(1)[i:i + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return unreal.LinearColor(out[0], out[1], out[2], 1.0)


def _asset_class(path):
    try:
        ad = unreal.EditorAssetLibrary.find_asset_data(path)
        if hasattr(ad, "asset_class_path"):
            return str(ad.asset_class_path.asset_name)
        return str(ad.asset_class)
    except Exception:  # noqa: BLE001
        return "?"


def _safe_name(s, fallback):
    s = re.sub(r"[^A-Za-z0-9_]", "_", str(s or ""))[:60].strip("_")
    return s or fallback


def _content_path(p, default):
    p = str(p or default).strip().rstrip("/")
    if not re.fullmatch(r"/Game(/[A-Za-z0-9_\-]+)*", p):
        raise ToolError("目标目录需为 /Game 开头、只含字母数字下划线的路径，例如 %s" % default)
    return p


class _Txn:
    """把一次工具调用放进一个编辑器事务（Ctrl+Z 一次撤销）。"""

    def __init__(self, desc):
        self.desc = desc
        self.t = None

    def __enter__(self):
        mark_activity()
        self.t = unreal.ScopedEditorTransaction("AIGW: " + self.desc)
        self.t.__enter__()
        return self

    def __exit__(self, *exc):
        return self.t.__exit__(*exc)


# ---------- 撤销分组 ----------
_group = {"open": False, "desc": "", "last": 0.0, "steps": 0}


def mark_activity():
    if _group["open"]:
        _group["last"] = time.monotonic()
        _group["steps"] += 1


def close_undo_group():
    if _group["open"]:
        _group["open"] = False
        unreal.SystemLibrary.end_transaction()
        return True
    return False


def on_tick():
    if _group["open"] and time.monotonic() - _group["last"] > UNDO_GROUP_IDLE:
        close_undo_group()
        unreal.log_warning("AIGW Bridge：撤销分组空闲超过 %d 秒，已自动结束" % UNDO_GROUP_IDLE)


def begin_undo_group(args):
    desc = str(args.get("description") or "AI 修改").strip()[:80]
    if _group["open"]:
        raise ToolError("已有未结束的撤销分组「%s」，请先 end_undo_group" % _group["desc"])
    _no_pie()
    unreal.SystemLibrary.begin_transaction("AIGW", "AIGW: " + desc, None)
    _group.update(open=True, desc=desc, last=time.monotonic(), steps=0)
    return "已开始撤销分组「%s」。之后的修改在 end_undo_group 后会合并为一次撤销（空闲 %d 秒自动结束）" % (desc, UNDO_GROUP_IDLE)


def end_undo_group(_args):
    if not _group["open"]:
        return "当前没有打开的撤销分组"
    desc, steps = _group["desc"], _group["steps"]
    close_undo_group()
    return "撤销分组「%s」已结束，包含 %d 步操作；在 UE 中按一次 Ctrl+Z 即可整体撤销" % (desc, steps)


def undo(args):
    _no_pie()
    n = int(_num(args.get("steps", 1), "steps"))
    if n < 1 or n > 20:
        raise ToolError("steps 需为 1–20")
    closed = close_undo_group()
    w = _world()
    for _ in range(n):
        unreal.SystemLibrary.execute_console_command(w, "TRANSACTION UNDO")
    return "已撤销 %d 步%s" % (n, "（先结束了未关闭的撤销分组）" if closed else "")


def redo(args):
    _no_pie()
    n = int(_num(args.get("steps", 1), "steps"))
    if n < 1 or n > 20:
        raise ToolError("steps 需为 1–20")
    w = _world()
    for _ in range(n):
        unreal.SystemLibrary.execute_console_command(w, "TRANSACTION REDO")
    return "已重做 %d 步" % n


# ---------- 读取 ----------
def _project_file():
    p = str(unreal.Paths.get_project_file_path())
    try:
        return os.path.normpath(str(unreal.Paths.convert_relative_path_to_full(p)))
    except Exception:  # noqa: BLE001
        return os.path.abspath(p)


def _compact(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def get_level_info(args):
    limit = int(_num(args.get("limit", 60), "limit"))
    if not 1 <= limit <= 500:
        raise ToolError("limit 需为 1–500")
    flt = str(args.get("class_filter") or "").lower()
    nflt = str(args.get("name_filter") or "").lower()
    w = _world()
    acts = _actors()
    sel = set(a.get_name() for a in (_eas().get_selected_level_actors() or []))
    counts = {}
    items = []
    matched = 0
    for a in acts:
        cls = a.get_class().get_name()
        counts[cls] = counts.get(cls, 0) + 1
        label = a.get_actor_label()
        if flt and flt not in cls.lower():
            continue
        if nflt and nflt not in label.lower() and nflt not in a.get_name().lower():
            continue
        matched += 1
        if len(items) >= limit:
            continue
        it = {"label": label, "name": a.get_name(), "class": cls, "loc": _loc(a)}
        rot, scl = _rot(a), _scale(a)
        if any(rot):
            it["rot"] = rot
        if scl != [1.0, 1.0, 1.0]:
            it["scale"] = scl
        folder = str(a.get_folder_path())
        if folder and folder != "None":
            it["folder"] = folder
        mc = _mesh_comp(a)
        if mc:
            sm = mc.static_mesh
            if sm:
                it["mesh"] = sm.get_path_name().split(".")[0]
            mats = [m.get_path_name().split(".")[0] for m in (mc.get_materials() or []) if m]
            if mats:
                it["materials"] = mats[:4]
        if a.get_name() in sel:
            it["selected"] = True
        items.append(it)
    level_path = w.get_path_name().split(".")[0] if w else ""
    info = {
        "project": _project_file(),
        "engine": str(unreal.SystemLibrary.get_engine_version()),
        "level": w.get_name() if w else None,
        "level_path": level_path,
        "unsaved_new_level": level_path.startswith("/Temp/"),
        "pie_running": _in_pie(),
        "undo_group": _group["desc"] if _group["open"] else None,
        "actor_count": len(acts),
        "class_counts": dict(sorted(counts.items(), key=lambda kv: -kv[1])[:20]),
        "matched": matched,
        "listed": len(items),
        "note": "loc 为位置(cm)，rot 为 [Roll,Pitch,Yaw] 度；未列出的旋转为 0、缩放为 1。" + ("结果被 limit 截断，可用 class_filter / name_filter 缩小范围。" if matched > len(items) else ""),
        "actors": items,
    }
    return _compact(info)


def list_assets(args):
    path = _content_path(args.get("path"), "/Game")
    limit = int(_num(args.get("limit", 200), "limit"))
    flt = str(args.get("class_filter") or "").lower()
    paths = unreal.EditorAssetLibrary.list_assets(path, bool(args.get("recursive", True)), False)
    out = []
    for p in paths:
        p = str(p)
        cls = _asset_class(p)
        if flt and flt not in cls.lower():
            continue
        out.append({"path": p.split(".")[0], "class": cls})
        if len(out) >= limit:
            break
    return _compact({"path": path, "total_in_folder": len(paths), "listed": len(out), "assets": out})


# ---------- 截图 ----------
def _shot_dirs():
    base = str(unreal.Paths.project_saved_dir())
    return [os.path.join(base, "Screenshots")]


def _find_shot(stem, abs_path):
    if os.path.exists(abs_path):
        return abs_path
    for d in _shot_dirs():
        for root, _dirs, files in os.walk(d):
            for f in files:
                if f.startswith(stem):
                    return os.path.join(root, f)
    return None


def capture_viewport(args):
    w = int(_num(args.get("width", 1280), "width"))
    h = int(_num(args.get("height", round(w * 9 / 16)), "height"))
    if not (320 <= w <= 3840 and 180 <= h <= 2160):
        raise ToolError("width 需为 320–3840，height 需为 180–2160")
    stem = "AIGW_%d_%04d" % (int(time.time()), int(time.monotonic() * 1000) % 10000)
    target = os.path.join(tempfile.gettempdir(), stem + ".png")
    pie = _in_pie()
    method = "automation"
    try:
        unreal.AutomationLibrary.take_high_res_screenshot(w, h, target)
    except Exception:  # noqa: BLE001 - 回退到控制台命令
        method = "console"
        world = _ues().get_game_world() if pie else _world()
        unreal.SystemLibrary.execute_console_command(world, "HighResShot %dx%d filename=\"%s\"" % (w, h, target.replace("\\", "/")))
    state = {"path": None, "size": -1, "stable": 0}

    def poll():
        p = state["path"] or _find_shot(stem, target)
        if not p:
            return None
        state["path"] = p
        size = os.path.getsize(p)
        if size <= 0 or size != state["size"]:
            state["size"], state["stable"] = size, 0
            return None
        state["stable"] += 1
        if state["stable"] < 2:
            return None
        with open(p, "rb") as f:
            data = f.read()
        try:
            os.remove(p)
        except OSError:
            pass
        if data[:8] != b"\x89PNG\r\n\x1a\n":
            raise ToolError("截图文件不是 PNG")
        return [
            {"type": "image", "data": base64.b64encode(data).decode("ascii"), "mimeType": "image/png"},
            {"type": "text", "text": "%s截图 %d×%d（%s）" % ("PIE 游戏画面" if pie else "关卡视口", w, h, method)},
        ]

    return Deferred(poll, timeout=30, what="截图（视口可能被最小化或未渲染）")


def focus_viewport(args):
    name = args.get("name")
    if name:
        a = _find(name)
        origin, extent = a.get_actor_bounds(False)
        radius = max(extent.x, extent.y, extent.z, 50.0)
    else:
        loc = _vec3(args.get("target"), "target", [0.0, 0.0, 0.0])
        origin, radius = unreal.Vector(*loc), 300.0
    dist = _num(args.get("distance", radius * 3.5 + 150), "distance")
    d = unreal.Vector(-0.62, -0.55, 0.56)
    cam = unreal.Vector(origin.x + d.x * dist, origin.y + d.y * dist, origin.z + d.z * dist)
    rot = unreal.MathLibrary.find_look_at_rotation(cam, origin)
    _ues().set_level_viewport_camera_info(cam, rot)
    return "视口相机已对准 %s，位置 [%.0f, %.0f, %.0f]" % (name or "目标点", cam.x, cam.y, cam.z)


# ---------- 修改 ----------
def _class(key):
    cls = getattr(unreal, CLASSES[key], None)
    if cls is None:
        raise ToolError("当前引擎没有 %s 类" % CLASSES[key])
    return cls


def _apply_color(a, color):
    mc = _mesh_comp(a)
    if not mc:
        raise ToolError("「%s」没有静态网格组件，不能设置颜色" % a.get_actor_label())
    lin = _hex_to_linear(color)
    hexs = str(color).lstrip("#").upper()
    name = "MI_AIGW_%s" % hexs
    path = MATERIAL_DIR + "/" + name
    if unreal.EditorAssetLibrary.does_asset_exist(path):
        mi = unreal.load_asset(path)
    else:
        parent = unreal.load_asset("/Engine/BasicShapes/BasicShapeMaterial")
        tools = unreal.AssetToolsHelpers.get_asset_tools()
        mi = tools.create_asset(name, MATERIAL_DIR, unreal.MaterialInstanceConstant, unreal.MaterialInstanceConstantFactoryNew())
        if not mi:
            raise ToolError("创建材质实例失败：" + path)
        unreal.MaterialEditingLibrary.set_material_instance_parent(mi, parent)
        unreal.MaterialEditingLibrary.set_material_instance_vector_parameter_value(mi, "Color", lin)
        unreal.MaterialEditingLibrary.update_material_instance(mi)
    n = max(1, mc.get_num_materials())
    for i in range(n):
        mc.set_material(i, mi)
    return path


def spawn_actor(args):
    _no_pie()
    kind = args.get("type")
    asset_path = args.get("asset")
    loc = _vec3(args.get("location"), "location", [0.0, 0.0, 0.0])
    rot = _vec3(args.get("rotation_deg"), "rotation_deg", [0.0, 0.0, 0.0])
    scl = _vec3(args.get("scale"), "scale")
    label = args.get("label")
    if label is not None and (not isinstance(label, str) or not 1 <= len(label.strip()) <= 63):
        raise ToolError("label 需为 1–63 个字符")
    if not kind and not asset_path:
        raise ToolError("需要 type（%s）或 asset（如 /Game/AIGW/Imported/SM_Crate）" % "、".join(SPAWN_TYPES))
    if kind and kind not in SHAPES and kind not in CLASSES:
        raise ToolError("type 需为：" + "、".join(SPAWN_TYPES))
    with _Txn("生成 " + (label or kind or asset_path)):
        eas = _eas()
        if asset_path:
            if not unreal.EditorAssetLibrary.does_asset_exist(asset_path):
                raise ToolError("资产不存在：%s。可先用 list_assets 查找" % asset_path)
            obj = unreal.load_asset(asset_path)
            if isinstance(obj, unreal.Blueprint):
                a = eas.spawn_actor_from_class(obj.generated_class(), unreal.Vector(*loc), _rotator(rot))
            else:
                a = eas.spawn_actor_from_object(obj, unreal.Vector(*loc), _rotator(rot))
        elif kind in SHAPES:
            a = eas.spawn_actor_from_class(unreal.StaticMeshActor, unreal.Vector(*loc), _rotator(rot))
            if a:
                mesh = unreal.load_asset("/Engine/BasicShapes/" + SHAPES[kind])
                a.static_mesh_component.set_static_mesh(mesh)
        else:
            a = eas.spawn_actor_from_class(_class(kind), unreal.Vector(*loc), _rotator(rot))
        if not a:
            raise ToolError("生成失败（编辑器返回空）")
        if scl:
            a.set_actor_scale3d(unreal.Vector(*scl))
        if label:
            a.set_actor_label(label.strip())
        a.set_folder_path(str(args.get("folder") or "AIGW"))
        if args.get("intensity") is not None and kind in ("point_light", "spot_light", "directional_light", "rect_light", "sky_light"):
            comp = a.get_component_by_class(unreal.LightComponentBase)
            if comp:
                comp.set_editor_property("intensity", _num(args.get("intensity"), "intensity"))
        if args.get("text") is not None and kind == "text":
            a.text_render.set_text(str(args.get("text"))[:200])
        mat = _apply_color(a, args["color"]) if args.get("color") else None
    return "已生成 %s「%s」（内部名 %s），位置 %s cm%s" % (a.get_class().get_name(), a.get_actor_label(), a.get_name(), _loc(a), "，材质 " + mat if mat else "")


def set_actor_transform(args):
    _no_pie()
    a = _find(args.get("name"))
    rel = bool(args.get("relative"))
    loc = _vec3(args.get("location"), "location")
    rot = _vec3(args.get("rotation_deg"), "rotation_deg")
    scl = _vec3(args.get("scale"), "scale")
    if loc is None and rot is None and scl is None:
        raise ToolError("至少提供 location、rotation_deg、scale 之一")
    with _Txn("变换 " + a.get_actor_label()):
        a.modify()
        if loc is not None:
            cur = _loc(a)
            v = [c + d for c, d in zip(cur, loc)] if rel else loc
            a.set_actor_location(unreal.Vector(*v), False, False)
        if rot is not None:
            cur = _rot(a)
            v = [c + d for c, d in zip(cur, rot)] if rel else rot
            a.set_actor_rotation(_rotator(v), False)
        if scl is not None:
            cur = _scale(a)
            v = [c * d for c, d in zip(cur, scl)] if rel else scl
            a.set_actor_scale3d(unreal.Vector(*v))
    return "「%s」位置 %s cm，旋转 %s°，缩放 %s" % (a.get_actor_label(), _loc(a), _rot(a), _scale(a))


def set_actor_label(args):
    _no_pie()
    a = _find(args.get("name"))
    new = str(args.get("new_label") or "").strip()
    if not 1 <= len(new) <= 63:
        raise ToolError("new_label 需为 1–63 个字符")
    old = a.get_actor_label()
    with _Txn("重命名 " + old):
        a.set_actor_label(new)
    return "已将「%s」改名为「%s」" % (old, a.get_actor_label())


def set_actor_color(args):
    _no_pie()
    a = _find(args.get("name"))
    with _Txn("设置颜色 " + a.get_actor_label()):
        a.modify()
        path = _apply_color(a, args.get("color"))
    return "已为「%s」设置材质实例 %s（未保存，可在内容浏览器中保存）" % (a.get_actor_label(), path)


def delete_actors(args):
    _no_pie()
    names = args.get("names")
    if not isinstance(names, list) or not names or len(names) > 100:
        raise ToolError("names 需为 1–100 个 Actor 名称")
    acts = [_find(n) for n in names]
    labels = [a.get_actor_label() for a in acts]
    with _Txn("删除 %d 个 Actor" % len(acts)):
        ok = _eas().destroy_actors(acts)
    if not ok:
        raise ToolError("编辑器拒绝删除（可能被引用或锁定）")
    return "已删除：" + "、".join(labels) + "（可撤销）"


def import_asset(args):
    _no_pie()
    f = str(args.get("file") or "")
    if not os.path.isabs(f) or not os.path.isfile(f):
        raise ToolError("file 需为存在的绝对路径")
    ext = os.path.splitext(f)[1].lower()
    if ext not in (".fbx", ".glb", ".gltf", ".obj"):
        raise ToolError("只支持 FBX / GLB / glTF / OBJ")
    dest = _content_path(args.get("destination"), IMPORT_DIR)
    name = _safe_name(args.get("name") or os.path.splitext(os.path.basename(f))[0], "SM_Imported")
    target = dest + "/" + name
    replace = bool(args.get("replace"))
    if unreal.EditorAssetLibrary.does_asset_exist(target) and not replace:
        raise ToolError("资产已存在：%s。如需覆盖请设置 replace=true" % target)
    task = unreal.AssetImportTask()
    task.set_editor_property("filename", f)
    task.set_editor_property("destination_path", dest)
    task.set_editor_property("destination_name", name)
    task.set_editor_property("automated", True)
    task.set_editor_property("save", False)
    task.set_editor_property("replace_existing", replace)
    if ext == ".fbx" and hasattr(unreal, "FbxImportUI"):
        ui = unreal.FbxImportUI()
        ui.set_editor_property("import_mesh", True)
        ui.set_editor_property("import_as_skeletal", False)
        ui.set_editor_property("import_animations", False)
        ui.set_editor_property("import_materials", True)
        ui.set_editor_property("import_textures", True)
        ui.set_editor_property("mesh_type_to_import", unreal.FBXImportType.FBXIT_STATIC_MESH)
        try:
            ui.static_mesh_import_data.set_editor_property("combine_meshes", True)
        except Exception:  # noqa: BLE001
            pass
        task.set_editor_property("options", ui)
    t0 = time.time()
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    paths = [str(p).split(".")[0] for p in (task.get_editor_property("imported_object_paths") or [])]
    if not paths:
        found = unreal.EditorAssetLibrary.list_assets(dest, False, False)
        paths = [str(p).split(".")[0] for p in found if os.path.basename(str(p)).split(".")[0].startswith(name)]
    if not paths:
        raise ToolError("导入没有产生资产，请查看 UE 输出日志（Interchange / FBX）")
    detail = ["%s（%s）" % (p, _asset_class(p)) for p in paths[:20]]
    msg = "已导入 %d 个资产，用时 %.1f 秒（未保存）：%s" % (len(paths), time.time() - t0, "；".join(detail))
    if args.get("spawn"):
        mesh = next((p for p in paths if _asset_class(p) == "StaticMesh"), None)
        if mesh:
            msg += "\n" + spawn_actor({"asset": mesh, "location": args.get("location"), "label": args.get("label") or name})
    return msg


def pie(args):
    action = args.get("action")
    les = _les()
    if action == "status":
        return "PIE 正在运行" if _in_pie() else "PIE 未运行"
    if action == "start":
        if _in_pie():
            return "PIE 已在运行"
        close_undo_group()
        les.editor_request_begin_play()
        t0 = time.monotonic()
        return Deferred(lambda: ("PIE 已启动（%.1f 秒）。可用 capture_viewport 截取游戏画面，完成后 action=stop" % (time.monotonic() - t0)) if _in_pie() else None, timeout=90, what="启动 PIE")
    if action == "stop":
        if not _in_pie():
            return "PIE 未运行"
        les.editor_request_end_play()
        return Deferred(lambda: "PIE 已停止" if not _in_pie() else None, timeout=30, what="停止 PIE")
    raise ToolError("action 需为 start、stop 或 status")


def save_current_level(_args):
    _no_pie()
    w = _world()
    p = w.get_path_name().split(".")[0] if w else ""
    if not p or p.startswith("/Temp/"):
        raise ToolError("当前关卡还没有保存过（无路径），请在 UE 中用“另存为”指定位置后再让 AI 保存")
    if not p.startswith("/Game/"):
        raise ToolError("当前关卡 %s 不在工程 /Game 下（可能是引擎模板关卡），不能保存；请先在 UE 中另存到工程内" % p)
    close_undo_group()
    if not _les().save_current_level():
        raise ToolError("保存失败（文件可能只读或被源码管理锁定）")
    return "已保存关卡 " + p


def run_python(args):
    _no_pie()
    code = args.get("code")
    try:
        tree = safety.check(code, allowed=UE_ALLOWED_IMPORTS, blocked=UE_BLOCKED_CALLS)
    except safety.UnsafeCode as e:
        raise ToolError("脚本未通过安全检查：%s" % e) from None
    out = io.StringIO()

    def _print(*a, **k):
        k.pop("file", None)
        print(*a, file=out, **k)

    ns = {"__builtins__": safety.restricted_builtins(_print, allowed=UE_ALLOWED_IMPORTS), "__name__": "aigw_script", "unreal": unreal, "math": math}
    with _Txn("执行脚本"):
        try:
            exec(compile(tree, "<aigw_script>", "exec"), ns)  # noqa: S102 - 已经过静态检查与用户审批
        except Exception as e:  # noqa: BLE001
            raise ToolError("脚本运行出错：%s: %s\n已有输出：%s" % (type(e).__name__, e, out.getvalue()[-2000:])) from None
    text = out.getvalue()
    if "result" in ns:
        text += ("\n" if text else "") + "result = " + repr(ns["result"])[:4000]
    return text[-8000:] or "脚本已执行（无输出）"


# ---------- 蓝图 ----------
_BP_STATUS = {"BS_UP_TO_DATE": "通过", "BS_UP_TO_DATE_WITH_WARNINGS": "通过（有警告）", "BS_ERROR": "有错误", "BS_DIRTY": "未编译的修改", "BS_UNKNOWN": "未知", "BS_BEING_CREATED": "创建中"}


def _bel():
    lib = getattr(unreal, "BlueprintEditorLibrary", None)
    if lib is None:
        raise ToolError("当前引擎没有 BlueprintEditorLibrary（需要 UE 5.1 及以上）")
    return lib


def _load_bp(path):
    path = str(path or "").strip().split(".")[0]
    if not re.fullmatch(r"/[A-Za-z0-9_]+(/[A-Za-z0-9_\-]+)+", path):
        raise ToolError("蓝图路径格式如 /Game/FirstPerson/Blueprints/BP_FirstPersonCharacter")
    if not unreal.EditorAssetLibrary.does_asset_exist(path):
        raise ToolError("资产不存在：%s。可先用 list_assets（class_filter=Blueprint）查找" % path)
    bp = unreal.load_asset(path)
    if not isinstance(bp, unreal.Blueprint):
        raise ToolError("%s 不是蓝图（%s）" % (path, bp.get_class().get_name() if bp else "?"))
    return bp, path


def _bp_status(bp):
    try:
        st = str(bp.get_editor_property("status")).split(".")[-1].split(":")[0].strip("<> ")
    except Exception:  # noqa: BLE001
        return "BS_UNKNOWN"
    return st


def _item_name(x):
    for attr in ("name", "function_name", "event_name"):
        try:
            v = getattr(x, attr)
            if v is not None and not callable(v):
                return str(v)
        except Exception:  # noqa: BLE001
            pass
    if hasattr(x, "get_name"):
        return str(x.get_name())
    return str(x)[:80]


def _names(v, limit=80):
    try:
        return [_item_name(x) for x in list(v or [])[:limit]]
    except Exception:  # noqa: BLE001
        return []


def _implemented(v, limit=120):
    """BlueprintFunctionInfo 列表：只保留蓝图里实际实现的（未实现的可重写函数 / 事件只计数）。"""
    out, other = [], 0
    try:
        for x in list(v or [])[:limit]:
            impl = getattr(x, "is_implemented", True)
            if impl:
                out.append(_item_name(x))
            else:
                other += 1
    except Exception:  # noqa: BLE001
        pass
    return out, other


def _try(fn, *a):
    try:
        return fn(*a)
    except Exception as e:  # noqa: BLE001
        return "（不可用：%s）" % (str(e)[:80],)


def _pin_type(t):
    if t is None or isinstance(t, str):
        return str(t or "")
    try:
        cat = str(t.get_editor_property("pin_category"))
        sub = t.get_editor_property("pin_sub_category_object")
        sub = sub.get_name() if sub else ""
        cont = str(t.get_editor_property("container_type")).split(".")[-1].split(":")[0].strip("<> ") if hasattr(t, "get_editor_property") else ""
        out = cat + (" · " + sub if sub else "")
        if cont and cont not in ("NONE", "None"):
            out += " [%s]" % cont.title()
        return out
    except Exception:  # noqa: BLE001
        return str(t)[:80]


def blueprint_info(args):
    bel = _bel()
    bp, path = _load_bp(args.get("path"))
    st = _bp_status(bp)
    info = {"path": path, "class": bp.get_class().get_name(), "status": _BP_STATUS.get(st, st)}
    parent = _try(bel.get_blueprint_parent_class, bp)
    info["parent_class"] = parent.get_name() if hasattr(parent, "get_name") else parent
    if hasattr(bel, "list_graph_names"):
        info["graphs"] = _names(_try(bel.list_graph_names, bp))
    if hasattr(bel, "list_functions"):
        info["functions"], info["overridable_functions_not_implemented"] = _implemented(_try(bel.list_functions, bp))
    if hasattr(bel, "list_events"):
        info["events"], info["overridable_events_not_implemented"] = _implemented(_try(bel.list_events, bp))
    variables, inherited = [], 0
    names = _try(bp.list_member_variable_names) if hasattr(bp, "list_member_variable_names") else []
    for n in _names(names, 200):
        if "/" in n or "." in n:
            inherited += 1  # 父类（C++）里的属性，只计数
            continue
        t = _try(bp.get_member_variable_type, n) if hasattr(bp, "get_member_variable_type") else None
        variables.append({"name": n, "type": _pin_type(t)})
    info["inherited_properties"] = inherited
    info["variables"] = variables
    if hasattr(bp, "list_event_dispatchers"):
        info["event_dispatchers"] = _names(_try(bp.list_event_dispatchers))
    return _compact(info)


def _log_file():
    d = str(unreal.Paths.project_log_dir())
    try:
        logs = [os.path.join(d, f) for f in os.listdir(d) if f.endswith(".log") and "-backup-" not in f]
    except OSError:
        return None
    return max(logs, key=os.path.getmtime) if logs else None


def compile_blueprints(args):
    _no_pie()
    bel = _bel()
    paths = args.get("paths")
    folder = args.get("folder")
    if folder:
        folder = _content_path(folder, "/Game")
        paths = [str(p).split(".")[0] for p in unreal.EditorAssetLibrary.list_assets(folder, True, False) if _asset_class(str(p)) in ("Blueprint", "WidgetBlueprint", "AnimBlueprint")]
    if not isinstance(paths, list) or not paths:
        raise ToolError("需要 paths（蓝图路径列表）或 folder（如 /Game/FirstPerson）")
    if len(paths) > 60:
        raise ToolError("一次最多编译 60 个蓝图，请缩小范围")
    log = _log_file()
    start = os.path.getsize(log) if log and os.path.exists(log) else 0
    results = []
    t0 = time.time()
    for p in paths:
        try:
            bp, path = _load_bp(p)
        except ToolError as e:
            results.append({"path": str(p), "status": "错误", "detail": str(e)})
            continue
        bel.compile_blueprint(bp)
        st = _bp_status(bp)
        results.append({"path": path, "name": path.rsplit("/", 1)[-1], "status": _BP_STATUS.get(st, st), "ok": st in ("BS_UP_TO_DATE", "BS_UP_TO_DATE_WITH_WARNINGS")})
    elapsed = time.time() - t0
    deadline = time.monotonic() + 1.5

    def poll():
        if time.monotonic() < deadline:
            return None  # 等日志落盘
        msgs = []
        if log and os.path.exists(log):
            try:
                with open(log, "rb") as f:
                    f.seek(start)
                    text = f.read(400000).decode("utf-8", "replace")
                names = [r.get("name", "") for r in results if r.get("name")]
                for line in text.splitlines():
                    if ("Error" in line or "Warning" in line) and ("Blueprint" in line or "Compiler" in line or any(n and n in line for n in names)):
                        msgs.append(re.sub(r"^\[[^\]]*\]\[\s*\d+\]", "", line).strip()[:400])
            except OSError:
                pass
        seen, uniq = set(), []
        for m in msgs:
            if m not in seen:
                seen.add(m)
                uniq.append(m)
        for r in results:
            if r.get("name"):
                mine = [m for m in uniq if r["path"] + "." in m or "/" + r["name"] + "." in m]
                if mine:
                    r["messages"] = mine[:10]
        msgs = uniq
        bad = [r for r in results if not r.get("ok")]
        summary = "编译 %d 个蓝图，用时 %.1f 秒：%d 个通过，%d 个有问题" % (len(results), elapsed, len(results) - len(bad), len(bad))
        return _compact({"summary": summary, "results": results, "log_messages": msgs[:60]})

    return Deferred(poll, timeout=20, what="读取编译日志")


def open_asset(args):
    path = str(args.get("path") or "").split(".")[0]
    if not unreal.EditorAssetLibrary.does_asset_exist(path):
        raise ToolError("资产不存在：" + path)
    asset = unreal.load_asset(path)
    sub = unreal.get_editor_subsystem(unreal.AssetEditorSubsystem)
    sub.open_editor_for_assets([asset])
    return "已在 UE 中打开 " + path


# ---------- 工具清单 ----------
_vec = {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 3}
_rot_desc = "旋转（度）[Roll(X), Pitch(Y), Yaw(Z)]，与细节面板一致"
TOOLS = [
    {"name": "get_level_info", "title": "读取关卡", "fn": get_level_info,
     "description": "读取当前 UE 关卡：工程、引擎版本、关卡路径、PIE 状态、各类 Actor 数量，以及 Actor 列表（显示名 label、内部名 name、类、位置 cm、旋转、缩放、网格与材质、是否选中）。大关卡请用 class_filter / name_filter 缩小范围。修改前先调用。",
     "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer", "description": "最多列出的 Actor 数，默认 60，最多 500"},
                                                      "class_filter": {"type": "string", "description": "按类名包含过滤，如 Light、StaticMeshActor"},
                                                      "name_filter": {"type": "string", "description": "按显示名或内部名包含过滤"}}},
     "annotations": {"readOnlyHint": True}},
    {"name": "list_assets", "title": "列出资产", "fn": list_assets,
     "description": "列出内容浏览器目录下的资产（路径与类型）。path 默认 /Game。",
     "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}, "recursive": {"type": "boolean"},
                                                      "class_filter": {"type": "string", "description": "如 StaticMesh、Material、Blueprint"},
                                                      "limit": {"type": "integer"}}},
     "annotations": {"readOnlyHint": True}},
    {"name": "capture_viewport", "title": "视口截图", "fn": capture_viewport, "timeout": 45,
     "description": "截取当前关卡视口；PIE 运行时截取游戏画面。返回 PNG，用于核对修改效果。",
     "inputSchema": {"type": "object", "properties": {"width": {"type": "integer", "description": "默认 1280"}, "height": {"type": "integer", "description": "默认按 16:9"}}},
     "annotations": {"readOnlyHint": True}},
    {"name": "focus_viewport", "title": "对准视口", "fn": focus_viewport,
     "description": "把关卡视口相机移到能看清某个 Actor（或某个坐标）的位置，通常在截图前调用。只改变视角，不改关卡。",
     "inputSchema": {"type": "object", "properties": {"name": {"type": "string", "description": "Actor 显示名或内部名"}, "target": _vec,
                                                      "distance": {"type": "number", "description": "相机距离（cm），默认按物体大小"}}},
     "annotations": {"readOnlyHint": True}},
    {"name": "blueprint_info", "title": "读取蓝图结构", "fn": blueprint_info,
     "description": "读取一个蓝图资产的结构：父类、编译状态、图表、函数、事件、成员变量及类型、事件分发器。修改或排查蓝图前先调用。",
     "inputSchema": {"type": "object", "required": ["path"], "properties": {"path": {"type": "string", "description": "如 /Game/FirstPerson/Blueprints/BP_FirstPersonCharacter"}}},
     "annotations": {"readOnlyHint": True}},
    {"name": "compile_blueprints", "title": "编译蓝图", "fn": compile_blueprints, "timeout": 240,
     "description": "在 UE 编辑器中编译指定蓝图（paths）或某个目录下的全部蓝图（folder），返回每个蓝图的编译状态和编译日志里的错误 / 警告。只编译不保存。",
     "inputSchema": {"type": "object", "properties": {"paths": {"type": "array", "items": {"type": "string"}}, "folder": {"type": "string", "description": "如 /Game/FirstPerson"}}}},
    {"name": "open_asset", "title": "在 UE 中打开资产", "fn": open_asset,
     "description": "在 UE 编辑器里打开资产编辑器（如蓝图编辑器、材质编辑器），方便用户查看。只打开，不修改。",
     "inputSchema": {"type": "object", "required": ["path"], "properties": {"path": {"type": "string"}}},
     "annotations": {"readOnlyHint": True}},
    {"name": "spawn_actor", "title": "生成 Actor", "fn": spawn_actor,
     "description": "在关卡中生成 Actor：type 为基础形状（cube、sphere、cylinder、cone、plane，1 米大小）、灯光、相机、玩家出生点、雾、天空大气、后期盒、文字等；或用 asset 指定 /Game 下的静态网格 / 蓝图。可设 label、位置（cm）、旋转、缩放、color（#RRGGBB）、灯光 intensity（点光 / 聚光 / 矩形光单位为坎德拉，常用 5–50；平行光单位为勒克斯，常用 3–10）、文字 text、大纲文件夹 folder（默认 AIGW）。",
     "inputSchema": {"type": "object", "properties": {
         "type": {"type": "string", "enum": SPAWN_TYPES}, "asset": {"type": "string"}, "label": {"type": "string"},
         "location": _vec, "rotation_deg": dict(_vec, description=_rot_desc), "scale": _vec, "color": {"type": "string"},
         "intensity": {"type": "number"}, "text": {"type": "string"}, "folder": {"type": "string"}}}},
    {"name": "set_actor_transform", "title": "移动 / 旋转 / 缩放", "fn": set_actor_transform,
     "description": "设置 Actor 的位置（cm）、旋转（度）或缩放。relative=true 时在现有值上叠加（缩放为相乘）。",
     "inputSchema": {"type": "object", "required": ["name"], "properties": {
         "name": {"type": "string"}, "location": _vec, "rotation_deg": dict(_vec, description=_rot_desc), "scale": _vec, "relative": {"type": "boolean"}}}},
    {"name": "set_actor_label", "title": "重命名 Actor", "fn": set_actor_label,
     "description": "修改 Actor 在大纲中的显示名。",
     "inputSchema": {"type": "object", "required": ["name", "new_label"], "properties": {"name": {"type": "string"}, "new_label": {"type": "string"}}}},
    {"name": "set_actor_color", "title": "设置颜色", "fn": set_actor_color,
     "description": "为静态网格 Actor 设置纯色材质（在 /Game/AIGW/Materials 创建或复用材质实例）。color 用 #RRGGBB。",
     "inputSchema": {"type": "object", "required": ["name", "color"], "properties": {"name": {"type": "string"}, "color": {"type": "string"}}}},
    {"name": "import_asset", "title": "导入模型", "fn": import_asset, "timeout": 300,
     "description": "把本机 FBX / GLB / glTF / OBJ 文件导入到内容浏览器（默认 /Game/AIGW/Imported，不自动保存）。spawn=true 时导入后直接放进关卡。常与 Blender 的 export_model 配合。",
     "inputSchema": {"type": "object", "required": ["file"], "properties": {
         "file": {"type": "string", "description": "绝对路径"}, "destination": {"type": "string"}, "name": {"type": "string"},
         "replace": {"type": "boolean"}, "spawn": {"type": "boolean"}, "location": _vec, "label": {"type": "string"}}}},
    {"name": "pie", "title": "运行 / 停止游戏（PIE）", "fn": pie, "timeout": 100,
     "description": "action=start 在编辑器中开始游戏（PIE），stop 停止，status 查询。运行中可用 capture_viewport 截取游戏画面。",
     "inputSchema": {"type": "object", "required": ["action"], "properties": {"action": {"type": "string", "enum": ["start", "stop", "status"]}}}},
    {"name": "begin_undo_group", "title": "开始撤销分组", "fn": begin_undo_group,
     "description": "开始一个撤销分组：之后的多步修改在 end_undo_group 后合并为一次撤销（Ctrl+Z 一次即可全部撤回）。",
     "inputSchema": {"type": "object", "properties": {"description": {"type": "string", "description": "显示在 UE 撤销历史中的说明"}}}},
    {"name": "end_undo_group", "title": "结束撤销分组", "fn": end_undo_group,
     "description": "结束当前撤销分组。",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "undo", "title": "撤销", "fn": undo,
     "description": "撤销最近的编辑器操作（与 Ctrl+Z 相同），steps 默认 1。",
     "inputSchema": {"type": "object", "properties": {"steps": {"type": "integer"}}}},
    {"name": "redo", "title": "重做", "fn": redo,
     "description": "重做被撤销的操作（与 Ctrl+Y 相同）。",
     "inputSchema": {"type": "object", "properties": {"steps": {"type": "integer"}}}},
    {"name": "delete_actors", "title": "删除 Actor", "fn": delete_actors,
     "description": "从关卡删除指定 Actor（可撤销）。",
     "inputSchema": {"type": "object", "required": ["names"], "properties": {"names": {"type": "array", "items": {"type": "string"}}}},
     "annotations": {"destructiveHint": True}},
    {"name": "save_current_level", "title": "保存关卡", "fn": save_current_level, "timeout": 120,
     "description": "保存当前关卡到磁盘（会覆盖关卡文件，需要用户确认）。新建未保存过的关卡不能用此工具。",
     "inputSchema": {"type": "object", "properties": {}},
     "annotations": {"destructiveHint": True}},
    {"name": "run_python", "title": "执行 Python 脚本", "fn": run_python, "timeout": 120,
     "description": "在 UE 编辑器中执行一段 Python（可用 unreal、math），用于其他工具覆盖不到的操作，整段放在一个撤销事务里。每次都需要用户审批；禁止文件删除、子进程、保存 / 删除 / 重命名资产、加载关卡与控制台命令。打印输出或设置变量 result 返回结果。",
     "inputSchema": {"type": "object", "required": ["code"], "properties": {"code": {"type": "string"}}}},
]
