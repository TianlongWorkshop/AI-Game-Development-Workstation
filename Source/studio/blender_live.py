# AI 游戏开发工作站 · Blender 实时桥接
# 由工作站以 `blender --python blender_live.py -- <port> <token>` 启动；
# 在 127.0.0.1 上监听，收到的代码在 Blender 主线程中执行（bpy.app.timers），返回 JSON。
import bpy, sys, json, socket, threading, queue, io, contextlib, traceback

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
PORT = int(args[0]) if args else 9876
TOKEN = args[1] if len(args) > 1 else ''
jobs = queue.Queue()


def run_on_main():
    while not jobs.empty():
        req, reply = jobs.get()
        out = io.StringIO(); res = {'id': req.get('id'), 'ok': False}
        try:
            g = {'bpy': bpy, 'RESULT': {}, '__name__': '__aigw_live__'}
            with contextlib.redirect_stdout(out):
                exec(compile(req.get('code', ''), 'live.py', 'exec'), g)
            res.update(ok=True, result=g.get('RESULT'))
        except Exception as e:
            res.update(error=str(e), traceback=traceback.format_exc()[-4000:])
        res['stdout'] = out.getvalue()[-20000:]
        reply.put(res)
    return 0.05


def client(conn):
    with conn:
        f = conn.makefile('rwb')
        for line in f:
            try:
                req = json.loads(line.decode('utf-8'))
            except Exception:
                continue
            if TOKEN and req.get('token') != TOKEN:
                f.write(b'{"ok":false,"error":"token"}\n'); f.flush(); continue
            if req.get('type') == 'ping':
                f.write((json.dumps({'id': req.get('id'), 'ok': True, 'result': {'app': 'blender', 'version': bpy.app.version_string, 'file': bpy.data.filepath}}) + '\n').encode()); f.flush(); continue
            reply = queue.Queue(); jobs.put((req, reply))
            try:
                res = reply.get(timeout=float(req.get('timeout', 600)))
            except queue.Empty:
                res = {'id': req.get('id'), 'ok': False, 'error': 'timeout'}
            f.write((json.dumps(res, ensure_ascii=False, default=str) + '\n').encode('utf-8')); f.flush()


def server():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('127.0.0.1', PORT)); s.listen(4)
    print('AIGW_LIVE_READY port=%d' % PORT, flush=True)
    while True:
        conn, _ = s.accept()
        threading.Thread(target=client, args=(conn,), daemon=True).start()


bpy.app.timers.register(run_on_main, persistent=True)
threading.Thread(target=server, daemon=True).start()
