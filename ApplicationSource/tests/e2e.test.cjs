'use strict';
// 端到端：真实 main.cjs（假 electron）+ 本机模拟模型 + Python 版 Blender 桥接 + 模拟 MCP 服务
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {bootMain} = require('./helpers/fake-electron.cjs');
const {startMockLLM} = require('./helpers/mock-llm.cjs');
const {startMockMcp} = require('./helpers/mock-mcp-server.cjs');

const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const wait = (pred, ms = 8000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = () => { let v; try { v = pred(); } catch { v = false; } if (v) resolve(v); else if (Date.now() - t0 > ms) reject(Error('等待超时')); else setTimeout(tick, 25); };
  tick();
});

test('主进程端到端：模型配置 → 能力探测 → 连接 Blender → AI 调用工具 → 审批 → 持久化', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigw-e2e-'));
  const sessionFile = path.join(dataDir, 'blender_bridge.json');
  process.env.AIGW_BLENDER_SESSION_FILE = sessionFile;
  const llm = await startMockLLM();
  const mcp = await startMockMcp({mode: 'sse'});
  const py = spawn(PY, [path.join(__dirname, 'test_blender_bridge.py'), '--serve', sessionFile], {stdio: ['ignore', 'pipe', 'inherit']});
  t.after(async () => { py.kill(); await llm.close(); await mcp.close(); try { fs.rmSync(sessionFile); } catch { /* 已删除 */ } });
  await new Promise((resolve, reject) => { py.stdout.on('data', d => { if (String(d).includes('READY')) resolve(); }); py.on('error', reject); setTimeout(() => reject(Error('桥接启动超时')), 8000); });

  const m = bootMain({dataDir});
  let s = await m.invoke('snapshot');
  assert.equal(s.version, '3.0.0-alpha.3');
  assert.ok(s.v3, '快照应包含 3.0 状态');
  assert.deepEqual(s.v3.connections.map(c => c.id), ['unreal-aigw', 'unreal', 'blender']);
  assert.equal(s.v3.uePlugin, true, '自研 UE 插件随应用发布');

  // 1. 添加模型（本机服务无需密钥）并探测能力
  const {id} = await m.invoke('v3ProviderSave', {provider: {preset: 'ollama', type: 'openai', name: '本机测试模型', baseUrl: llm.url, model: 'mock-1', price: {input: 1, output: 2}}, key: 'sk-local-secret-123'});
  const caps = await m.invoke('v3ProviderProbe', {id});
  assert.deepEqual([caps.text, caps.tools, caps.vision], [true, true, true]);
  s = await m.invoke('snapshot');
  assert.equal(s.v3.roles.main, id, '第一个模型自动设为主模型');
  assert.equal(s.v3.providers[0].hasKey, true);
  assert.equal(llm.requests[0].auth, 'Bearer sk-local-secret-123');
  const keyFiles = fs.readdirSync(path.join(dataDir, 'keys'));
  assert.equal(keyFiles.length, 1);
  assert.ok(!fs.readFileSync(path.join(dataDir, 'keys', keyFiles[0])).toString('utf8').includes('sk-local-secret-123'), '密钥文件中不能有明文');
  assert.ok(!fs.readFileSync(path.join(dataDir, 'workstation.json'), 'utf8').includes('sk-local-secret-123'), '数据文件中不能有明文密钥');

  // 1b. 专长模型：单独配置，不抢主模型；同名拒绝；自定义必须写用途；可停用
  const {id: sid} = await m.invoke('v3ProviderSave', {provider: {preset: 'ollama', type: 'openai', name: '代码蓝图', baseUrl: llm.url, model: 'mock-code', role: 'specialist', specialty: 'code', notes: '只负责 UE 蓝图与 C++'}});
  s = await m.invoke('snapshot');
  assert.equal(s.v3.roles.main, id, '添加专长模型不改变主模型');
  assert.equal(s.v3.roleInfo.specialists[0].name, '代码蓝图');
  assert.equal(s.v3.roleInfo.specialists[0].label, '代码 / 蓝图');
  await assert.rejects(m.invoke('v3ProviderSave', {provider: {preset: 'ollama', type: 'openai', name: '代码蓝图', baseUrl: llm.url, model: 'x', role: 'specialist', specialty: 'fast'}}), /同名/);
  await assert.rejects(m.invoke('v3ProviderSave', {provider: {preset: 'ollama', type: 'openai', name: '自定义A', baseUrl: llm.url, model: 'x', role: 'specialist', specialty: 'custom'}}), /用途说明/);
  await assert.rejects(m.invoke('v3SetMain', {id: sid}), /专长模型不能设为主模型/);
  await m.invoke('v3SpecialistToggle', {id: sid, enabled: false});
  assert.equal((await m.invoke('snapshot')).v3.roleInfo.specialists.length, 0);
  await m.invoke('v3SpecialistToggle', {id: sid, enabled: true});

  // 2. 连接 Blender 桥接（读取会话文件）与一个自定义 MCP 服务
  const b = await m.invoke('v3Connect', {id: 'blender'});
  assert.equal(b.status, 'ready');
  const {id: cid} = await m.invoke('v3ConnSave', {name: '测试服务', url: mcp.url, autoConnect: false});
  await m.invoke('v3Connect', {id: cid});
  s = await m.invoke('snapshot');
  assert.ok(s.v3.toolCount >= 9);

  // 3. AI 自动执行只读 / 编辑工具
  await m.invoke('v3Send', {text: '帮我建一个方块并截图'});
  await wait(() => { const st = m.lastState()?.v3; return st && !st.session.running && st.session.items.some(i => i.type === 'assistant' && /完成/.test(i.text)); });
  let items = m.lastState().v3.session.items;
  const tools = items.filter(i => i.type === 'tool');
  assert.deepEqual(tools.map(i => [i.tool, i.status]), [['echo', 'ok'], ['image', 'ok']]);
  assert.equal(tools[1].images.length, 1);
  assert.ok((await m.invoke('v3Image', {id: tools[1].images[0].id})).startsWith('data:image/png;base64,'));

  // 4. 脚本工具（L2）必须审批
  await m.invoke('v3Send', {text: '跑脚本 print(1)'});
  const pending = await wait(() => m.lastState()?.v3.session.items.find(i => i.type === 'tool' && i.status === 'awaiting'));
  assert.equal(pending.level, 2);
  assert.ok(!mcp.calls.some(c => c.name === 'run_python'), '审批前不得执行');
  await m.invoke('v3Decide', {itemId: pending.id, decision: 'once'});
  await wait(() => !m.lastState().v3.session.running && mcp.calls.some(c => c.name === 'run_python'));
  items = m.lastState().v3.session.items;
  assert.equal(items.find(i => i.id === pending.id).status, 'ok');

  // 5. 账本、审计、会话持久化
  s = await m.invoke('snapshot');
  assert.ok(s.v3.spend.calls >= 4);
  assert.ok(s.v3.spend.cost > 0);
  const audit = fs.readFileSync(path.join(dataDir, 'v3', 'audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(audit.length, 3);
  assert.equal(audit[2].level, 2);
  assert.ok(audit[1].prev && audit[2].prev, '审计日志带哈希链');
  const sessId = s.v3.session.id;
  assert.ok(fs.existsSync(path.join(dataDir, 'v3', 'sessions', sessId + '.json')));
  const newId = await m.invoke('v3NewSession');
  assert.notEqual(newId, sessId);
  s = await m.invoke('snapshot');
  assert.equal(s.v3.session.items.length, 0);
  assert.ok(s.v3.sessions.some(x => x.id === sessId));
  await m.invoke('v3LoadSession', {id: sessId});
  s = await m.invoke('snapshot');
  assert.ok(s.v3.session.items.length > 5, '历史会话可恢复');

  // 6. 自研 UE 插件安装到工程（重复安装时旧版本备份到 Saved，不留在 Plugins 里）
  const ueProj = path.join(dataDir, 'UEProj');
  fs.mkdirSync(ueProj);
  fs.writeFileSync(path.join(ueProj, 'Demo.uproject'), JSON.stringify({FileVersion: 3, EngineAssociation: '5.6'}));
  const ins = await m.invoke('v3UePluginInstall', {uproject: path.join(ueProj, 'Demo.uproject')});
  assert.ok(fs.existsSync(path.join(ueProj, 'Plugins', 'AIGWBridge', 'Content', 'Python', 'aigw_unreal', 'tools.py')));
  assert.equal(ins.backup, null);
  const ins2 = await m.invoke('v3UePluginInstall', {uproject: path.join(ueProj, 'Demo.uproject')});
  assert.ok(ins2.backup && ins2.backup.includes(path.join('Saved', 'AIGWBridge-backup-')));
  assert.deepEqual(fs.readdirSync(path.join(ueProj, 'Plugins')), ['AIGWBridge']);
  fs.mkdirSync(path.join(dataDir, 'Other', 'Plugins', 'AIGWBridge'), {recursive: true});
  fs.writeFileSync(path.join(dataDir, 'Other', 'O.uproject'), '{}');
  await assert.rejects(m.invoke('v3UePluginInstall', {uproject: path.join(dataDir, 'Other', 'O.uproject')}), /不是本插件/);

  // 7. 输入校验与旧功能仍可用
  await assert.rejects(m.invoke('v3Send', {text: 'x', images: [{mime: 'text/html', data: 'AAAA'}]}), /图片格式无效/);
  await assert.rejects(m.invoke('v3ConnSave', {name: 'x', url: 'http://evil.example/mcp'}), /https/);
  await assert.rejects(m.invoke('v3SetMain', {id: 'nope'}), /不存在/);
  await assert.rejects(m.invoke('notAMethod'), /未获授权/);
  const legacy = await m.invoke('localPlan', {request: '做一个木箱', recipe: 'crate'}).catch(e => e);
  assert.match(String(legacy.message || legacy.summary), /项目|木箱/, '2.0 旧接口仍可调用');
  await m.invoke('v3Disconnect', {id: 'blender'});
  await m.invoke('v3Disconnect', {id: cid});
});
