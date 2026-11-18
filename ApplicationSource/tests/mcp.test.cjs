'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {McpHttpClient, summarizeResult, createSseParser} = require('../v3/mcp-client.cjs');
const {Hub, classifyTool, classifyCall, readBlenderSession} = require('../v3/hub.cjs');
const {startMockMcp} = require('./helpers/mock-mcp-server.cjs');

for (const mode of ['json', 'sse']) {
  test(`MCP 客户端：${mode} 响应模式完整流程`, async () => {
    const srv = await startMockMcp({mode});
    try {
      const c = new McpHttpClient({url: srv.url});
      const info = await c.connect();
      assert.equal(info.protocolVersion, '2025-06-18');
      assert.equal(info.serverInfo.name, 'mock');
      assert.ok(c.sessionId, '应保存会话 ID');
      const tools = await c.listTools();
      assert.equal(tools.length, 5, '应跨页拿到全部工具');
      const r = await c.callTool('create_object', {type: 'cube'});
      assert.match(r.content[0].text, /create_object ok/);
      const shot = summarizeResult(await c.callTool('capture_viewport', {}));
      assert.equal(shot.images.length, 1);
      assert.equal(shot.images[0].mime, 'image/png');
      await assert.rejects(c.callTool('nope', {}), /Unknown tool/);
      assert.deepEqual(await c.ping(), {});
      await c.close();
      assert.equal(srv.sessions.size, 0, 'close 应发送 DELETE 结束会话');
    } finally { await srv.close(); }
  });
}

test('MCP 客户端：令牌鉴权失败给出可读错误', async () => {
  const srv = await startMockMcp({token: 'secret-token-1234567890'});
  try {
    await assert.rejects(new McpHttpClient({url: srv.url}).connect(), /HTTP 401/);
    const ok = new McpHttpClient({url: srv.url, headers: {authorization: 'Bearer secret-token-1234567890'}});
    await ok.connect();
  } finally { await srv.close(); }
});

test('MCP 客户端：超时与停止', async () => {
  const srv = await startMockMcp();
  try {
    const c = new McpHttpClient({url: srv.url});
    await c.connect();
    await assert.rejects(c.callTool('slow', {}, {timeoutMs: 300}), /超时/);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    await assert.rejects(c.callTool('slow', {}, {signal: ctrl.signal}), /停止/);
  } finally { await srv.close(); }
});

test('MCP 客户端：连接不存在的服务', async () => {
  await assert.rejects(new McpHttpClient({url: 'http://127.0.0.1:9/mcp'}).connect(), /无法连接/);
});

test('SSE 解析器处理分片与多事件', () => {
  const got = [];
  const p = createSseParser(m => got.push(m));
  p('data: {"a"'); p(':1}\n\ndata: {"b":2}\r\n\r\n'); p(': comment\n\n');
  assert.deepEqual(got, [{a: 1}, {b: 2}]);
});

test('summarizeResult 截断文本、限制图片', () => {
  const big = 'x'.repeat(30000);
  const r = summarizeResult({content: [{type: 'text', text: big}, ...Array(5).fill({type: 'image', data: 'AAAA', mimeType: 'image/png'})], isError: true});
  assert.ok(r.text.length < 21000);
  assert.equal(r.images.length, 3);
  assert.match(r.text, /另有 2 张图像/);
  assert.equal(r.isError, true);
});

test('权限分级规则', () => {
  assert.equal(classifyTool({name: 'get_scene_info'}), 0);
  assert.equal(classifyTool({name: 'create_object'}), 1);
  assert.equal(classifyTool({name: 'run_python'}), 2);
  assert.equal(classifyTool({name: 'delete_objects'}), 3);
  assert.equal(classifyTool({name: 'spawn_actor', annotations: {readOnlyHint: true}}), 0);
  assert.equal(classifyTool({name: 'spawn_actor', annotations: {destructiveHint: true}}), 3);
  assert.equal(classifyTool({name: 'execute_console_command', annotations: {readOnlyHint: true}}), 2, '脚本类不能被 readOnlyHint 降级');
  const call = {name: 'call_tool'};
  assert.equal(classifyCall(call, {tool: 'EditorToolset.ObjectToolset.DeleteActors'}), 3);
  assert.equal(classifyCall(call, {tool: 'PythonToolset.ExecutePython', arguments: {}}), 2);
  assert.equal(classifyCall(call, {tool: 'EditorToolset.ObjectToolset.GetActors'}), 0);
  assert.equal(classifyCall(call, {tool: 'EditorToolset.ObjectToolset.SpawnActor'}), 1);
  assert.equal(classifyCall(call, {}), 1);
});

