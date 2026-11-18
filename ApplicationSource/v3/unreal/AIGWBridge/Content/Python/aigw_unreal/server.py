# AIGW Bridge · 本机 MCP 服务（Streamable HTTP，JSON 响应）
# 纯 Python，不依赖 bpy / unreal：负责 HTTP、鉴权、JSON-RPC 与“切回主线程执行”。
# Blender 扩展与 UE 插件共用同一份文件（tests 会校验两份副本一致）。
import json
import os
import queue
import re
import secrets
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]
MAX_BODY = 16 * 1024 * 1024
ORIGIN_RE = re.compile(r"^https?://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$")


class ToolError(Exception):
    """工具可预期的错误：返回给模型作为 isError 结果，而不是协议错误。"""


class _QuietServer(ThreadingHTTPServer):
    """客户端断开连接（如连接复用被重置）是正常现象，不要把回溯打印到 Blender 控制台 / UE 输出日志。"""
    daemon_threads = True

    def handle_error(self, request, client_address):
        import sys
        if isinstance(sys.exc_info()[1], (ConnectionError, TimeoutError)):
            return
        super().handle_error(request, client_address)


class Deferred:
    """需要跨多帧完成的工具结果（例如 UE 截图要等渲染线程写文件）。
    poll() 在主线程每帧调用：返回 None 表示继续等待，返回内容即完成，抛出异常即失败。"""

    def __init__(self, poll, timeout=30.0, what="操作"):
        self.poll = poll
        self.deadline = time.monotonic() + timeout
        self.what = what


