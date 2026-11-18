'use strict';
// AIGW 3.0 · 模型路由
// 统一三类接口：OpenAI 兼容（OpenAI / DeepSeek / 通义千问 / Ollama / vLLM / LM Studio）、Anthropic、Gemini。
// 统一消息格式（与具体供应商无关）：
//   {role:'user', content:[{type:'text',text}|{type:'image',mime,data}]}
//   {role:'assistant', text, toolCalls:[{id,name,arguments}], raw:{provider,content}}
//   {role:'tool', toolCallId, name, text, images:[{mime,data}], isError}
// 统一工具格式：{name, description, inputSchema}
// 返回：{text, toolCalls, usage:{input,output}, stopReason, raw}

const PRESETS = {
  openai: {type: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1'},
  deepseek: {type: 'openai', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com'},
  qwen: {type: 'openai', label: '通义千问（DashScope 兼容模式）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1'},
  ollama: {type: 'openai', label: 'Ollama 本地', baseUrl: 'http://127.0.0.1:11434/v1', keyOptional: true},
  lmstudio: {type: 'openai', label: 'LM Studio 本地', baseUrl: 'http://127.0.0.1:1234/v1', keyOptional: true},
  anthropic: {type: 'anthropic', label: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com'},
  gemini: {type: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com'},
  custom: {type: 'openai', label: '其他 OpenAI 兼容服务', baseUrl: ''}
};
const TYPES = ['openai', 'anthropic', 'gemini'];
const ROLES = ['main', 'vision', 'cheap'];
// 专长模型：主模型之外按用途单独配置的模型，可以有多个
const SPECIALTIES = {
  vision: {label: '视觉识图', hint: '看截图、参考图，判断效果是否符合要求；主模型不能识图时由它代看', needs: 'vision'},
  code: {label: '代码 / 蓝图', hint: '编写或审查 C++、Python、蓝图逻辑，分析编译错误与日志'},
  art: {label: '3D / 动画 / 美术', hint: '建模、骨骼动画、材质贴图、风格与配色方面的方案和建议'},
  fast: {label: '快速省钱', hint: '简单任务：总结、命名、改写、列清单等，费用低'},
  custom: {label: '自定义', hint: '按你写的用途说明使用'}
};

class ProviderError extends Error {
  constructor(message, {status = 0, retryable = false} = {}) { super(message); this.status = status; this.retryable = retryable; }
}

function trimSlash(u) { return String(u || '').trim().replace(/\/+$/, ''); }

function validateProviderConfig(p) {
  if (!p || typeof p !== 'object') throw Error('模型配置无效');
  if (!TYPES.includes(p.type)) throw Error('不支持的接口类型：' + p.type);
  const name = String(p.name || '').trim();
  if (!name || name.length > 60) throw Error('请填写 1–60 字的名称');
  const model = String(p.model || '').trim();
  if (!model || model.length > 120 || /\s/.test(model)) throw Error('请填写模型名（不含空格）');
  const baseUrl = trimSlash(p.baseUrl);
  let u;
  try { u = new URL(baseUrl); } catch { throw Error('接口地址无效'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw Error('云端接口必须使用 https；只有本机服务可以用 http');
  const price = p.price && typeof p.price === 'object' ? p.price : {};
  const num = v => (v === '' || v === null || v === undefined) ? null : Number(v);
  const input = num(price.input), output = num(price.output);
  for (const v of [input, output]) if (v !== null && (!Number.isFinite(v) || v < 0 || v > 1000)) throw Error('价格需为 0–1000 的数字（美元 / 百万 token）');
  const role = p.role === 'specialist' ? 'specialist' : 'main';
  const out = {
    id: String(p.id || ''), type: p.type, name, model, baseUrl,
    preset: PRESETS[p.preset] ? p.preset : 'custom',
    local,
    maxOutputTokens: Math.min(Math.max(Number(p.maxOutputTokens) || 4096, 256), 64000),
    price: {input, output},
    role
  };
  if (role === 'specialist') {
    if (!SPECIALTIES[p.specialty]) throw Error('请选择专长类型');
    const notes = String(p.notes || '').trim();
    if (notes.length > 400) throw Error('用途说明请控制在 400 字以内');
    if (p.specialty === 'custom' && !notes) throw Error('自定义专长需要填写用途说明，主模型据此判断什么时候请教它');
    Object.assign(out, {specialty: p.specialty, notes, enabled: p.enabled !== false});
  }
  return out;
}

// ---------- 通用 HTTP ----------
async function postJSON(fetchImpl, url, headers, body, {timeoutMs = 120000, signal} = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => ctrl.abort(signal.reason || new Error('aborted'));
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, {once: true}); }
  let res, text;
  // 部分 fetch 实现可能不响应 AbortSignal，用 race 兜底保证超时与停止一定生效
  const aborted = new Promise((_, reject) => ctrl.signal.addEventListener('abort', () => reject(ctrl.signal.reason || new Error('aborted')), {once: true}));
  aborted.catch(() => {});
  try {
    res = await Promise.race([fetchImpl(url, {method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify(body), signal: ctrl.signal}), aborted]);
    text = await Promise.race([res.text(), aborted]);
  } catch (e) {
    if (signal?.aborted) throw new ProviderError('已停止', {status: -1});
    if (ctrl.signal.aborted) throw new ProviderError('模型请求超时（' + Math.round(timeoutMs / 1000) + ' 秒）；远端是否计费未知，未自动重试。', {retryable: true});
    throw new ProviderError('无法连接模型服务：' + (e.cause?.code || e.message) + '。请检查网络、代理或接口地址。', {retryable: true});
  } finally { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); }
  if (text.length > 8 * 1024 * 1024) throw new ProviderError('模型响应过大');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  if (!res.ok) {
    const detail = String(json?.error?.message || json?.message || json?.error || text || '').slice(0, 300);
    const hint = res.status === 401 || res.status === 403 ? '密钥无效或没有该模型权限' : res.status === 404 ? '接口地址或模型名不存在' : res.status === 429 ? '触发限流或余额不足' : res.status >= 500 ? '服务端错误' : '请求被拒绝';
    throw new ProviderError(`模型服务返回 HTTP ${res.status}（${hint}）：${detail}`, {status: res.status, retryable: res.status === 429 || res.status >= 500});
  }
  if (!json || typeof json !== 'object') throw new ProviderError('模型返回内容无法解析');
  return json;
}

function safeParseArgs(s) {
  if (s && typeof s === 'object') return s;
  if (typeof s !== 'string' || !s.trim()) return {};
  try { const v = JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? v : {value: v}; } catch { return {_raw: s}; }
}

function userParts(content) {
  if (typeof content === 'string') return [{type: 'text', text: content}];
  return Array.isArray(content) ? content : [];
}

// ---------- OpenAI 兼容 ----------
function toOpenAIMessages(system, messages) {
  const out = [];
  if (system) out.push({role: 'system', content: system});
  let pendingImages = [];
  const flushImages = () => {
    if (!pendingImages.length) return;
    out.push({role: 'user', content: [{type: 'text', text: '以下是上面工具调用返回的图像：'}, ...pendingImages.map(i => ({type: 'image_url', image_url: {url: `data:${i.mime};base64,${i.data}`}}))]});
    pendingImages = [];
  };
  for (const m of messages) {
    if (m.role !== 'tool') flushImages();
    if (m.role === 'user') {
      const parts = userParts(m.content);
      const hasImage = parts.some(p => p.type === 'image');
      out.push({role: 'user', content: hasImage ? parts.map(p => p.type === 'image' ? {type: 'image_url', image_url: {url: `data:${p.mime};base64,${p.data}`}} : {type: 'text', text: p.text}) : parts.map(p => p.text).join('\n')});
    } else if (m.role === 'assistant') {
      const msg = {role: 'assistant', content: m.text || null};
      if (m.toolCalls?.length) msg.tool_calls = m.toolCalls.map(c => ({id: c.id, type: 'function', function: {name: c.name, arguments: JSON.stringify(c.arguments || {})}}));
      out.push(msg);
    } else if (m.role === 'tool') {
      out.push({role: 'tool', tool_call_id: m.toolCallId, content: m.text || (m.isError ? '工具执行失败' : '完成')});
      if (m.images?.length) pendingImages.push(...m.images);
    }
  }
  flushImages();
  return out;
}

async function chatOpenAI(cfg, key, req, fetchImpl) {
  const body = {model: cfg.model, messages: toOpenAIMessages(req.system, req.messages)};
  const official = /api\.openai\.com/.test(cfg.baseUrl);
  body[official ? 'max_completion_tokens' : 'max_tokens'] = req.maxTokens || cfg.maxOutputTokens;
  if (req.tools?.length) {
    body.tools = req.tools.map(t => ({type: 'function', function: {name: t.name, description: String(t.description || '').slice(0, 1024), parameters: normalizeSchema(t.inputSchema)}}));
    body.tool_choice = 'auto';
  }
  const headers = key ? {authorization: 'Bearer ' + key} : {};
  const j = await postJSON(fetchImpl, cfg.baseUrl + '/chat/completions', headers, body, req);
  const choice = j.choices?.[0];
  if (!choice?.message) throw new ProviderError('模型没有返回内容');
  const msg = choice.message;
  const toolCalls = (msg.tool_calls || []).filter(c => c.type === 'function' || c.function).map((c, i) => ({id: c.id || 'call_' + i + '_' + Date.now(), name: c.function.name, arguments: safeParseArgs(c.function.arguments)}));
  let text = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map(p => p.text || '').join('') : '';
  return {text, toolCalls, usage: {input: Number(j.usage?.prompt_tokens) || 0, output: Number(j.usage?.completion_tokens) || 0}, stopReason: choice.finish_reason || '', raw: null};
}

// ---------- Anthropic ----------
function toAnthropicMessages(messages) {
  const out = [];
  const push = (role, blocks) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks); else out.push({role, content: [...blocks]});
  };
  for (const m of messages) {
    if (m.role === 'user') {
      push('user', userParts(m.content).map(p => p.type === 'image' ? {type: 'image', source: {type: 'base64', media_type: p.mime, data: p.data}} : {type: 'text', text: p.text || ' '}));
    } else if (m.role === 'assistant') {
      if (m.raw?.provider === 'anthropic' && Array.isArray(m.raw.content)) { push('assistant', m.raw.content); continue; }
      const blocks = [];
      if (m.text) blocks.push({type: 'text', text: m.text});
      for (const c of m.toolCalls || []) blocks.push({type: 'tool_use', id: c.id, name: c.name, input: c.arguments || {}});
      if (!blocks.length) blocks.push({type: 'text', text: ' '});
      push('assistant', blocks);
    } else if (m.role === 'tool') {
      const content = [{type: 'text', text: m.text || (m.isError ? '工具执行失败' : '完成')}];
      for (const i of m.images || []) content.push({type: 'image', source: {type: 'base64', media_type: i.mime, data: i.data}});
      push('user', [{type: 'tool_result', tool_use_id: m.toolCallId, content, ...(m.isError ? {is_error: true} : {})}]);
    }
  }
  return out;
}

async function chatAnthropic(cfg, key, req, fetchImpl) {
  const body = {model: cfg.model, max_tokens: req.maxTokens || cfg.maxOutputTokens, messages: toAnthropicMessages(req.messages)};
  if (req.system) body.system = req.system;
  if (req.tools?.length) body.tools = req.tools.map(t => ({name: t.name, description: String(t.description || '').slice(0, 1024), input_schema: normalizeSchema(t.inputSchema)}));
  const j = await postJSON(fetchImpl, cfg.baseUrl + '/v1/messages', {'x-api-key': key, 'anthropic-version': '2023-06-01'}, body, req);
  const blocks = Array.isArray(j.content) ? j.content : [];
  return {
    text: blocks.filter(b => b.type === 'text').map(b => b.text).join(''),
    toolCalls: blocks.filter(b => b.type === 'tool_use').map(b => ({id: b.id, name: b.name, arguments: b.input || {}})),
    usage: {input: Number(j.usage?.input_tokens) || 0, output: Number(j.usage?.output_tokens) || 0},
    stopReason: j.stop_reason || '',
    raw: {provider: 'anthropic', content: blocks}
  };
}

// ---------- Gemini ----------
const GEMINI_SCHEMA_KEYS = new Set(['type', 'properties', 'required', 'items', 'enum', 'description', 'nullable', 'format', 'minimum', 'maximum', 'minItems', 'maxItems', 'anyOf']);
function geminiSchema(s) {
  if (!s || typeof s !== 'object') return {type: 'object', properties: {}};
  if (Array.isArray(s)) return s.map(geminiSchema);
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (!GEMINI_SCHEMA_KEYS.has(k)) continue;
    if (k === 'properties') { out.properties = {}; for (const [pk, pv] of Object.entries(v || {})) out.properties[pk] = geminiSchema(pv); }
    else if (k === 'items' || k === 'anyOf') out[k] = geminiSchema(v);
    else if (k === 'type' && Array.isArray(v)) { const t = v.filter(x => x !== 'null'); out.type = t[0] || 'string'; if (v.includes('null')) out.nullable = true; }
    else if (k === 'format' && !['enum', 'date-time'].includes(v)) continue;
    else out[k] = v;
  }
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}

