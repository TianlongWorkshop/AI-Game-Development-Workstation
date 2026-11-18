'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../v3/providers.cjs');
const {Router} = require('../v3/router.cjs');

// 记录请求并返回预设响应的假 fetch
function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({url, headers: init.headers, body});
    const {status = 200, json} = await handler({url, headers: init.headers, body, n: calls.length});
    return {ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json)};
  };
  f.calls = calls;
  return f;
}

const tools = [{name: 'blender__create_object', description: '[Blender] 创建', inputSchema: {$schema: 'x', type: 'object', properties: {type: {type: 'string', enum: ['cube']}, location: {type: 'array', items: {type: 'number'}, minItems: 3}}, required: ['type'], additionalProperties: false}}];
const convo = [
  {role: 'user', content: [{type: 'text', text: '建一个方块'}, {type: 'image', mime: 'image/png', data: P.RED_PNG}]},
  {role: 'assistant', text: '好的', toolCalls: [{id: 'c1', name: 'blender__create_object', arguments: {type: 'cube'}}]},
  {role: 'tool', toolCallId: 'c1', name: 'blender__create_object', text: '已创建', images: [{mime: 'image/png', data: P.RED_PNG}]}
];

test('配置校验：云端必须 https，本机可 http，价格范围', () => {
  assert.throws(() => P.validateProviderConfig({type: 'openai', name: 'x', model: 'm', baseUrl: 'http://example.com/v1'}), /https/);
  const local = P.validateProviderConfig({type: 'openai', name: 'Ollama', model: 'qwen3', baseUrl: 'http://127.0.0.1:11434/v1/'});
  assert.equal(local.local, true);
  assert.equal(local.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.throws(() => P.validateProviderConfig({type: 'openai', name: 'x', model: 'a b', baseUrl: 'https://a.com'}), /模型名/);
  assert.throws(() => P.validateProviderConfig({type: 'nope', name: 'x', model: 'm', baseUrl: 'https://a.com'}), /不支持/);
  assert.throws(() => P.validateProviderConfig({type: 'openai', name: 'x', model: 'm', baseUrl: 'https://a.com', price: {input: -1}}), /价格/);
});

test('OpenAI 兼容：消息、工具、图像与工具调用解析', async () => {
  const f = fakeFetch(() => ({json: {choices: [{message: {content: null, tool_calls: [{id: 'x1', type: 'function', function: {name: 'blender__create_object', arguments: '{"type":"cube"}'}}]}, finish_reason: 'tool_calls'}], usage: {prompt_tokens: 100, completion_tokens: 20}}}));
  const cfg = P.validateProviderConfig({type: 'openai', name: 'DS', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', price: {input: 0.3, output: 1.2}});
  const r = await P.chat(cfg, 'sk-test', {system: 'sys', messages: convo, tools}, f);
  const req = f.calls[0];
  assert.equal(req.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer sk-test');
  assert.equal(req.body.max_tokens, 4096);
  assert.equal(req.body.messages[0].role, 'system');
  assert.equal(req.body.messages[1].content[1].type, 'image_url');
  assert.equal(req.body.messages[2].tool_calls[0].function.arguments, '{"type":"cube"}');
  assert.equal(req.body.messages[3].role, 'tool');
  assert.equal(req.body.messages[4].role, 'user', '工具返回的图片应作为随后的用户消息发送');
  assert.equal(req.body.tools[0].function.parameters.$schema, undefined);
  assert.deepEqual(r.toolCalls, [{id: 'x1', name: 'blender__create_object', arguments: {type: 'cube'}}]);
  assert.deepEqual(r.usage, {input: 100, output: 20});
  assert.equal(P.cost(cfg, r.usage), (100 * 0.3 + 20 * 1.2) / 1e6);
});

test('OpenAI 官方地址使用 max_completion_tokens', async () => {
  const f = fakeFetch(() => ({json: {choices: [{message: {content: 'hi'}}]}}));
  const cfg = P.validateProviderConfig({type: 'openai', name: 'OA', model: 'gpt-x', baseUrl: 'https://api.openai.com/v1'});
  await P.chat(cfg, 'k', {messages: [{role: 'user', content: 'hi'}]}, f);
  assert.ok(f.calls[0].body.max_completion_tokens);
  assert.equal(f.calls[0].body.max_tokens, undefined);
});

test('Anthropic：tool_use / tool_result 映射与原样回放', async () => {
  const blocks = [{type: 'thinking', thinking: '...', signature: 'sig'}, {type: 'text', text: '我来创建'}, {type: 'tool_use', id: 'tu1', name: 'blender__create_object', input: {type: 'cube'}}];
  const f = fakeFetch(() => ({json: {content: blocks, stop_reason: 'tool_use', usage: {input_tokens: 50, output_tokens: 10}}}));
  const cfg = P.validateProviderConfig({type: 'anthropic', name: 'Claude', model: 'claude-x', baseUrl: 'https://api.anthropic.com'});
  const r = await P.chat(cfg, 'ak', {system: 'sys', messages: convo, tools}, f);
  const req = f.calls[0];
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(req.headers['x-api-key'], 'ak');
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal(req.body.system, 'sys');
  assert.equal(req.body.messages[1].content[1].type, 'tool_use');
  const tr = req.body.messages[2].content[0];
  assert.equal(tr.type, 'tool_result');
  assert.equal(tr.content[1].type, 'image', 'Anthropic 支持在 tool_result 中放图片');
  assert.equal(r.text, '我来创建');
  assert.equal(r.toolCalls[0].id, 'tu1');
  // 回放：带 raw 的助手消息应原样发送（保留 thinking 签名）
  const f2 = fakeFetch(() => ({json: {content: [{type: 'text', text: 'done'}], usage: {}}}));
  await P.chat(cfg, 'ak', {messages: [convo[0], {role: 'assistant', text: r.text, toolCalls: r.toolCalls, raw: r.raw}, convo[2]]}, f2);
  assert.deepEqual(f2.calls[0].body.messages[1].content, blocks);
});

test('Gemini：functionCall / functionResponse 与 schema 清洗', async () => {
  const parts = [{functionCall: {name: 'blender__create_object', args: {type: 'cube'}}, thoughtSignature: 'abc'}];
  const f = fakeFetch(() => ({json: {candidates: [{content: {role: 'model', parts}, finishReason: 'STOP'}], usageMetadata: {promptTokenCount: 7, candidatesTokenCount: 3}}}));
  const cfg = P.validateProviderConfig({type: 'gemini', name: 'G', model: 'gemini-x', baseUrl: 'https://generativelanguage.googleapis.com'});
  const r = await P.chat(cfg, 'gk', {system: 'sys', messages: convo, tools}, f);
  const req = f.calls[0];
  assert.match(req.url, /\/v1beta\/models\/gemini-x:generateContent$/);
  assert.equal(req.headers['x-goog-api-key'], 'gk');
  const decl = req.body.tools[0].functionDeclarations[0].parameters;
  assert.equal(decl.additionalProperties, undefined);
  assert.equal(decl.$schema, undefined);
  assert.equal(req.body.contents[1].role, 'model');
  assert.equal(req.body.contents[2].parts[0].functionResponse.name, 'blender__create_object');
  assert.equal(r.toolCalls[0].name, 'blender__create_object');
  const f2 = fakeFetch(() => ({json: {candidates: [{content: {parts: [{text: 'ok'}]}}]}}));
  await P.chat(cfg, 'gk', {messages: [convo[0], {role: 'assistant', text: '', toolCalls: r.toolCalls, raw: r.raw}, convo[2]]}, f2);
  assert.equal(f2.calls[0].body.contents[1].parts[0].thoughtSignature, 'abc', 'Gemini 思考签名必须原样回传');
});

test('错误映射：401 / 429 / 网络 / 超时 / 无密钥', async () => {
  const cfg = P.validateProviderConfig({type: 'openai', name: 'X', model: 'm', baseUrl: 'https://x.example'});
  await assert.rejects(P.chat(cfg, 'k', {messages: [{role: 'user', content: 'a'}]}, fakeFetch(() => ({status: 401, json: {error: {message: 'bad key'}}}))), /401（密钥无效.*bad key/);
  await assert.rejects(P.chat(cfg, 'k', {messages: [{role: 'user', content: 'a'}]}, fakeFetch(() => ({status: 429, json: {}}))), /限流或余额不足/);
  await assert.rejects(P.chat(cfg, 'k', {messages: [{role: 'user', content: 'a'}]}, async () => { throw Object.assign(new Error('fetch failed'), {cause: {code: 'ENOTFOUND'}}); }), /无法连接模型服务：ENOTFOUND/);
  await assert.rejects(P.chat(cfg, 'k', {messages: [{role: 'user', content: 'a'}], timeoutMs: 50}, () => new Promise(() => {})), /超时/);
  await assert.rejects(P.chat(cfg, null, {messages: [{role: 'user', content: 'a'}]}, fakeFetch(() => ({json: {}}))), /API Key/);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 30);
  await assert.rejects(P.chat(cfg, 'k', {messages: [{role: 'user', content: 'a'}], signal: ctrl.signal}, () => new Promise(() => {})), /已停止/);
});

test('能力探测：文本 / 工具 / 视觉', async () => {
  const cfg = P.validateProviderConfig({type: 'openai', name: 'X', model: 'm', baseUrl: 'https://x.example'});
  const f = fakeFetch(({body}) => {
    if (body.tools) return {json: {choices: [{message: {tool_calls: [{id: '1', type: 'function', function: {name: 'get_number', arguments: '{}'}}]}}]}};
    if (Array.isArray(body.messages[0].content)) return {status: 400, json: {error: {message: 'image input not supported'}}};
    return {json: {choices: [{message: {content: 'OK'}}]}};
  });
  const caps = await P.probe(cfg, 'k', f);
  assert.equal(caps.text, true);
  assert.equal(caps.tools, true);
  assert.equal(caps.vision, false);
  assert.match(caps.errors.vision, /image input not supported/);
});

test('Router：角色回落、记账、未配置提示', async () => {
  const providers = [P.validateProviderConfig({type: 'openai', name: 'A', model: 'm', baseUrl: 'https://a.example', price: {input: 1, output: 2}})];
  providers[0].id = 'p1'; providers[0].caps = {tools: true, vision: false};
  const usage = [];
  const f = fakeFetch(() => ({json: {choices: [{message: {content: 'hi'}}], usage: {prompt_tokens: 1000, completion_tokens: 500}}}));
  const r = new Router({getProviders: () => providers, getRoles: () => ({main: 'p1'}), getKey: () => 'k', fetchImpl: f, onUsage: e => usage.push(e)});
  assert.equal(r.provider('vision').id, 'p1', '未配置视觉模型时回落到主模型');
  assert.equal(r.supports('main', 'tools'), true);
  assert.equal(r.supports('vision', 'vision'), false);
  const res = await r.chat('main', {messages: [{role: 'user', content: 'x'}]}, {sessionId: 's'});
  assert.equal(res.cost, (1000 * 1 + 500 * 2) / 1e6);
  assert.equal(usage[0].sessionId, 's');
  const empty = new Router({getProviders: () => [], getRoles: () => ({}), getKey: () => null});
  await assert.rejects(empty.chat('main', {messages: []}), /尚未配置主模型/);
});