test('Hub：连接、限定名、调用、断开与 Blender 会话文件', async () => {
  const srv = await startMockMcp({token: 'tok_abcdefghijklmnopqrstuvwxyz'});
  const ue = await startMockMcp({unrealStyle: true, mode: 'sse'});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigw-'));
  const sessionFile = path.join(dir, 'blender_bridge.json');
  fs.writeFileSync(sessionFile, JSON.stringify({port: srv.port, token: 'tok_abcdefghijklmnopqrstuvwxyz', pid: process.pid, blender: '4.5.0'}));
  const conns = [{id: 'unreal', kind: 'unreal', name: 'UE', url: ue.url}, {id: 'blender', kind: 'blender', name: 'Blender', url: ''}];
  const hub = new Hub({getConnections: () => conns, sessionFile});
  let changes = 0;
  hub.on('change', () => changes++);
  try {
    assert.equal(readBlenderSession(sessionFile).port, srv.port);
    await hub.connect('blender');
    await hub.connect('unreal');
    const tools = hub.agentTools();
    assert.ok(tools.some(t => t.name === 'blender__create_object'));
    assert.ok(tools.some(t => t.name === 'ue__call_tool'));
    assert.ok(tools.every(t => /^[a-zA-Z0-9_-]{1,64}$/.test(t.name)), '工具名需符合模型接口要求');
    assert.equal(hub.levelOf('blender__delete_objects', {names: ['a']}), 3);
    assert.equal(hub.levelOf('ue__call_tool', {tool: 'X.DeleteActor'}), 3);
    assert.equal(hub.levelOf('not_exist', {}), 3);
    const r = await hub.call('blender__capture_viewport', {});
    assert.equal(r.images.length, 1);
    const st = hub.publicState();
    assert.equal(st.find(c => c.id === 'blender').status, 'ready');
    assert.equal(st.find(c => c.id === 'blender').blenderSession.blender, '4.5.0');
    assert.match(hub.instructions(), /mock instructions/);
    await hub.disconnect('blender');
    assert.ok(!hub.agentTools().some(t => t.name.startsWith('blender__')));
    await assert.rejects(hub.call('blender__create_object', {}), /不存在|断开/);
    assert.ok(changes > 3);
  } finally { await hub.disconnectAll(); await srv.close(); await ue.close(); }
});

test('Hub：自研 UE 插件连接与残留会话文件', async () => {
  const srv = await startMockMcp({token: 'tok_abcdefghijklmnopqrstuvwxyz'});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigw-'));
  const ueFile = path.join(dir, 'unreal_bridge.json');
  const conns = [{id: 'unreal-aigw', kind: 'unreal-aigw', name: 'UE 插件', url: ''}];
  const hub = new Hub({getConnections: () => conns, sessionFile: path.join(dir, 'none.json'), unrealSessionFile: ueFile});
  try {
    await assert.rejects(hub.connect('unreal-aigw'), /安装插件到工程/);
    // 进程已退出的残留会话：不当作可用，并给出原因
    fs.writeFileSync(ueFile, JSON.stringify({port: srv.port, token: 'tok_abcdefghijklmnopqrstuvwxyz', pid: 2147483000, engine: '5.6.1'}));
    assert.equal(hub.publicState()[0].session, null);
    await assert.rejects(hub.connect('unreal-aigw'), /已退出/);
    fs.writeFileSync(ueFile, JSON.stringify({port: srv.port, token: 'tok_abcdefghijklmnopqrstuvwxyz', pid: process.pid, engine: '5.6.1', project: 'D:/P/P.uproject'}));
    await hub.connect('unreal-aigw');
    const st = hub.publicState()[0];
    assert.equal(st.status, 'ready');
    assert.equal(st.session.engine, '5.6.1');
    assert.equal(st.session.token, undefined, '令牌不进入界面状态');
    assert.ok(hub.agentTools().every(t => t.name.startsWith('unreal__') && t.description.startsWith('[Unreal Engine]')));
  } finally { await hub.disconnectAll(); await srv.close(); }
});

test('Hub：UE 未启动时给出启用插件的指引', async () => {
  const conns = [{id: 'unreal', kind: 'unreal', name: 'UE', url: 'http://127.0.0.1:9/mcp'}];
  const hub = new Hub({getConnections: () => conns, sessionFile: '/nonexistent'});
  await assert.rejects(hub.connect('unreal'), /Unreal MCP 与 All Toolsets/);
  const blender = new Hub({getConnections: () => [{id: 'blender', kind: 'blender', name: 'B'}], sessionFile: '/nonexistent'});
  await assert.rejects(blender.connect('blender'), /AIGW Bridge/);
});

test('Hub：心跳发现断线并在服务恢复后重连', async () => {
  let srv = await startMockMcp();
  const port = srv.port;
  const conns = [{id: 'c1', kind: 'custom', name: 'X', url: srv.url}];
  const hub = new Hub({getConnections: () => conns, sessionFile: '/nonexistent'});
  try {
    await hub.connect('c1');
    await srv.close();
    await hub.beat();
    assert.equal(hub.runtime('c1').status, 'lost');
    // 在同一端口重启服务
    const http = require('node:http');
    const again = await startMockMcp();
    conns[0].url = again.url; srv = again;
    hub.runtime('c1').retryAt = 0;
    await hub.beat();
    assert.equal(hub.runtime('c1').status, 'ready');
    void port; void http;
  } finally { await hub.disconnectAll(); await srv.close(); }
});