function toGeminiContents(messages) {
  const out = [];
  const push = (role, parts) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(...parts); else out.push({role, parts: [...parts]});
  };
  for (const m of messages) {
    if (m.role === 'user') push('user', userParts(m.content).map(p => p.type === 'image' ? {inlineData: {mimeType: p.mime, data: p.data}} : {text: p.text || ' '}));
    else if (m.role === 'assistant') {
      if (m.raw?.provider === 'gemini' && Array.isArray(m.raw.content)) { push('model', m.raw.content); continue; }
      const parts = [];
      if (m.text) parts.push({text: m.text});
      for (const c of m.toolCalls || []) parts.push({functionCall: {name: c.name, args: c.arguments || {}}});
      if (!parts.length) parts.push({text: ' '});
      push('model', parts);
    } else if (m.role === 'tool') {
      const parts = [{functionResponse: {name: m.name, response: {result: m.text || '', isError: !!m.isError}}}];
      for (const i of m.images || []) parts.push({inlineData: {mimeType: i.mime, data: i.data}});
      push('user', parts);
    }
  }
  return out;
}

async function chatGemini(cfg, key, req, fetchImpl) {
  const body = {contents: toGeminiContents(req.messages), generationConfig: {maxOutputTokens: req.maxTokens || cfg.maxOutputTokens}};
  if (req.system) body.systemInstruction = {parts: [{text: req.system}]};
  if (req.tools?.length) body.tools = [{functionDeclarations: req.tools.map(t => ({name: t.name, description: String(t.description || '').slice(0, 1024), parameters: geminiSchema(normalizeSchema(t.inputSchema))}))}];
  const url = `${cfg.baseUrl}/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`;
  const j = await postJSON(fetchImpl, url, {'x-goog-api-key': key}, body, req);
  const cand = j.candidates?.[0];
  if (!cand) throw new ProviderError('模型没有返回候选结果' + (j.promptFeedback?.blockReason ? '（被安全策略拦截：' + j.promptFeedback.blockReason + '）' : ''));
  const parts = cand.content?.parts || [];
  return {
    text: parts.filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join(''),
    toolCalls: parts.filter(p => p.functionCall).map((p, i) => ({id: p.functionCall.id || `gem_${Date.now()}_${i}`, name: p.functionCall.name, arguments: p.functionCall.args || {}})),
    usage: {input: Number(j.usageMetadata?.promptTokenCount) || 0, output: Number(j.usageMetadata?.candidatesTokenCount) || 0},
    stopReason: cand.finishReason || '',
    raw: {provider: 'gemini', content: parts}
  };
}

