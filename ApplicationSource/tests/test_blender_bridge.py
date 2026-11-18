# AIGW Blender Bridge 协议层与安全检查测试（不需要 Blender）
# 运行：python tests/test_blender_bridge.py
import importlib.util
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.join(HERE, "..", "v3", "blender", "aigw_bridge")


def load(name):
    spec = importlib.util.spec_from_file_location("aigw_" + name, os.path.join(PKG, name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


server = load("server")
safety = load("safety")


def echo(args):
    return "echo " + json.dumps(args, ensure_ascii=False)


def boom(args):
    raise server.ToolError("预期的错误")


def crash(args):
    return 1 / 0


def image(args):
    return [{"type": "image", "data": "AAAA", "mimeType": "image/png"}, {"type": "text", "text": "ok"}]


TOOLS = [
    {"name": "echo", "description": "echo", "inputSchema": {"type": "object", "properties": {}}, "fn": echo, "annotations": {"readOnlyHint": True}},
    {"name": "boom", "description": "boom", "inputSchema": {"type": "object", "properties": {}}, "fn": boom},
    {"name": "crash", "description": "crash", "inputSchema": {"type": "object", "properties": {}}, "fn": crash},
    {"name": "image", "description": "image", "inputSchema": {"type": "object", "properties": {}}, "fn": image},
]


class BridgeHTTPTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.session = os.path.join(self.tmp, "blender_bridge.json")
        # 非 direct 模式：模拟 Blender 主线程用定时器取任务
        self.b = server.Bridge(TOOLS, version="0.1.0", instructions="hi", session_file=self.session, extra_info={"blender": "test"})
        self.port = self.b.start(0)
        self.stop_pump = False

        def pump():
            while not self.stop_pump:
                self.b.pump()
                time.sleep(0.01)
        self.pumper = threading.Thread(target=pump, daemon=True)
        self.pumper.start()

    def tearDown(self):
        self.stop_pump = True
        self.b.stop()

    def post(self, msg, token=None, origin=None, sid=None):
        req = urllib.request.Request("http://127.0.0.1:%d/mcp" % self.port, data=json.dumps(msg).encode(), method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("Accept", "application/json, text/event-stream")
        req.add_header("Authorization", "Bearer " + (token if token is not None else self.b.token))
        if origin:
            req.add_header("Origin", origin)
        if sid:
            req.add_header("Mcp-Session-Id", sid)
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                body = r.read()
                return r.status, (json.loads(body) if body else None), dict(r.headers)
        except urllib.error.HTTPError as e:
            body = e.read()
            return e.code, (json.loads(body) if body else None), dict(e.headers)

    def test_session_file(self):
        with open(self.session, encoding="utf-8") as f:
            data = json.load(f)
        self.assertEqual(data["port"], self.port)
        self.assertEqual(data["token"], self.b.token)
        self.assertEqual(data["blender"], "test")
        self.assertGreaterEqual(len(data["token"]), 32)

    def test_auth_and_origin(self):
        code, body, _ = self.post({"jsonrpc": "2.0", "id": 1, "method": "ping"}, token="wrong")
        self.assertEqual(code, 401)
        code, _, _ = self.post({"jsonrpc": "2.0", "id": 1, "method": "ping"}, origin="https://evil.example")
        self.assertEqual(code, 403)
        code, body, _ = self.post({"jsonrpc": "2.0", "id": 1, "method": "ping"}, origin="http://localhost:5173")
        self.assertEqual(code, 200)

    def test_protocol_flow(self):
        code, body, headers = self.post({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}})
        self.assertEqual(code, 200)
        self.assertEqual(body["result"]["protocolVersion"], "2025-06-18")
        self.assertIn("Mcp-Session-Id", headers)
        code, body, _ = self.post({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self.assertEqual(code, 202)
        code, body, _ = self.post({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        self.assertEqual([t["name"] for t in body["result"]["tools"]], ["echo", "boom", "crash", "image"])
        self.assertTrue(body["result"]["tools"][0]["annotations"]["readOnlyHint"])
        self.assertNotIn("fn", body["result"]["tools"][0])
        code, body, _ = self.post({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "echo", "arguments": {"a": "中文"}}})
        self.assertEqual(body["result"]["content"][0]["text"], 'echo {"a": "中文"}')
        code, body, _ = self.post({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "boom", "arguments": {}}})
        self.assertTrue(body["result"]["isError"])
        self.assertIn("预期的错误", body["result"]["content"][0]["text"])
        code, body, _ = self.post({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "crash", "arguments": {}}})
        self.assertTrue(body["result"]["isError"])
        self.assertIn("ZeroDivisionError", body["result"]["content"][0]["text"])
        code, body, _ = self.post({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "nope"}})
        self.assertEqual(body["error"]["code"], -32602)
        code, body, _ = self.post({"jsonrpc": "2.0", "id": 7, "method": "resources/list"})
        self.assertEqual(body["error"]["code"], -32601)
        code, body, _ = self.post([{"jsonrpc": "2.0", "id": 8, "method": "ping"}])
        self.assertEqual(code, 400)
        code, body, _ = self.post({"jsonrpc": "2.0", "id": 9, "method": "initialize", "params": {"protocolVersion": "1999-01-01"}})
        self.assertEqual(body["result"]["protocolVersion"], "2025-06-18")

    def test_stop_cleans_session_file(self):
        self.b.stop()
        self.assertFalse(os.path.exists(self.session))


class MainThreadTimeoutTest(unittest.TestCase):
    def test_timeout_when_main_thread_busy(self):
        b = server.Bridge(TOOLS, session_file=os.path.join(tempfile.mkdtemp(), "s.json"))
        with self.assertRaises(server.ToolError):
            b.run(echo, {}, timeout=0.2)  # 没有人调用 pump()


class SafetyTest(unittest.TestCase):
    def ok(self, code):
        safety.check(code)

    def bad(self, code, word):
        with self.assertRaises(safety.UnsafeCode) as cm:
            safety.check(code)
        self.assertIn(word, str(cm.exception))

    def test_allows_normal_blender_code(self):
        self.ok("import bpy\nimport math\nfor o in bpy.data.objects:\n    o.location.z += 1\nresult = len(bpy.data.objects)")
        self.ok("from mathutils import Vector\nv = Vector((1,2,3))\nprint(v.length)")

    def test_blocks_dangerous_code(self):
        self.bad("import os\nos.system('calc')", "os")
        self.bad("import subprocess", "subprocess")
        self.bad("from socket import socket", "socket")
        self.bad("open('x.txt','w')", "open")
        self.bad("eval('1+1')", "eval")
        self.bad("().__class__.__bases__[0].__subclasses__()", "双下划线")
        self.bad("import bpy\nbpy.ops.wm.quit_blender()", "quit_blender")
        self.bad("import bpy\nbpy.ops.wm.save_mainfile()", "save_mainfile")
        self.bad("getattr(bpy, 'ops')", "getattr")
        self.bad("__builtins__", "__builtins__")
        self.bad("def f():\n    global x", "global")
        self.bad("x = (", "语法错误")
        self.bad("", "为空")

    def test_restricted_runtime(self):
        out = []
        ns = {"__builtins__": safety.restricted_builtins(lambda *a: out.append(a))}
        exec(compile(safety.check("import math\nprint(math.pi > 3)\nresult = sum(range(4))"), "<t>", "exec"), ns)
        self.assertEqual(out, [(True,)])
        self.assertEqual(ns["result"], 6)
        with self.assertRaises(ImportError):
            exec("import os", {"__builtins__": safety.restricted_builtins()})
        with self.assertRaises(NameError):
            exec("open('x')", {"__builtins__": safety.restricted_builtins()})


UE_PKG = os.path.join(HERE, "..", "v3", "unreal", "AIGWBridge", "Content", "Python", "aigw_unreal")


class SharedCoreTest(unittest.TestCase):
    def test_ue_plugin_uses_same_core(self):
        for f in ("server.py", "safety.py"):
            with open(os.path.join(PKG, f), "rb") as a, open(os.path.join(UE_PKG, f), "rb") as b:
                self.assertEqual(a.read(), b.read(), f + " 在 Blender 扩展与 UE 插件中必须一致")

    def test_ue_plugin_manifest_and_syntax(self):
        root = os.path.join(UE_PKG, "..", "..", "..")
        with open(os.path.join(root, "AIGWBridge.uplugin"), encoding="utf-8") as f:
            man = json.load(f)
        self.assertTrue(man["CanContainContent"])
        self.assertEqual({p["Name"] for p in man["Plugins"]}, {"PythonScriptPlugin", "EditorScriptingUtilities"})
        import ast
        for f in ("__init__.py", "tools.py"):
            with open(os.path.join(UE_PKG, f), encoding="utf-8") as fh:
                ast.parse(fh.read())

    def test_safety_custom_allowlist(self):
        safety.check("import unreal\nresult = 1", allowed={"unreal"})
        with self.assertRaises(safety.UnsafeCode):
            safety.check("import bpy", allowed={"unreal"})
        with self.assertRaises(safety.UnsafeCode):
            safety.check("x.save_current_level()", blocked={"save_current_level"})
        b = safety.restricted_builtins(allowed={"math"})
        b["__import__"]("math")
        with self.assertRaises(ImportError):
            b["__import__"]("json")


class DeferredTest(unittest.TestCase):
    def test_deferred_resolves_across_pumps(self):
        n = {"i": 0}

        def slow(args):
            def poll():
                n["i"] += 1
                return "done after %d" % n["i"] if n["i"] >= 3 else None
            return server.Deferred(poll, timeout=5, what="慢操作")

        def never(args):
            return server.Deferred(lambda: None, timeout=0.05, what="永不完成的操作")

        tools = [{"name": "slow", "description": "", "inputSchema": {"type": "object"}, "fn": slow},
                 {"name": "never", "description": "", "inputSchema": {"type": "object"}, "fn": never}]
        b = server.Bridge(tools, session_file=os.path.join(tempfile.mkdtemp(), "s.json"), host="Unreal")
        stop = threading.Event()

        def pumper():
            while not stop.is_set():
                b.pump()
                time.sleep(0.01)
        t = threading.Thread(target=pumper, daemon=True)
        t.start()
        try:
            self.assertEqual(b.run(slow, {}), "done after 3")
            with self.assertRaisesRegex(server.ToolError, "永不完成的操作超时"):
                b.run(never, {})
            r = b.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
            self.assertEqual(r["result"]["serverInfo"]["name"], "aigw-blender-bridge")
        finally:
            stop.set()
        d = server.Bridge(tools, direct=True, session_file=os.path.join(tempfile.mkdtemp(), "s.json"))
        n["i"] = 0
        self.assertEqual(d.run(slow, {}), "done after 3")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--serve":
        # 供 Node 端交叉测试：启动桥接（direct 模式）并写入会话文件
        b = server.Bridge(TOOLS, version="0.1.0", instructions="cross", direct=True, session_file=sys.argv[2], extra_info={"blender": "cross-test"})
        b.start(0)
        print("READY", b.port, flush=True)
        try:
            while True:
                time.sleep(0.5)
        except KeyboardInterrupt:
            b.stop()
    else:
        unittest.main(verbosity=1)
