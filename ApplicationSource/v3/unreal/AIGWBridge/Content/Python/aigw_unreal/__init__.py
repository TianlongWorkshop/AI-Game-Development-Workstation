# AIGW Unreal Bridge · 插件入口：在编辑器里启动本机 MCP 服务，并在 Slate 每帧回调中切回游戏线程执行工具。
import os

import unreal

from . import server, tools

VERSION = "0.1.0"
_bridge = None
_tick = None
_shutdown_hooked = False


def session_file():
    return os.environ.get("AIGW_UNREAL_SESSION_FILE") or os.path.join(os.path.expanduser("~"), ".aigw", "unreal_bridge.json")


def _info():
    info = {"engine": str(unreal.SystemLibrary.get_engine_version())}
    try:
        info["project"] = tools._project_file()
    except Exception:  # noqa: BLE001
        pass
    return info


def startup():
    """编辑器启动时调用；命令行工具（-run=）与显式关闭时不启动。"""
    if os.environ.get("AIGW_UNREAL_BRIDGE", "1") == "0":
        unreal.log("AIGW Bridge：已通过环境变量 AIGW_UNREAL_BRIDGE=0 关闭")
        return
    try:
        cmd = str(unreal.SystemLibrary.get_command_line()).lower()
    except Exception:  # noqa: BLE001
        cmd = ""
    if "-run=" in cmd:
        return
    start()


def start(port=None):
    global _bridge, _tick, _shutdown_hooked
    if _bridge and _bridge.running:
        return _bridge.port
    if port is None:
        try:
            port = int(os.environ.get("AIGW_UNREAL_PORT") or 0)
        except ValueError:
            port = 0
    _bridge = server.Bridge(tools.TOOLS, version=VERSION, instructions=tools.INSTRUCTIONS, session_file=session_file(),
                            extra_info=_info(), server_name="aigw-unreal-bridge", title="AIGW Unreal Bridge", host="Unreal")
    p = _bridge.start(port)
    if _tick is None:
        _tick = unreal.register_slate_post_tick_callback(_on_tick)
    if not _shutdown_hooked and hasattr(unreal, "register_python_shutdown_callback"):
        unreal.register_python_shutdown_callback(stop)
        _shutdown_hooked = True
    unreal.log("AIGW Bridge 已启动：http://127.0.0.1:%d/mcp（会话文件 %s）" % (p, _bridge.session_file))
    return p


def _on_tick(_dt):
    b = _bridge
    if not b or not b.running:
        return
    try:
        b.pump()
        tools.on_tick()
    except Exception as e:  # noqa: BLE001 - 每帧回调不能抛出
        unreal.log_warning("AIGW Bridge 每帧处理出错：%r" % (e,))


def stop():
    global _bridge, _tick
    if _tick is not None:
        try:
            unreal.unregister_slate_post_tick_callback(_tick)
        except Exception:  # noqa: BLE001
            pass
        _tick = None
    try:
        tools.close_undo_group()
    except Exception:  # noqa: BLE001
        pass
    if _bridge:
        _bridge.stop()
        unreal.log("AIGW Bridge 已停止")


def status():
    return {"running": bool(_bridge and _bridge.running), "port": _bridge.port if _bridge else 0, "last_error": _bridge.last_error if _bridge else ""}
