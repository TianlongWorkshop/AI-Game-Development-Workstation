# AIGW Bridge · 受控脚本的静态检查与受限执行环境（Blender 扩展与 UE 插件共用）
# 说明：这是纵深防御的一层，不是沙箱。真正的把关是工作站的 L2 审批（用户看过代码才执行）。
import ast
import builtins

ALLOWED_IMPORTS = {
    "bpy", "bmesh", "mathutils", "math", "random", "json", "re", "itertools", "collections", "functools",
    "statistics", "colorsys", "time", "datetime", "string", "typing", "dataclasses", "enum", "copy", "bpy_extras",
}
BLOCKED_CALLS = {
    "eval", "exec", "compile", "__import__", "open", "input", "breakpoint", "getattr", "delattr", "globals", "locals", "vars",
    "system", "popen", "remove", "unlink", "rmdir", "removedirs", "rename", "replace", "rmtree", "startfile", "kill",
    "spawnl", "spawnv", "execv", "execl", "fork",
    "quit_blender", "save_mainfile", "save_as_mainfile", "open_mainfile", "read_homefile", "read_factory_settings",
    "addon_install", "addon_remove", "addon_enable", "addon_disable", "extension_install", "package_install", "save_userpref",
}
SAFE_BUILTINS = [
    "abs", "all", "any", "bool", "dict", "divmod", "enumerate", "filter", "float", "format", "frozenset", "hasattr", "int",
    "isinstance", "issubclass", "iter", "len", "list", "map", "max", "min", "next", "print", "range", "repr", "reversed",
    "round", "set", "setattr", "slice", "sorted", "str", "sum", "tuple", "zip", "Exception", "ValueError", "TypeError",
    "KeyError", "IndexError", "RuntimeError", "StopIteration", "True", "False", "None",
]


class UnsafeCode(Exception):
    pass


def check(code, allowed=None, blocked=None):
    allowed = ALLOWED_IMPORTS if allowed is None else allowed
    blocked = BLOCKED_CALLS if blocked is None else blocked
    if not isinstance(code, str) or not code.strip():
        raise UnsafeCode("代码为空")
    if len(code) > 20000:
        raise UnsafeCode("代码过长（超过 20000 字符）")
    try:
        tree = ast.parse(code, mode="exec")
    except SyntaxError as e:
        raise UnsafeCode("语法错误：第 %s 行 %s" % (e.lineno, e.msg)) from None
    problems = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                if a.name.split(".")[0] not in allowed:
                    problems.append("第 %d 行：不允许导入 %s" % (node.lineno, a.name))
        elif isinstance(node, ast.ImportFrom):
            root = (node.module or "").split(".")[0]
            if node.level or root not in allowed:
                problems.append("第 %d 行：不允许导入 %s" % (node.lineno, node.module or "相对模块"))
        elif isinstance(node, ast.Call):
            f = node.func
            name = f.id if isinstance(f, ast.Name) else f.attr if isinstance(f, ast.Attribute) else None
            if name in blocked:
                problems.append("第 %d 行：不允许调用 %s" % (node.lineno, name))
        elif isinstance(node, ast.Attribute):
            if node.attr.startswith("__") and node.attr.endswith("__"):
                problems.append("第 %d 行：不允许访问双下划线属性 %s" % (node.lineno, node.attr))
        elif isinstance(node, ast.Name):
            if node.id.startswith("__") and node.id.endswith("__") and node.id != "__name__":
                problems.append("第 %d 行：不允许使用 %s" % (node.lineno, node.id))
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            problems.append("第 %d 行：不允许使用 global / nonlocal" % node.lineno)
    if problems:
        raise UnsafeCode("；".join(problems[:8]))
    return tree


def make_guarded_import(allowed):
    def guarded_import(name, globals_=None, locals_=None, fromlist=(), level=0):
        if level or name.split(".")[0] not in allowed:
            raise ImportError("不允许导入 %s" % name)
        return __import__(name, globals_, locals_, fromlist, level)
    return guarded_import


guarded_import = make_guarded_import(ALLOWED_IMPORTS)


def restricted_builtins(print_fn=None, allowed=None):
    b = {n: getattr(builtins, n) for n in SAFE_BUILTINS if hasattr(builtins, n)}
    b["True"], b["False"], b["None"] = True, False, None
    b["__import__"] = guarded_import if allowed is None else make_guarded_import(allowed)
    if print_fn:
        b["print"] = print_fn
    return b
