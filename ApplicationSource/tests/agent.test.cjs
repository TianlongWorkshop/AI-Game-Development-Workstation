'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {AgentSession, buildSystemPrompt} = require('../v3/agent.cjs');
const {Hub} = require('../v3/hub.cjs');
const {Router} = require('../v3/router.cjs');
const {startMockMcp} = require('./helpers/mock-mcp-server.cjs');
const P = require('../v3/providers.cjs');

// 脚本化的“模型”：按顺序返回预设回复（OpenAI 兼容格式）
function scriptedFetch(replies) {
  const seen = [];
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    const r = typeof replies[seen.length - 1] === 'function' ? replies[seen.length - 1](body) : replies[seen.length - 1];
    if (!r) throw Error('脚本已用完');
    if (r.hang) return new Promise(() => {});
    return {ok: true, status: 200, text: async () => JSON.stringify({choices: [{message: r, finish_reason: r.tool_calls ? 'tool_calls' : 'stop'}], usage: {prompt_tokens: 10, completion_tokens: 5}})};
  };
  f.seen = seen;
  return f;
}
const call = (name, args, id = 'c' + Math.random().toString(36).slice(2, 7)) => ({id, type: 'function', function: {name, arguments: JSON.stringify(args)}});

async function setup(replies, {mode = 'auto', vision = true, specialists = []} = {}) {
  const srv = await startMockMcp();
  const conns = [{id: 'c', kind: 'custom', name: 'Mock', url: srv.url}];
  const hub = new Hub({getConnections: () => conns, sessionFile: '/nonexistent'});
  await hub.connect('c');
  const provider = {...P.validateProviderConfig({type: 'openai', name: 'M', model: 'm', baseUrl: 'https://m.example', price: {input: 1, output: 1}}), id: 'p', caps: {text: true, tools: true, vision}};
  const fetchImpl = scriptedFetch(replies);
  const router = new Router({getProviders: () => [provider, ...specialists], getRoles: () => ({main: 'p'}), getKey: () => 'k', fetchImpl});
  const audit = [];
  const s = new AgentSession({router, hub, getMode: () => mode, onAudit: a => audit.push(a), buildSystem: () => 'SYS'});
  const prefix = hub.agentTools()[0].name.split('__')[0];
  return {srv, hub, s, fetchImpl, audit, prefix, cleanup: async () => { await hub.disconnectAll(); await srv.close(); }};
}

function waitFor(pred, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => { if (pred()) resolve(); else if (Date.now() - t0 > ms) reject(Error('等待超时')); else setTimeout(tick, 10); };
    tick();
  });
}

test('Agent：自动模式下只读与编辑工具直接执行，截图回传给模型', async () => {
  const ctx = await setup([
    b => ({content: '先看场景', tool_calls: [call(b.tools[0].function.name.split('__')[0] + '__get_scene_info', {}), call(b.tools[0].function.name.split('__')[0] + '__create_object', {type: 'cube'})]}),
    b => ({content: null, tool_calls: [call(b.tools[0].function.name.split('__')[0] + '__capture_viewport', {})]}),
    {content: '完成：已创建方块并截图确认。'}
  ]);
  try {
    await ctx.s.send({text: '建一个方块'});
    const types = ctx.s.items.map(i => i.type);
    assert.deepEqual(types, ['user', 'assistant', 'tool', 'tool', 'tool', 'assistant']);
    assert.ok(ctx.s.items.filter(i => i.type === 'tool').every(i => i.status === 'ok'));
    const shot = ctx.s.items.find(i => i.tool === 'capture_viewport');
    assert.equal(shot.images.length, 1);
    assert.ok(ctx.s.image(shot.images[0].id).startsWith('data:image/png;base64,'));
    const last = ctx.fetchImpl.seen[2].messages;
    assert.ok(last.some(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(p => p.type === 'image_url')), '截图应发送给支持视觉的主模型');
    assert.equal(ctx.fetchImpl.seen[0].messages[0].content, 'SYS');
    assert.equal(ctx.audit.length, 3);
    assert.equal(ctx.s.totals.input, 30);
    assert.equal(ctx.s.running, false);
  } finally { await ctx.cleanup(); }
});

