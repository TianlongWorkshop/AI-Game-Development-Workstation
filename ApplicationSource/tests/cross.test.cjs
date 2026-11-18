'use strict';
// 交叉测试：工作站的 Node MCP 客户端 / Hub ←→ Blender 桥接的 Python 服务端（无需 Blender，使用测试工具）
const test = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Hub} = require('../v3/hub.cjs');

const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

test('Hub 通过会话文件连接 Python 桥接并调用工具', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigw-cross-'));
  const sessionFile = path.join(dir, 'blender_bridge.json');
  const child = spawn(PY, [path.join(__dirname, 'test_blender_bridge.py'), '--serve', sessionFile], {stdio: ['ignore', 'pipe', 'inherit']});
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Python 桥接启动超时')), 8000);
    child.stdout.on('data', d => { if (String(d).includes('READY')) { clearTimeout(timer); resolve(); } });
    child.on('error', reject);
  });
  const hub = new Hub({getConnections: () => [{id: 'blender', kind: 'blender', name: 'Blender'}], sessionFile});
  const st = await hub.connect('blender');
  assert.equal(st.status, 'ready');
  assert.equal(st.serverInfo.name, 'aigw-blender-bridge');
  assert.equal(st.blenderSession.blender, 'cross-test');
  assert.deepEqual(hub.agentTools().map(x => x.name), ['blender__echo', 'blender__boom', 'blender__crash', 'blender__image']);
  assert.equal(hub.agentTools()[0].level, 0);
  const r = await hub.call('blender__echo', {msg: '你好'});
  assert.match(r.text, /你好/);
  const e = await hub.call('blender__boom', {});
  assert.equal(e.isError, true);
  const img = await hub.call('blender__image', {});
  assert.equal(img.images.length, 1);
  await hub.beat();
  assert.equal(hub.runtime('blender').status, 'ready', '心跳 ping 正常');
  await hub.disconnectAll();
});
