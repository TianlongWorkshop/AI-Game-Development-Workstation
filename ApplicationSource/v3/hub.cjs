'use strict';
// AIGW 3.0 · MCP 连接管理器
// 管理到 UE（AIGW 插件 / 官方 Unreal MCP）、Blender（AIGW Bridge）以及其他 MCP 服务的连接；
// 维护工具目录、按风险划分权限等级（L0 只读 / L1 编辑 / L2 脚本 / L3 不可逆或外部），并负责心跳与重连。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {EventEmitter} = require('node:events');
const {McpHttpClient, summarizeResult} = require('./mcp-client.cjs');

const DEFAULT_CONNECTIONS = [
  {id: 'unreal-aigw', kind: 'unreal-aigw', name: 'Unreal Engine（AIGW 插件，UE 5.4+）', url: '', autoConnect: false},
  {id: 'unreal', kind: 'unreal', name: 'Unreal Engine（官方 Unreal MCP，UE 5.8+）', url: 'http://127.0.0.1:8000/mcp', autoConnect: false},
  {id: 'blender', kind: 'blender', name: 'Blender（AIGW Bridge）', url: '', autoConnect: false}
];
const LEVEL_NAMES = ['L0 只读', 'L1 编辑', 'L2 脚本', 'L3 不可逆 / 外部'];

// 通过本机会话文件发现端口与令牌的连接（桥接由 Blender 扩展 / UE 插件启动时写入）
const SESSION_KINDS = {
  blender: {env: 'AIGW_BLENDER_SESSION_FILE', file: 'blender_bridge.json', prefix: 'blender', label: '[Blender]',
    missing: '没有检测到正在运行的 Blender 桥接。请在 Blender 中安装并启用 AIGW Bridge 扩展（启用后会自动启动）。'},
  'unreal-aigw': {env: 'AIGW_UNREAL_SESSION_FILE', file: 'unreal_bridge.json', prefix: 'unreal', label: '[Unreal Engine]',
    missing: '没有检测到装有 AIGW 插件的 UE 编辑器。请先点「安装插件到工程…」把 AIGWBridge 装进工程（UE 5.4 及以上），然后用 UE 打开该工程，插件会自动启动。'}
};
function sessionFileFor(kind) { const k = SESSION_KINDS[kind]; return k ? (process.env[k.env] || path.join(os.homedir(), '.aigw', k.file)) : null; }
function blenderSessionFile() { return sessionFileFor('blender'); }
function unrealSessionFile() { return sessionFileFor('unreal-aigw'); }

// 写会话文件的进程已退出（例如 UE / Blender 被强制关闭或崩溃）时，会话文件是残留的
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readSession(file, {includeStale = false} = {}) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535 || typeof s.token !== 'string' || s.token.length < 16) return null;
    if (!includeStale && !pidAlive(s.pid)) return null;
    const str = v => (typeof v === 'string' ? v.slice(0, 300) : undefined);
    return {port: s.port, token: s.token, pid: s.pid, blender: str(s.blender), engine: str(s.engine), project: str(s.project), startedAt: str(s.startedAt), version: str(s.version), file};
  } catch { return null; }
}
function readBlenderSession(file = blenderSessionFile()) { return readSession(file); }
function readUnrealSession(file = unrealSessionFile()) { return readSession(file); }