test('Agent：L2 脚本与 L3 删除必须审批；拒绝后告知模型', async () => {
  const ctx = await setup([
    b => ({content: null, tool_calls: [call(b.tools[0].function.name.split('__')[0] + '__run_python', {code: 'print(1)'}), call(b.tools[0].function.name.split('__')[0] + '__delete_objects', {names: ['Cube']})]}),
    {content: '好的，不删除。'}
  ]);
  try {
    const done = ctx.s.send({text: '跑脚本然后删掉方块'});
    await waitFor(() => ctx.s.items.some(i => i.type === 'tool' && i.status === 'awaiting'));
    const py = ctx.s.items.find(i => i.tool === 'run_python');
    assert.equal(py.level, 2);
    ctx.s.decide(py.id, 'once');
    await waitFor(() => ctx.s.items.some(i => i.tool === 'delete_objects' && i.status === 'awaiting'));
    const del = ctx.s.items.find(i => i.tool === 'delete_objects');
    assert.equal(del.level, 3);
    ctx.s.decide(del.id, 'deny');
    await done;
    assert.equal(py.status, 'ok');
    assert.equal(del.status, 'denied');
    const toolMsgs = ctx.fetchImpl.seen[1].messages.filter(m => m.role === 'tool');
    assert.match(toolMsgs[1].content, /用户拒绝/);
    assert.ok(!ctx.srv.calls.some(c => c.name === 'delete_objects'), '被拒绝的工具不能被执行');
    assert.throws(() => ctx.s.decide(del.id, 'once'), /已处理/);
  } finally { await ctx.cleanup(); }
});

test('Agent：询问模式下编辑操作也要确认；“本会话允许”后不再询问', async () => {
  const ctx = await setup([
    b => ({tool_calls: [call(b.tools[0].function.name.split('__')[0] + '__create_object', {type: 'cube'})]}),
    b => ({tool_calls: [call(b.tools[0].function.name.split('__')[0] + '__create_object', {type: 'plane'})]}),
    {content: '两个都建好了'}
  ], {mode: 'ask'});
  try {
    const done = ctx.s.send({text: '建两个'});
    await waitFor(() => ctx.s.items.some(i => i.status === 'awaiting'));
    ctx.s.decide(ctx.s.items.find(i => i.status === 'awaiting').id, 'session');
    await done;
    const tools = ctx.s.items.filter(i => i.type === 'tool');
    assert.equal(tools.length, 2);
    assert.equal(tools[0].approval, 'session');
    assert.equal(tools[1].approval, null, '同类操作本会话已允许，不再询问');
    assert.equal(ctx.srv.calls.length, 2);
  } finally { await ctx.cleanup(); }
});

test('Agent：停止会中断等待中的模型请求和审批', async () => {
  const ctx = await setup([{hang: true}]);
  try {
    const done = ctx.s.send({text: '做点什么'});
    await waitFor(() => ctx.s.running && ctx.fetchImpl.seen.length === 1);
    assert.equal(ctx.s.stop(), true);
    await done;
    assert.equal(ctx.s.running, false);
    assert.equal(ctx.s.items.at(-1).type, 'info');
    assert.match(ctx.s.items.at(-1).text, /已停止/);
    assert.ok(!ctx.s.items.some(i => i.type === 'error'), '用户主动停止不应显示为错误');
  } finally { await ctx.cleanup(); }
});

test('Agent：主模型不支持视觉时，用户图片不发送并给出提示', async () => {
  const ctx = await setup([{content: '收到文字'}], {vision: false});
  try {
    await ctx.s.send({text: '看图', images: [{mime: 'image/png', data: P.RED_PNG}]});
    const sent = ctx.fetchImpl.seen[0].messages[1];
    assert.equal(typeof sent.content, 'string', '没有图像时以纯文本发送');
    assert.match(sent.content, /未能查看/);
    assert.ok(ctx.s.items.some(i => i.type === 'info' && /不支持图像/.test(i.text)));
  } finally { await ctx.cleanup(); }
});

test('Agent：模型调用不存在的工具时返回错误而不崩溃；会话可持久化与恢复', async () => {
  const ctx = await setup([{tool_calls: [call('ghost__tool', {})]}, {content: '那我换个办法'}]);
  try {
    await ctx.s.send({text: 'x', images: [{mime: 'image/png', data: P.RED_PNG}]});
    assert.equal(ctx.s.items.find(i => i.type === 'tool').status, 'error');
    const saved = JSON.parse(JSON.stringify(ctx.s.persistable()));
    assert.ok(!JSON.stringify(saved).includes(P.RED_PNG), '持久化内容不包含图像数据');
    const restored = AgentSession.restore(saved, {router: ctx.s.router, hub: ctx.hub});
    assert.equal(restored.items.length, ctx.s.items.length);
    assert.equal(restored.messages.length, ctx.s.messages.length);
  } finally { await ctx.cleanup(); }
});