// ---------- 公共 ----------
function normalizeSchema(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return {type: 'object', properties: {}};
  const out = JSON.parse(JSON.stringify(s));
  delete out.$schema;
  if (!out.type) out.type = 'object';
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}

async function chat(cfg, key, req, fetchImpl = globalThis.fetch) {
  if (!cfg.local && !key) throw new ProviderError('尚未为「' + cfg.name + '」保存 API Key');
  if (cfg.type === 'openai') return chatOpenAI(cfg, key, req, fetchImpl);
  if (cfg.type === 'anthropic') return chatAnthropic(cfg, key, req, fetchImpl);
  if (cfg.type === 'gemini') return chatGemini(cfg, key, req, fetchImpl);
  throw new ProviderError('不支持的接口类型');
}

// 8×8 纯红 PNG，用于视觉能力探测
const RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC';

async function probe(cfg, key, fetchImpl = globalThis.fetch) {
  const result = {checkedAt: new Date().toISOString(), text: false, tools: false, vision: false, errors: {}, usage: {input: 0, output: 0}};
  const opts = {maxTokens: 512, timeoutMs: 60000};
  const count = r => { result.usage.input += r.usage?.input || 0; result.usage.output += r.usage?.output || 0; return r; };
  try {
    const r = count(await chat(cfg, key, {...opts, system: '你是连接测试助手。', messages: [{role: 'user', content: '只回复两个字母：OK'}]}, fetchImpl));
    result.text = !!(r.text || '').trim();
    if (!result.text) result.errors.text = '模型返回了空文本';
  } catch (e) { result.errors.text = e.message; return result; }
  try {
    const r = count(await chat(cfg, key, {...opts, messages: [{role: 'user', content: '请调用 get_number 工具获取数字，不要直接回答。'}], tools: [{name: 'get_number', description: '返回一个测试数字', inputSchema: {type: 'object', properties: {reason: {type: 'string'}}}}]}, fetchImpl));
    result.tools = r.toolCalls.some(c => c.name === 'get_number');
    if (!result.tools) result.errors.tools = '模型没有发起工具调用';
  } catch (e) { result.errors.tools = e.message; }
  try {
    const r = count(await chat(cfg, key, {...opts, messages: [{role: 'user', content: [{type: 'image', mime: 'image/png', data: RED_PNG}, {type: 'text', text: '这张图片是什么颜色？只回答颜色。'}]}]}, fetchImpl));
    result.vision = /红|red|rouge|rot/i.test(r.text || '');
    if (!result.vision) result.errors.vision = '模型未能识别测试图像：' + String(r.text || '').slice(0, 60);
  } catch (e) { result.errors.vision = e.message; }
  return result;
}

function cost(cfg, usage) {
  if (!cfg?.price || cfg.price.input === null || cfg.price.output === null || cfg.price.input === undefined || cfg.price.output === undefined) return null;
  return (usage.input * cfg.price.input + usage.output * cfg.price.output) / 1e6;
}

module.exports = {PRESETS, TYPES, ROLES, SPECIALTIES, ProviderError, validateProviderConfig, chat, probe, cost, normalizeSchema, geminiSchema, toOpenAIMessages, toAnthropicMessages, toGeminiContents, RED_PNG};
