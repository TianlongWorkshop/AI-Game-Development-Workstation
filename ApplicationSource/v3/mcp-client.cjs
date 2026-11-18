'use strict';
// AIGW 3.0 · 最小 MCP 客户端（Streamable HTTP 传输）
// 对接：UE 5.8+ 官方 Unreal MCP（默认 http://127.0.0.1:8000/mcp）、AIGW Blender Bridge、其他 MCP 服务。
// 支持：initialize / notifications/initialized / tools/list（分页）/ tools/call / ping / 会话 ID / JSON 或 SSE 响应。

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const PREFERRED_VERSION = '2025-06-18';

class McpError extends Error {
  constructor(message, {code = 0, data} = {}) { super(message); this.code = code; this.data = data; }
}

// 解析 SSE 文本流，逐个返回 data 事件的 JSON
function createSseParser(onMessage) {
  let buffer = '', data = [];
  return chunk => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.search(/\r?\n/)) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + (buffer[idx] === '\r' ? 2 : 1));
      if (line === '') {
        if (data.length) { const text = data.join('\n'); data = []; try { onMessage(JSON.parse(text)); } catch { /* 忽略非 JSON 事件 */ } }
      } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
  };
}

class McpHttpClient {
  constructor({url, headers = {}, fetchImpl = globalThis.fetch, timeoutMs = 120000, clientInfo = {name: 'ai-game-workstation', version: '3.0.0-alpha.1'}, onNotification} = {}) {
    if (!url) throw Error('缺少 MCP 地址');
    this.url = url;
    this.headers = headers;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.clientInfo = clientInfo;
    this.onNotification = onNotification || (() => {});
    this.sessionId = null;
    this.protocolVersion = null;
    this.serverInfo = null;
    this.serverCapabilities = null;
    this.instructions = '';
    this.nextId = 1;
  }

  baseHeaders() {
    const h = {'content-type': 'application/json', accept: 'application/json, text/event-stream', ...this.headers};
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    if (this.protocolVersion) h['mcp-protocol-version'] = this.protocolVersion;
    return h;
  }

