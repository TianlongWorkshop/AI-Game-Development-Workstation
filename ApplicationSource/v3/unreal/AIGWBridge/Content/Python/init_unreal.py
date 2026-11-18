# UE 启动时自动执行（PythonScriptPlugin 会运行所有已启用插件 Content/Python 下的 init_unreal.py）
import unreal

try:
    import aigw_unreal
    aigw_unreal.startup()
except Exception as e:  # noqa: BLE001 - 插件故障不能影响编辑器启动
    unreal.log_error("AIGW Bridge 启动失败：%r" % (e,))
