# AI 游戏开发工作站 · Unreal Editor 实时桥接
# 工作站以 `UnrealEditor.exe <proj> -ExecutePythonScript="ue_live.py"` 启动，
# 环境变量 AIGW_UE_PORT / AIGW_UE_TOKEN 指定端口与令牌。代码在游戏线程（Slate tick）执行。
import unreal, json, socket, threading, queue, io, contextlib, traceback, os

PORT = int(os.environ.get('AIGW_UE_PORT', '9877'))
TOKEN = os.environ.get('AIGW_UE_TOKEN', '')
jobs = queue.Queue()


def tick(_dt):
    budget = 4
    while budget and not jobs.empty():
        budget -= 1
        req, reply = jobs.get()
        out = io.StringIO(); res = {'id': req.get('id'), 'ok': False}
        try:
            g = {'unreal': unreal, 'RESULT': {}, '__name__': '__aigw_live__'}
            with contextlib.redirect_stdout(out):
                exec(compile(req.get('code', ''), 'live.py', 'exec'), g)
            res.update(ok=True, result=g.get('RESULT'))
        except Exception as e:
            res.update(error=str(e), traceback=traceback.format_exc()[-4000:])
        res['stdout'] = out.getvalue()[-20000:]
        reply.put(res)


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
                info = {'app': 'unreal', 'version': unreal.SystemLibrary.get_engine_version(), 'project': unreal.Paths.get_project_file_path()}
                f.write((json.dumps({'id': req.get('id'), 'ok': True, 'result': info}) + '\n').encode()); f.flush(); continue
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
    unreal.log('AIGW_LIVE_READY port=%d' % PORT)
    while True:
        conn, _ = s.accept()
        threading.Thread(target=client, args=(conn,), daemon=True).start()


unreal.register_slate_post_tick_callback(tick)
threading.Thread(target=server, daemon=True).start()
