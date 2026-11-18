# AIGW Blender Bridge —— 让「AI 游戏开发工作站」通过本机 MCP 直接操作 Blender
# 启用后自动在 127.0.0.1 上启动服务，并把端口与一次性令牌写入 ~/.aigw/blender_bridge.json，工作站读取后即可连接。
import bpy

from . import server, tools

VERSION = "0.1.0"
INSTRUCTIONS = (
    "AIGW Blender Bridge：直接操作用户当前打开的 Blender。单位为米，Z 轴向上，角度用度。"
    "修改前先用 get_scene_info 确认对象名；修改后用 capture_viewport 截图确认。"
    "每个写操作都会产生一个撤销步骤。导出给 Unreal Engine 时优先用 export_model 导出 FBX，并按 SM_ / SK_ 前缀命名。"
)

_bridge = None


def _prefs():
    addon = bpy.context.preferences.addons.get(__package__)
    return addon.preferences if addon else None


def bridge():
    global _bridge
    if _bridge is None:
        _bridge = server.Bridge(tools.TOOLS, version=VERSION, instructions=INSTRUCTIONS, extra_info={"blender": bpy.app.version_string})
    return _bridge


def _pump():
    b = _bridge
    if b is None or not b.running:
        return None
    b.pump()
    return 0.05


def start(port=None):
    b = bridge()
    if b.running:
        return b.port
    if port is None:
        p = _prefs()
        port = p.port if p else 0
    b.start(port)
    if not bpy.app.timers.is_registered(_pump):
        bpy.app.timers.register(_pump, first_interval=0.05, persistent=True)
    return b.port


def stop():
    b = _bridge
    if b and b.running:
        b.stop()
    if bpy.app.timers.is_registered(_pump):
        bpy.app.timers.unregister(_pump)


class AIGW_OT_start(bpy.types.Operator):
    bl_idname = "aigw.bridge_start"
    bl_label = "启动 AIGW 桥接"
    bl_description = "在本机启动 MCP 服务，供 AI 游戏开发工作站连接"

    def execute(self, context):
        try:
            port = start()
        except OSError as e:
            self.report({"ERROR"}, "启动失败：%s（端口可能被占用，可在偏好设置中改为 0 自动分配）" % e)
            return {"CANCELLED"}
        self.report({"INFO"}, "AIGW 桥接已启动，端口 %d" % port)
        return {"FINISHED"}


class AIGW_OT_stop(bpy.types.Operator):
    bl_idname = "aigw.bridge_stop"
    bl_label = "停止 AIGW 桥接"
    bl_description = "停止本机 MCP 服务，工作站将无法再操作 Blender"

    def execute(self, context):
        stop()
        self.report({"INFO"}, "AIGW 桥接已停止")
        return {"FINISHED"}


def _draw_status(layout):
    b = _bridge
    col = layout.column(align=True)
    if b and b.running:
        col.label(text="运行中 · 127.0.0.1:%d" % b.port, icon="CHECKMARK")
        col.label(text="会话文件：" + b.session_file)
        if b.last_error:
            col.label(text="最近错误：" + b.last_error[:80], icon="ERROR")
        layout.operator("aigw.bridge_stop", icon="PAUSE")
    else:
        col.label(text="未运行", icon="CANCEL")
        layout.operator("aigw.bridge_start", icon="PLAY")


class AIGWPreferences(bpy.types.AddonPreferences):
    bl_idname = __package__

    port: bpy.props.IntProperty(name="端口", description="0 表示自动分配空闲端口（推荐）", default=0, min=0, max=65535)
    auto_start: bpy.props.BoolProperty(name="启用时自动启动", default=True)

    def draw(self, context):
        layout = self.layout
        row = layout.row()
        row.prop(self, "auto_start")
        row.prop(self, "port")
        _draw_status(layout)
        layout.label(text="服务只监听本机，并用随机令牌鉴权。不使用时可随时停止。", icon="INFO")


class AIGW_PT_panel(bpy.types.Panel):
    bl_label = "AIGW 桥接"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "AIGW"

    def draw(self, context):
        _draw_status(self.layout)


CLASSES = (AIGW_OT_start, AIGW_OT_stop, AIGWPreferences, AIGW_PT_panel)


def _auto_start():
    p = _prefs()
    if p is None or p.auto_start:
        try:
            start()
        except OSError as e:
            print("[AIGW] 桥接自动启动失败：", e)
    return None


def register():
    for c in CLASSES:
        bpy.utils.register_class(c)
    bpy.app.timers.register(_auto_start, first_interval=1.0)


def unregister():
    stop()
    if bpy.app.timers.is_registered(_auto_start):
        bpy.app.timers.unregister(_auto_start)
    for c in reversed(CLASSES):
        bpy.utils.unregister_class(c)