class Bridge:
    def __init__(self, tools, *, version="0.1.0", instructions="", direct=False, session_file=None, extra_info=None,
                 server_name="aigw-blender-bridge", title="AIGW Blender Bridge", host="Blender"):
        self.tools = {t["name"]: t for t in tools}
        self.version = version
        self.instructions = instructions
        self.direct = direct  # 仅测试用：在服务线程直接执行工具
        self.session_file = session_file or os.path.join(os.path.expanduser("~"), ".aigw", "blender_bridge.json")
        self.extra_info = extra_info or {}
        self.server_name = server_name
        self.title = title
        self.host = host
        self.jobs = queue.Queue()
        self.waiting = []  # [(Deferred, box, ev)]
        self.server = None
        self.thread = None
        self.port = 0
        self.token = ""
        self.started = None
        self.sessions = set()
        self.last_error = ""

    # ---------- 主线程执行 ----------
    def pump(self, budget=8):
        if self.waiting:
            still = []
            for d, box, ev in self.waiting:
                try:
                    r = d.poll()
                    if r is None and time.monotonic() > d.deadline:
                        raise ToolError("%s超时未完成" % d.what)
                except BaseException as e:  # noqa: BLE001
                    box["error"] = e
                    ev.set()
                    continue
                if r is None:
                    still.append((d, box, ev))
                else:
                    box["result"] = r
                    ev.set()
            self.waiting = still
        for _ in range(budget):
            try:
                fn, args, box, ev = self.jobs.get_nowait()
            except queue.Empty:
                break
            try:
                r = fn(args)
                if isinstance(r, Deferred):
                    self.waiting.append((r, box, ev))
                    continue
                box["result"] = r
            except BaseException as e:  # noqa: BLE001 - 需要把任意错误带回请求线程
                box["error"] = e
            ev.set()

    def run(self, fn, args, timeout=60):
        if self.direct:
            r = fn(args)
            while isinstance(r, Deferred):
                v = r.poll()
                if v is not None:
                    return v
                if time.monotonic() > r.deadline:
                    raise ToolError("%s超时未完成" % r.what)
                time.sleep(0.02)
            return r
        box, ev = {}, threading.Event()
        self.jobs.put((fn, args, box, ev))
        if not ev.wait(timeout):
            raise ToolError("%s 主线程繁忙，%d 秒内未执行完；该操作可能稍后仍会执行，请先查看场景再决定是否重试。" % (self.host, timeout))
        if "error" in box:
            raise box["error"]
        return box["result"]

    # ---------- JSON-RPC ----------
    def handle(self, msg):
        mid = msg.get("id")
        method = msg.get("method")
        params = msg.get("params") or {}
        if not isinstance(params, dict):
            return self.error(mid, -32602, "params 必须是对象")
        if method == "initialize":
            req = params.get("protocolVersion")
            version = req if req in PROTOCOLS else PROTOCOLS[1]
            return self.ok(mid, {
                "protocolVersion": version,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": self.server_name, "title": self.title, "version": self.version, **self.extra_info},
                "instructions": self.instructions,
            })
        if method == "ping":
            return self.ok(mid, {})
        if method == "tools/list":
            tools = []
            for t in self.tools.values():
                item = {"name": t["name"], "description": t["description"], "inputSchema": t["inputSchema"]}
                if t.get("title"):
                    item["title"] = t["title"]
                if t.get("annotations"):
                    item["annotations"] = t["annotations"]
                tools.append(item)
            return self.ok(mid, {"tools": tools})
        if method == "tools/call":
            name = params.get("name")
            args = params.get("arguments") or {}
            tool = self.tools.get(name)
            if not tool:
                return self.error(mid, -32602, "未知工具：%s" % name)
            if not isinstance(args, dict):
                return self.error(mid, -32602, "arguments 必须是对象")
            try:
                content = self.run(tool["fn"], args, timeout=tool.get("timeout", 60))
                if isinstance(content, str):
                    content = [{"type": "text", "text": content}]
                return self.ok(mid, {"content": content, "isError": False})
            except ToolError as e:
                return self.ok(mid, {"content": [{"type": "text", "text": "错误：%s" % e}], "isError": True})
            except Exception as e:  # noqa: BLE001
                self.last_error = "%s: %s" % (type(e).__name__, e)
                return self.ok(mid, {"content": [{"type": "text", "text": "%s 执行出错：%s: %s" % (self.host, type(e).__name__, e)}], "isError": True})
        return self.error(mid, -32601, "不支持的方法：%s" % method)

    @staticmethod
    def ok(mid, result):
        return {"jsonrpc": "2.0", "id": mid, "result": result}

    @staticmethod
    def error(mid, code, message):
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": message}}

    # ---------- 生命周期 ----------
    def start(self, port=0):
        if self.server:
            return self.port
        self.token = secrets.token_urlsafe(32)
        bridge = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "AIGWBridge/" + bridge.version
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def send_json(self, code, obj=None, headers=None):
                body = b"" if obj is None else json.dumps(obj, ensure_ascii=False).encode("utf-8")
                self.send_response(code)
                if obj is not None:
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                if body:
                    self.wfile.write(body)

            def check(self):
                if self.path.split("?")[0] != "/mcp":
                    return 404, "路径不存在"
                origin = self.headers.get("Origin")
                if origin and not ORIGIN_RE.match(origin):
                    return 403, "拒绝非本机来源"
                auth = self.headers.get("Authorization", "")
                if not secrets.compare_digest(auth.encode(), ("Bearer " + bridge.token).encode()):
                    return 401, "令牌无效"
                return 0, ""

            def do_POST(self):
                code, why = self.check()
                length = int(self.headers.get("Content-Length") or 0)
                if length > MAX_BODY:
                    self.close_connection = True
                    return self.send_json(413, Bridge.error(None, -32600, "请求过大"))
                raw = self.rfile.read(length) if length else b""
                if code:
                    return self.send_json(code, Bridge.error(None, -32001, why))
                try:
                    msg = json.loads(raw.decode("utf-8"))
                except Exception:  # noqa: BLE001
                    return self.send_json(400, Bridge.error(None, -32700, "JSON 解析失败"))
                if isinstance(msg, list):
                    return self.send_json(400, Bridge.error(None, -32600, "不支持批量请求"))
                if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
                    return self.send_json(400, Bridge.error(None, -32600, "无效的 JSON-RPC 消息"))
                if "method" not in msg or msg.get("id") is None:
                    return self.send_json(202)
                headers = {}
                if msg.get("method") == "initialize":
                    sid = str(uuid.uuid4())
                    bridge.sessions.add(sid)
                    headers["Mcp-Session-Id"] = sid
                self.send_json(200, bridge.handle(msg), headers)

            def do_GET(self):
                code, why = self.check()
                if code:
                    return self.send_json(code, Bridge.error(None, -32001, why))
                self.send_json(405, None, {"Allow": "POST, DELETE"})

            def do_DELETE(self):
                code, why = self.check()
                if code:
                    return self.send_json(code, Bridge.error(None, -32001, why))
                bridge.sessions.discard(self.headers.get("Mcp-Session-Id", ""))
                self.send_json(200)

        srv = _QuietServer(("127.0.0.1", int(port or 0)), Handler)
        srv.daemon_threads = True
        self.server = srv
        self.port = srv.server_address[1]
        self.started = time.strftime("%Y-%m-%dT%H:%M:%S")
        self.thread = threading.Thread(target=srv.serve_forever, name="aigw-bridge", daemon=True)
        self.thread.start()
        self.write_session()
        return self.port

    def write_session(self):
        try:
            os.makedirs(os.path.dirname(self.session_file), exist_ok=True)
            data = {"port": self.port, "token": self.token, "pid": os.getpid(), "startedAt": self.started, "version": self.version, **self.extra_info}
            tmp = self.session_file + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f)
            try:
                os.chmod(tmp, 0o600)
            except OSError:
                pass
            os.replace(tmp, self.session_file)
        except OSError as e:
            self.last_error = "写入会话文件失败：%s" % e

    def stop(self):
        srv, self.server = self.server, None
        if srv:
            srv.shutdown()
            srv.server_close()
        try:
            with open(self.session_file, encoding="utf-8") as f:
                data = json.load(f)
            if data.get("pid") == os.getpid() and data.get("port") == self.port:
                os.remove(self.session_file)
        except (OSError, ValueError):
            pass
        self.port = 0
        self.token = ""
        # 释放仍在排队的请求，避免请求线程一直等待
        while True:
            try:
                _fn, _args, box, ev = self.jobs.get_nowait()
            except queue.Empty:
                break
            box["error"] = ToolError("%s 桥接已停止" % self.host)
            ev.set()
        for _d, box, ev in self.waiting:
            box["error"] = ToolError("%s 桥接已停止" % self.host)
            ev.set()
        self.waiting = []

    @property
    def running(self):
        return self.server is not None