test('系统提示词包含环境、权限模式与 Unreal 工具搜索说明', () => {
  const s = buildSystemPrompt({projectName: '我的游戏', connections: [{name: 'UE', kind: 'unreal', status: 'ready', toolCount: 4}], mode: 'ask', toolCount: 4, rules: '命名用 SM_ 前缀'});
  assert.match(s, /我的游戏/);
  assert.match(s, /询问/);
  assert.match(s, /ue__list_toolsets/);
  assert.match(s, /SM_ 前缀/);
});

test('Agent：主模型请教专长模型（consult_specialist），专长模型拿到截图并计费', async () => {
  const spec = {...P.validateProviderConfig({type: 'openai', name: '代码蓝图', model: 'spec-m', baseUrl: 'https://s.example', price: {input: 2, output: 2}, role: 'specialist', specialty: 'code', notes: '负责蓝图'}), id: 's1', caps: {text: true, tools: false, vision: true}};
  const off = {...P.validateProviderConfig({type: 'openai', name: '停用的', model: 'x', baseUrl: 'https://x.example', role: 'specialist', specialty: 'fast', enabled: false}), id: 's2'};
  const ctx = await setup([
    b => {
      const t = b.tools.find(t => t.function.name === 'consult_specialist');
      assert.ok(t, '有专长模型时出现 consult_specialist 工具');
      assert.deepEqual(t.function.parameters.properties.specialist.enum, ['代码蓝图'], '停用的专长模型不出现');
      return {content: '先截图', tool_calls: [call(b.tools[0].function.name.split('__')[0] + '__capture_viewport', {})]};
    },
    {content: null, tool_calls: [call('consult_specialist', {specialist: '代码蓝图', task: '这个蓝图哪里错了？', include_recent_screenshots: true})]},
    b => { assert.equal(b.model, 'spec-m', '请教时调用专长模型'); assert.ok(Array.isArray(b.messages[1].content) && b.messages[1].content.some(p => p.type === 'image_url'), '附带了最近截图'); assert.match(b.messages[0].content, /负责蓝图/); return {content: '把 Branch 的条件连到 IsValid 输出', usage: {prompt_tokens: 1000, completion_tokens: 1000}}; },
    b => { const last = b.messages.at(-1); assert.match(String(last.content), /IsValid/); return {content: '完成：按专长模型建议修改。'}; }
  ], {specialists: [spec, off]});
  try {
    await ctx.s.send({text: '检查蓝图'});
    const it = ctx.s.items.find(i => i.tool === 'consult_specialist');
    assert.equal(it.status, 'ok');
    assert.equal(it.kind, 'specialist');
    assert.match(it.resultText, /代码蓝图 · spec-m/);
    assert.equal(ctx.s.totals.input, 40, '专长模型的用量计入会话（4 次调用）');
    assert.match(ctx.s.items.at(-1).text, /完成/);
  } finally { await ctx.cleanup(); }
});

test('Agent：主模型不能识图时由“视觉识图”专长代看，未通过识图检测的不用', async () => {
  const eye = {...P.validateProviderConfig({type: 'openai', name: '看图', model: 'eye', baseUrl: 'https://e.example', role: 'specialist', specialty: 'vision'}), id: 'v1', caps: {text: true, tools: false, vision: true}};
  const ctx = await setup([
    b => { assert.equal(b.model, 'eye'); return {content: '一张纯红色的小图'}; },
    b => { assert.match(String(b.messages[1].content), /纯红色/); assert.match(String(b.messages[1].content), /视觉专长模型「看图」/); return {content: '好的'}; }
  ], {vision: false, specialists: [eye]});
  try {
    await ctx.s.send({text: '看图', images: [{mime: 'image/png', data: P.RED_PNG}]});
    assert.equal(ctx.s.items.at(-1).text, '好的');
  } finally { await ctx.cleanup(); }
});

test('系统提示词列出专长模型并说明何时请教', () => {
  const s = buildSystemPrompt({connections: [], specialists: [{name: '代码蓝图', specialty: 'code'}, {name: '看图', specialty: 'vision'}]});
  assert.match(s, /代码蓝图（代码 \/ 蓝图）/);
  assert.match(s, /consult_specialist/);
  assert.doesNotMatch(buildSystemPrompt({connections: []}), /consult_specialist/);
});