  async post(message, {timeoutMs = this.timeoutMs, signal} = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
    const onAbort = () => ctrl.abort(new Error('aborted'));
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, {once: true}); }
    try {
      let res;
      try {
        res = await this.fetch(this.url, {method: 'POST', headers: this.baseHeaders(), body: JSON.stringify(message), signal: ctrl.signal});
      } catch (e) {
        if (signal?.aborted) throw new McpError('已停止', {code: -1});
        if (ctrl.signal.aborted) throw new McpError(`MCP 请求超时（${Math.round(timeoutMs / 1000)} 秒）`, {code: -2});
        throw new McpError('无法连接 MCP 服务：' + (e.cause?.code || e.message), {code: -3});
      }
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
      if (res.status === 202 || res.status === 204) { await res.text().catch(() => ''); return null; }
      if (res.status === 404 && this.sessionId && message.method !== 'initialize') throw new McpError('MCP 会话已失效，需要重新连接', {code: 404});
      const type = (res.headers.get('content-type') || '').toLowerCase();
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        let detail = t;
        try { const j = JSON.parse(t); detail = j.error?.message || t; } catch { /* 原文 */ }
        throw new McpError(`MCP 服务返回 HTTP ${res.status}${res.status === 401 || res.status === 403 ? '（未授权，请检查令牌或 Origin 设置）' : ''}：${String(detail).slice(0, 200)}`, {code: res.status});
      }
      if (message.id === undefined) { await res.text().catch(() => ''); return null; }
      if (type.includes('text/event-stream')) return await this.readSse(res, message.id, ctrl);
      const text = await res.text();
      let j;
      try { j = JSON.parse(text); } catch { throw new McpError('MCP 响应不是有效 JSON'); }
      const list = Array.isArray(j) ? j : [j];
      const reply = list.find(m => m && m.id === message.id);
      for (const m of list) if (m && m.id === undefined && m.method) this.onNotification(m);
      if (!reply) throw new McpError('MCP 响应缺少对应的结果');
      return reply;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  async readSse(res, id, ctrl) {
    let reply = null;
    const parse = createSseParser(m => {
      if (m && m.id === id && (m.result !== undefined || m.error !== undefined)) reply = m;
      else if (m && m.method && m.id === undefined) this.onNotification(m);
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (!reply) {
        const {value, done} = await reader.read();
        if (done) break;
        parse(decoder.decode(value, {stream: true}));
      }
      parse('\n\n');
    } catch (e) {
      if (!reply) {
        if (ctrl.signal.aborted) throw new McpError('MCP 请求超时或已停止', {code: -2});
        throw new McpError('读取 MCP 事件流失败：' + e.message);
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    if (!reply) throw new McpError('MCP 事件流结束但没有返回结果');
    return reply;
  }

  async request(method, params, opts) {
    const msg = {jsonrpc: '2.0', id: this.nextId++, method};
    if (params !== undefined) msg.params = params;
    const reply = await this.post(msg, opts);
    if (reply.error) throw new McpError(`MCP 错误 ${reply.error.code}：${reply.error.message}`, {code: reply.error.code, data: reply.error.data});
    return reply.result;
  }

  async notify(method, params) {
    const msg = {jsonrpc: '2.0', method};
    if (params !== undefined) msg.params = params;
    await this.post(msg, {timeoutMs: 15000});
  }

  async connect() {
    this.sessionId = null;
    this.protocolVersion = null;
    const r = await this.request('initialize', {protocolVersion: PREFERRED_VERSION, capabilities: {}, clientInfo: this.clientInfo}, {timeoutMs: 15000});
    if (!r || typeof r !== 'object') throw new McpError('MCP 初始化结果无效');
    this.protocolVersion = SUPPORTED_VERSIONS.includes(r.protocolVersion) ? r.protocolVersion : (r.protocolVersion || PREFERRED_VERSION);
    this.serverInfo = r.serverInfo || {};
    this.serverCapabilities = r.capabilities || {};
    this.instructions = typeof r.instructions === 'string' ? r.instructions.slice(0, 4000) : '';
    await this.notify('notifications/initialized');
    return {protocolVersion: this.protocolVersion, serverInfo: this.serverInfo, capabilities: this.serverCapabilities, instructions: this.instructions};
  }

  async listTools() {
    const tools = [];
    let cursor;
    for (let page = 0; page < 50; page++) {
      const r = await this.request('tools/list', cursor ? {cursor} : {}, {timeoutMs: 30000});
      for (const t of r?.tools || []) if (t && typeof t.name === 'string') tools.push(t);
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name, args, opts = {}) {
    return this.request('tools/call', {name, arguments: args || {}}, {timeoutMs: opts.timeoutMs || 300000, signal: opts.signal});
  }

  async ping() { return this.request('ping', undefined, {timeoutMs: 8000}); }

  async close() {
    if (!this.sessionId) return;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      await this.fetch(this.url, {method: 'DELETE', headers: this.baseHeaders(), signal: ctrl.signal}).catch(() => {});
      clearTimeout(t);
    } finally { this.sessionId = null; }
  }
}

// 把 MCP 工具结果转换为 Agent 可用的文本与图像
function summarizeResult(result, {maxText = 20000, maxImages = 3, maxImageBytes = 6 * 1024 * 1024} = {}) {
  const texts = [], images = [];
  let dropped = 0;
  for (const c of result?.content || []) {
    if (c.type === 'text' && typeof c.text === 'string') texts.push(c.text);
    else if (c.type === 'image' && typeof c.data === 'string') {
      if (images.length < maxImages && c.data.length * 0.75 <= maxImageBytes && /^image\/(png|jpeg|webp|gif)$/.test(c.mimeType || '')) images.push({mime: c.mimeType, data: c.data});
      else dropped++;
    } else if (c.type === 'resource' && c.resource?.text) texts.push(c.resource.text);
    else if (c.type === 'resource_link' && c.uri) texts.push(`[资源] ${c.name || ''} ${c.uri}`);
  }
  if (!texts.length && result?.structuredContent) texts.push(JSON.stringify(result.structuredContent));
  let text = texts.join('\n');
  if (text.length > maxText) text = text.slice(0, maxText) + `\n…（已截断，原长 ${text.length} 字符）`;
  if (dropped) text += `\n（另有 ${dropped} 张图像因数量或体积限制未发送给模型）`;
  return {text, images, isError: !!result?.isError};
}

module.exports = {McpHttpClient, McpError, summarizeResult, createSseParser, SUPPORTED_VERSIONS, PREFERRED_VERSION};