function validateUrl(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { throw Error('MCP 地址无效'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw Error('远程 MCP 服务必须使用 https；本机服务可用 http');
  return u.toString();
}

const RE_SCRIPT = /(python|exec|script|console|command|run_code|eval|shell|terminal)/i;
const RE_IRREVERSIBLE = /(delete|remove|destroy|exit|quit|shutdown|package|publish|submit|commit|revert|overwrite|format|purge|uninstall)/i;
const RE_READ = /^(get|list|describe|find|search|read|inspect|query|capture|screenshot|scene_info|ping|info|status|tool_search|show|count|validate|check)/i;

function classifyTool(tool) {
  const a = tool.annotations || {};
  const n = String(tool.name || '');
  if (RE_SCRIPT.test(n)) return 2;
  if (a.destructiveHint === true || RE_IRREVERSIBLE.test(n)) return 3;
  if (a.readOnlyHint === true || RE_READ.test(n)) return 0;
  return 1;
}

// 官方 Unreal MCP 在“工具搜索”模式下通过 call_tool 间接调用真实工具，按参数里的工具名再判一次
function classifyCall(tool, args) {
  const base = classifyTool(tool);
  if (!/^call_tool$/i.test(tool.name)) return base;
  const names = [];
  const walk = (v, depth) => {
    if (depth > 3 || v === null || v === undefined) return;
    if (typeof v === 'string') { if (v.length < 200) names.push(v); return; }
    if (typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (/name|tool/i.test(k)) walk(x, depth + 1); else if (typeof x === 'object') walk(x, depth + 1); }
  };
  walk(args, 0);
  const joined = names.join(' ');
  if (RE_SCRIPT.test(joined)) return 2;
  if (RE_IRREVERSIBLE.test(joined)) return 3;
  if (names.length && names.every(n => RE_READ.test(n.split(/[.:/]/).pop()))) return 0;
  return 1;
}

function sanitizeName(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48); }

class Hub extends EventEmitter {
  constructor({getConnections, getToken, fetchImpl = globalThis.fetch, sessionFile, unrealSessionFile: ueFile, clientInfo} = {}) {
    super();
    this.getConnections = getConnections;
    this.getToken = getToken || (() => null);
    this.fetch = fetchImpl;
    this.sessionFiles = {blender: sessionFile || null, 'unreal-aigw': ueFile || null};
    this.clientInfo = clientInfo;
    this.rt = new Map();      // connId → 运行时状态
    this.toolIndex = new Map(); // 限定名 → {connId, tool}
    this.timer = null;
  }

  runtime(id) {
    if (!this.rt.has(id)) this.rt.set(id, {status: 'disconnected', error: null, client: null, tools: [], serverInfo: null, protocolVersion: null, connectedAt: null, instructions: '', retryAt: 0, wantConnected: false, endpoint: null});
    return this.rt.get(id);
  }

  config(id) {
    const c = this.getConnections().find(c => c.id === id);
    if (!c) throw Error('连接不存在');
    return c;
  }

  prefix(conn) { return conn.kind === 'unreal' ? 'ue' : SESSION_KINDS[conn.kind] ? SESSION_KINDS[conn.kind].prefix : 'mcp_' + sanitizeName(conn.id).slice(0, 6); }

  session(kind) { return SESSION_KINDS[kind] ? readSession(this.sessionFiles[kind] || sessionFileFor(kind)) : null; }

  publicState() {
    const sessions = {};
    for (const k of Object.keys(SESSION_KINDS)) sessions[k] = this.session(k);
    return this.getConnections().map(c => {
      const r = this.runtime(c.id);
      const levels = [0, 0, 0, 0];
      for (const t of r.tools) levels[classifyTool(t)]++;
      const session = sessions[c.kind] || null;
      const pub = session ? {port: session.port, blender: session.blender, engine: session.engine, project: session.project, startedAt: session.startedAt, version: session.version} : null;
      return {
        id: c.id, kind: c.kind, name: c.name, url: SESSION_KINDS[c.kind] ? (session ? `http://127.0.0.1:${session.port}/mcp` : '') : c.url,
        autoConnect: !!c.autoConnect, status: r.status, error: r.error, toolCount: r.tools.length, levels,
        serverInfo: r.serverInfo, protocolVersion: r.protocolVersion, connectedAt: r.connectedAt,
        hasToken: c.kind === 'custom' ? !!this.getToken(c.id) : undefined,
        session: SESSION_KINDS[c.kind] ? pub : undefined,
        blenderSession: c.kind === 'blender' ? pub : undefined,
        tools: r.tools.slice(0, 400).map(t => ({name: t.name, level: classifyTool(t), description: String(t.description || '').slice(0, 160)}))
      };
    });
  }

  endpointFor(conn) {
    if (SESSION_KINDS[conn.kind]) {
      const s = this.session(conn.kind);
      if (!s) {
        const stale = readSession(this.sessionFiles[conn.kind] || sessionFileFor(conn.kind), {includeStale: true});
        throw Error(SESSION_KINDS[conn.kind].missing + (stale ? `（找到上次留下的会话记录，但对应进程 ${stale.pid} 已退出，可能是软件被强制关闭；重新打开即可）` : ''));
      }
      return {url: `http://127.0.0.1:${s.port}/mcp`, headers: {authorization: 'Bearer ' + s.token}};
    }
    const url = validateUrl(conn.url);
    const token = this.getToken(conn.id);
    return {url, headers: token ? {authorization: 'Bearer ' + token} : {}};
  }

  async connect(id) {
    const conn = this.config(id);
    const r = this.runtime(id);
    r.wantConnected = true;
    if (r.status === 'connecting') return;
    await this.dropClient(r);
    r.status = 'connecting'; r.error = null; this.changed();
    try {
      const ep = this.endpointFor(conn);
      const client = new McpHttpClient({url: ep.url, headers: ep.headers, fetchImpl: this.fetch, clientInfo: this.clientInfo});
      const info = await client.connect();
      const tools = await client.listTools();
      Object.assign(r, {client, tools, serverInfo: info.serverInfo, protocolVersion: info.protocolVersion, instructions: info.instructions, status: 'ready', error: null, connectedAt: new Date().toISOString(), endpoint: ep.url});
      this.rebuildIndex();
    } catch (e) {
      r.status = 'error';
      r.error = conn.kind === 'unreal' && /无法连接|ECONNREFUSED|fetch failed/i.test(e.message)
        ? '无法连接 UE 编辑器的 MCP 服务。请确认：① UE 5.8 或更高版本已打开工程；② 已在 编辑 > 插件 中启用 Unreal MCP 与 All Toolsets 并重启编辑器；③ 端口与这里填写的一致。原始错误：' + e.message
        : e.message;
      r.tools = []; this.rebuildIndex();
    } finally { this.changed(); }
    if (r.status !== 'ready') throw Error(r.error);
    return this.publicState().find(c => c.id === id);
  }

  async dropClient(r) {
    const c = r.client; r.client = null;
    if (c) await c.close().catch(() => {});
  }

  async disconnect(id) {
    const r = this.runtime(id);
    r.wantConnected = false;
    await this.dropClient(r);
    Object.assign(r, {status: 'disconnected', error: null, tools: [], connectedAt: null});
    this.rebuildIndex(); this.changed();
  }

  async disconnectAll() { for (const c of this.getConnections()) await this.disconnect(c.id).catch(() => {}); }

  rebuildIndex() {
    this.toolIndex.clear();
    for (const conn of this.getConnections()) {
      const r = this.runtime(conn.id);
      if (r.status !== 'ready') continue;
      const p = this.prefix(conn);
      for (const t of r.tools) {
        let q = `${p}__${sanitizeName(t.name)}`;
        for (let i = 2; this.toolIndex.has(q); i++) q = `${p}__${sanitizeName(t.name).slice(0, 44)}_${i}`;
        this.toolIndex.set(q, {connId: conn.id, kind: conn.kind, tool: t});
      }
    }
  }

  agentTools() {
    const label = {unreal: '[Unreal Engine]', 'unreal-aigw': SESSION_KINDS['unreal-aigw'].label, blender: '[Blender]', custom: '[MCP]'};
    return [...this.toolIndex.entries()].map(([name, {kind, tool}]) => ({
      name,
      description: `${label[kind] || '[MCP]'} ${String(tool.description || tool.title || tool.name).slice(0, 900)}`,
      inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : {type: 'object', properties: {}},
      level: classifyTool(tool)
    }));
  }

  lookup(qualifiedName) { return this.toolIndex.get(qualifiedName) || null; }

  levelOf(qualifiedName, args) {
    const e = this.lookup(qualifiedName);
    return e ? classifyCall(e.tool, args) : 3;
  }

  async call(qualifiedName, args, opts = {}) {
    const e = this.lookup(qualifiedName);
    if (!e) throw Error('工具不存在或连接已断开：' + qualifiedName);
    const r = this.runtime(e.connId);
    if (r.status !== 'ready' || !r.client) throw Error('连接未就绪：' + this.config(e.connId).name);
    const started = Date.now();
    try {
      const raw = await r.client.callTool(e.tool.name, args, opts);
      return {...summarizeResult(raw, opts.summary || {}), ms: Date.now() - started, connId: e.connId, tool: e.tool.name};
    } catch (err) {
      if (/会话已失效|无法连接/.test(err.message)) { r.status = 'error'; r.error = err.message; this.changed(); }
      throw err;
    }
  }

  instructions() {
    return this.getConnections().map(c => ({c, r: this.runtime(c.id)})).filter(x => x.r.status === 'ready' && x.r.instructions).map(x => `【${x.c.name} 说明】\n${x.r.instructions}`).join('\n\n');
  }

  startHeartbeat(intervalMs = 20000) {
    this.stopHeartbeat();
    this.timer = setInterval(() => void this.beat().catch(() => {}), intervalMs);
    this.timer.unref?.();
  }
  stopHeartbeat() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async beat() {
    for (const conn of this.getConnections()) {
      const r = this.runtime(conn.id);
      if (r.status === 'ready' && r.client) {
        try { await r.client.ping(); }
        catch (e) { r.status = 'lost'; r.error = '连接中断：' + e.message; r.retryAt = Date.now() + 5000; this.changed(); }
      } else if ((r.status === 'lost' || r.status === 'error') && r.wantConnected && Date.now() >= r.retryAt) {
        r.retryAt = Date.now() + 15000;
        await this.connect(conn.id).catch(() => {});
      }
    }
  }

  changed() { this.emit('change'); }
}

module.exports = {pidAlive, Hub, DEFAULT_CONNECTIONS, LEVEL_NAMES, SESSION_KINDS, classifyTool, classifyCall, readSession, readBlenderSession, readUnrealSession, blenderSessionFile, unrealSessionFile, sessionFileFor, validateUrl};
