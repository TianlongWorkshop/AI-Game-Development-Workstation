'use strict';
// AIGW 3.0 · 主进程服务入口：模型路由、MCP 连接、Agent 会话、账本与审计。
// 与 2.0 的 main.cjs 解耦：main.cjs 只负责创建本服务、把 handlers 并入 IPC 白名单、把 snapshot 合并进界面状态。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const P = require('./providers.cjs');
const {Router} = require('./router.cjs');
const {Hub, DEFAULT_CONNECTIONS, validateUrl, readBlenderSession, readUnrealSession} = require('./hub.cjs');
const {AgentSession, buildSystemPrompt, MODES} = require('./agent.cjs');

const VERSION = '3.0.0-alpha.4';
const BLENDER_BRIDGE_VERSION = '0.1.3';
const IMAGE_MIMES = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp'};
const now = () => new Date().toISOString();

function create({store, dataRoot, safeStorage, providerFetch, localFetch = globalThis.fetch, dialog, shell, getWin, publish, publishLight, project, appDir}) {
  // ---------- 数据 ----------
  const d = store.data;
  if (!d.v3 || typeof d.v3 !== 'object') d.v3 = {};
  const v = d.v3;
  v.schema = 1;
  if (!Array.isArray(v.providers)) v.providers = [];
  for (const p of v.providers) if (p.role !== 'specialist') p.role = 'main';
  if (!v.roles || typeof v.roles !== 'object') v.roles = {};
  // \u6bcf\u4e2a\u751f\u4ea7\u6a21\u5757\u53ef\u4ee5\u5355\u72ec\u7ed1\u5b9a AI
  const MODULES = ['global','3d','animation','materials','ue','assets','workflow'];
  if (!v.moduleAgents || typeof v.moduleAgents !== 'object') v.moduleAgents = {};
  for (const m of MODULES) if (typeof v.moduleAgents[m] !== 'string') delete v.moduleAgents[m];
  // 迁移：alpha.1/alpha.2 的“视觉模型 / 快速模型”角色改为专长模型
  for (const [role, specialty] of [['vision', 'vision'], ['cheap', 'fast']]) {
    const p = v.roles[role] && v.providers?.find(x => x.id === v.roles[role]);
    if (p && p.id !== v.roles.main && p.role !== 'specialist') Object.assign(p, {role: 'specialist', specialty, notes: '', enabled: true});
    delete v.roles[role];
  }
  if (!Array.isArray(v.connections)) v.connections = [];
  for (const [i, def] of DEFAULT_CONNECTIONS.entries()) if (!v.connections.some(c => c.id === def.id)) v.connections.splice(Math.min(i, v.connections.length), 0, {...def});
  for (const c of v.connections) { const def = DEFAULT_CONNECTIONS.find(x => x.id === c.id); if (def) c.name = def.name; }
  if (!MODES.includes(v.permissionMode)) v.permissionMode = 'auto';
  if (!v.budget || typeof v.budget !== 'object') v.budget = {perTaskUSD: 1, monthlyUSD: 30, requireKnownCost: true};
  if (typeof v.budget.requireKnownCost !== 'boolean') v.budget.requireKnownCost = true;
  if (!Array.isArray(v.ledger)) v.ledger = [];
  const v3Dir = path.join(dataRoot, 'v3');
  const keyDir = path.join(dataRoot, 'keys');
  const sessionDir = path.join(v3Dir, 'sessions');
  fs.mkdirSync(sessionDir, {recursive: true});
  fs.mkdirSync(keyDir, {recursive: true});

  // ---------- 密钥 ----------
  const keyFile = id => path.join(keyDir, crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 24) + '.bin');
  function saveKey(id, key) {
    if (!safeStorage.isEncryptionAvailable()) throw Error('系统密钥加密不可用，未保存明文密钥。');
    fs.writeFileSync(keyFile(id), safeStorage.encryptString(String(key)));
  }
  function getKey(id) {
    try { const f = keyFile(id); return fs.existsSync(f) ? safeStorage.decryptString(fs.readFileSync(f)) : null; } catch { return null; }
  }
  function dropKey(id) { try { const f = keyFile(id); if (fs.existsSync(f)) fs.rmSync(f); } catch { /* 忽略 */ } }

  // ---------- 账本 / 审计 ----------
  function onUsage(entry) {
    v.ledger.push(entry);
    if (v.ledger.length > 2000) v.ledger.splice(0, v.ledger.length - 2000);
  }
  function monthSpend() {
    const m = now().slice(0, 7);
    let cost = 0, calls = 0, input = 0, output = 0, unknown = 0;
    for (const e of v.ledger) if (String(e.time).slice(0, 7) === m) { calls++; input += e.input || 0; output += e.output || 0; if (typeof e.cost === 'number') cost += e.cost; else unknown++; }
    return {month: m, cost, calls, input, output, unknownCost: unknown};
  }
  const auditFile = path.join(v3Dir, 'audit.jsonl');
  let prevHash = '';
  try { if (fs.existsSync(auditFile)) { const lines=fs.readFileSync(auditFile,'utf8').trim().split(/\r?\n/); const last=lines.at(-1); if (last) { const parsed=JSON.parse(last); prevHash=crypto.createHash('sha256').update(last).digest('hex').slice(0,16); } } } catch { prevHash=''; }
  function onAudit(rec) {
    const argsText = JSON.stringify(rec.args ?? {});
    const line = {...rec, args: argsText.length > 2000 ? argsText.slice(0, 2000) + '…' : rec.args};
    line.prev = prevHash;
    const text = JSON.stringify(line);
    prevHash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
    try { fs.appendFileSync(auditFile, text + '\n'); } catch { /* 审计写入失败不阻断 */ }
  }

  // ---------- 核心对象 ----------
  const router = new Router({getProviders: () => v.providers, getRoles: () => v.roles, getKey, fetchImpl: providerFetch || globalThis.fetch, onUsage});
  const hub = new Hub({getConnections: () => v.connections, getToken: id => getKey('conn:' + id), fetchImpl: localFetch, clientInfo: {name: 'ai-game-workstation', version: VERSION}});
  let lightTimer = null;
  const light = () => { if (lightTimer) return; lightTimer = setTimeout(() => { lightTimer = null; publishLight(); }, 120); };
  hub.on('change', light);
  hub.startHeartbeat();

  function readRules() {
    const p = project();
    if (!p) return '';
    try { const f = path.join(p.root, '.aigw', 'rules.md'); return fs.existsSync(f) && fs.statSync(f).size < 64 * 1024 ? fs.readFileSync(f, 'utf8') : ''; } catch { return ''; }
  }

  let session = null;
  function deps() {
    return {
      router, hub, onAudit,
      getMode: () => v.permissionMode,
      getBudget: () => v.budget,
      getModelRole: module => { const id = v.moduleAgents?.[module] || v.roles.main; return id ? 'id:' + id : 'main'; },
      buildSystem: () => {
        const conns = hub.publicState();
        return buildSystemPrompt({projectName: project()?.name, connections: conns, mode: v.permissionMode, instructions: hub.instructions(), toolCount: hub.agentTools().length, rules: readRules(), specialists: router.specialists()});
      }
    };
  }
  function attach(s) {
    s.on('update', light);
    s.on('turnEnd', () => { saveSession(s); publish(); });
    return s;
  }
  function saveSession(s) {
    if (!s || !s.items.length) return;
    try {
      const f = path.join(sessionDir, s.id + '.json');
      const tmp = f + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(s.persistable()));
      fs.renameSync(tmp, f);
      v.currentSessionId = s.id;
      sessionsCache = null;
    } catch { /* 忽略 */ }
  }
  let sessionsCache = null;
  function listSessions() {
    if (sessionsCache) return sessionsCache;
    try {
      const list = fs.readdirSync(sessionDir).filter(n => /^[0-9a-f-]{36}\.json$/.test(n)).map(n => {
        const f = path.join(sessionDir, n);
        const st = fs.statSync(f);
        let title = '会话';
        try { title = JSON.parse(fs.readFileSync(f, 'utf8')).title || title; } catch { /* 损坏的会话文件 */ }
        return {id: n.slice(0, -5), title, savedAt: st.mtime.toISOString()};
      }).sort((a, b) => b.savedAt.localeCompare(a.savedAt)).slice(0, 30);
      sessionsCache = list;
      return list;
    } catch { return []; }
  }
  function current() {
    if (session) return session;
    if (v.currentSessionId) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(sessionDir, v.currentSessionId + '.json'), 'utf8'));
        session = attach(AgentSession.restore(data, deps()));
        return session;
      } catch { /* 读取失败则新建 */ }
    }
    session = attach(new AgentSession(deps()));
    return session;
  }

  // ---------- 状态 ----------
  function blenderTool(toolId) {
    const tools = Array.isArray(d.tools) ? d.tools.filter(t => t.kind === 'blender') : [];
    const active = readBlenderSession();
    const activeVersion = String(active?.blender || '').match(/(\d+\.\d+)/)?.[1];
    const found = toolId ? tools.find(t => t.id === toolId) : tools.find(t => activeVersion && String(t.version || '').includes(activeVersion)) || tools.find(t => typeof t.path === 'string' && fs.existsSync(t.path)) || tools[0];
    if (!found) throw Error('尚未绑定 Blender，请先在软件连接中检测 Blender');
    const version = String(found.version || '').match(/(\d+\.\d+)/)?.[1];
    if (!version) throw Error('无法判断 Blender 版本，请重新检测软件位置');
    const root = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Blender Foundation', 'Blender', version, 'extensions', 'user_default');
    return {tool: found, version, root, dir: path.join(root, 'aigw_bridge')};
  }
  function blenderPluginState() {
    const tools = Array.isArray(d.tools) ? d.tools.filter(t => t.kind === 'blender') : [];
    return {version: BLENDER_BRIDGE_VERSION, targets: tools.map(t => { try { const x = blenderTool(t.id); const manifest = path.join(x.dir, 'blender_manifest.toml'); const text = fs.existsSync(manifest) ? fs.readFileSync(manifest, 'utf8') : ''; return {toolId: t.id, blender: x.version, installed: text.includes(`version = "${BLENDER_BRIDGE_VERSION}"`), path: x.dir}; } catch { return {toolId: t.id, blender: t.version || '', installed: false}; } })};
  }
  function installBlenderBridge(toolId) {
    const x = blenderTool(toolId);
    const src = path.join(appDir, 'v3', 'blender', 'aigw_bridge');
    if (!fs.existsSync(path.join(src, 'blender_manifest.toml')) || !fs.existsSync(path.join(src, '__init__.py'))) throw Error('Blender Bridge 安装包缺失：' + src);
    const manifest = path.join(x.dir, 'blender_manifest.toml');
    if (fs.existsSync(manifest) && fs.readFileSync(manifest, 'utf8').includes(`version = "${BLENDER_BRIDGE_VERSION}"`)) return {installed: false, alreadyInstalled: true, version: BLENDER_BRIDGE_VERSION, blender: x.version, path: x.dir, needsRestart: false};
    fs.mkdirSync(x.root, {recursive: true});
    fs.cpSync(src, x.dir, {recursive: true, filter: f => !/__pycache__|\.pyc$/.test(f)});
    fs.writeFileSync(path.join(x.dir, '.aigw-installed.json'), JSON.stringify({version: BLENDER_BRIDGE_VERSION, installedAt: now(), source: src}, null, 2), 'utf8');
    return {installed: true, version: BLENDER_BRIDGE_VERSION, blender: x.version, path: x.dir, needsRestart: true};
  }
  function snapshot() {
    const s = current();
    return {
      version: VERSION,
      presets: P.PRESETS,
      specialties: P.SPECIALTIES,
      providers: v.providers.map(p => ({...p, hasKey: !!getKey(p.id)})),
      roles: v.roles,
      moduleAgents: v.moduleAgents,
      modules: MODULES,
      roleInfo: router.describe(),
      permissionMode: v.permissionMode,
      budget: v.budget,
      spend: monthSpend(),
      ledger: v.ledger.slice(-15).reverse(),
      connections: hub.publicState(),
      toolCount: hub.agentTools().length,
      session: s.publicState(),
      sessions: listSessions(),
      blenderZip: fs.existsSync(blenderZip()),
      blenderPlugin: blenderPluginState(),
      uePlugin: fs.existsSync(path.join(uePluginDir(), 'AIGWBridge.uplugin')),
      rulesLength: readRules().length
    };
  }
  function blenderZip() { return path.join(appDir, 'v3', 'blender', 'aigw_bridge-0.1.3.zip'); }
  function uePluginDir() { return path.join(appDir, 'v3', 'unreal', 'AIGWBridge'); }

  // 把自研 UE 插件复制进工程的 Plugins/AIGWBridge；已有旧版本时先备份到 Saved（放在 Plugins 里会被 UE 当成重复插件）
  function installUePlugin(uproject) {
    const file = fs.realpathSync(uproject);
    if (path.extname(file).toLowerCase() !== '.uproject' || fs.statSync(file).size > 1024 * 1024) throw Error('请选择 .uproject 工程文件');
    JSON.parse(fs.readFileSync(file, 'utf8'));
    const src = uePluginDir();
    if (!fs.existsSync(path.join(src, 'AIGWBridge.uplugin'))) throw Error('插件文件缺失：' + src);
    const root = path.dirname(file);
    const dst = path.join(root, 'Plugins', 'AIGWBridge');
    let backup = null;
    if (fs.existsSync(dst)) {
      const old = path.join(dst, 'AIGWBridge.uplugin');
      if (!fs.existsSync(old) || !/AIGW Bridge/.test(fs.readFileSync(old, 'utf8'))) throw Error('工程里已有同名目录 Plugins/AIGWBridge，但不是本插件，已停止以免覆盖');
      if (fs.readFileSync(old, 'utf8') === fs.readFileSync(path.join(src, 'AIGWBridge.uplugin'), 'utf8')) return {project: file, pluginDir: dst, backup: null, alreadyInstalled: true};
      backup = path.join(root, 'Saved', 'AIGWBridge-backup-' + now().replace(/[:.]/g, '-'));
      fs.mkdirSync(path.dirname(backup), {recursive: true});
      fs.renameSync(dst, backup);
    }
    fs.mkdirSync(path.dirname(dst), {recursive: true});
    fs.cpSync(src, dst, {recursive: true, filter: f => !/__pycache__|\.pyc$/.test(f)});
    return {project: file, pluginDir: dst, backup};
  }

  // ---------- 校验工具 ----------
  function checkImages(images) {
    if (!Array.isArray(images)) return [];
    if (images.length > 4) throw Error('一次最多附加 4 张图片');
    return images.map(i => {
      if (!i || !Object.values(IMAGE_MIMES).includes(i.mime) || typeof i.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(i.data.slice(0, 200))) throw Error('图片格式无效');
      if (i.data.length * 0.75 > 8 * 1024 * 1024) throw Error('单张图片不能超过 8 MB');
      return {mime: i.mime, data: i.data, name: String(i.name || '').slice(0, 80)};
    });
  }

  // 主模型必须是“主模型”用途的配置；当前主模型被删除或改为专长时，换成第一个可用的主模型
  function fixMain() {
    const ok = v.providers.some(p => p.id === v.roles.main && p.role === 'main');
    if (!ok) { const first = v.providers.find(p => p.role === 'main'); if (first) v.roles.main = first.id; else delete v.roles.main; }
  }
  fixMain();

  // ---------- IPC 处理 ----------
  const handlers = {
    v3ProviderSave: ({provider, key}) => {
      const cfg = P.validateProviderConfig(provider || {});
      const existing = v.providers.find(p => p.id === cfg.id);
      if (!existing) cfg.id = crypto.randomUUID();
      const preset = P.PRESETS[cfg.preset];
      if (key !== undefined && key !== null && String(key).trim()) {
        const k = String(key).trim();
        if (k.length < 8 || k.length > 2000 || /\s/.test(k)) throw Error('API Key 格式无效');
        saveKey(cfg.id, k);
      } else if (!existing && !cfg.local && !preset?.keyOptional) throw Error('请填写 API Key（本机服务可留空）');
      if (cfg.role === 'specialist') {
        if (v.providers.some(p => p.id !== cfg.id && p.role === 'specialist' && p.name === cfg.name)) throw Error('已有同名的专长模型，请换一个名称（主模型靠名称区分它们）');
        if (v.providers.filter(p => p.role === 'specialist' && p.id !== cfg.id).length >= 8) throw Error('专长模型最多 8 个');
      }
      const changed = !existing || ['type', 'baseUrl', 'model'].some(k => existing[k] !== cfg[k]) || (key && String(key).trim());
      const next = {...cfg, caps: changed ? null : existing.caps, createdAt: existing?.createdAt || now(), updatedAt: now()};
      if (existing) { for (const k of ['specialty', 'notes', 'enabled']) if (!(k in next)) delete existing[k]; Object.assign(existing, next); } else v.providers.push(next);
      fixMain();
      publish();
      return {id: next.id};
    },
    v3ModuleAgentSave: ({module, providerId}) => {
      if (!MODULES.includes(module)) throw Error('\u672a\u77e5\u751f\u4ea7\u6a21\u5757');
      if (providerId) { const p = v.providers.find(x => x.id === providerId && x.role !== 'specialist' && x.enabled !== false); if (!p) throw Error('\u8be5\u6a21\u578b\u4e0d\u5b58\u5728\u6216\u4e0d\u662f\u53ef\u6267\u884c\u4e3b\u6a21\u578b'); v.moduleAgents[module] = p.id; }
      else delete v.moduleAgents[module];
      publish(); return {module, providerId: v.moduleAgents[module] || null};
    },
    v3ProviderDelete: ({id}) => {
      const i = v.providers.findIndex(p => p.id === id);
      if (i < 0) throw Error('模型不存在');
      v.providers.splice(i, 1);
      dropKey(id);
      fixMain();
      publish();
      return true;
    },
    v3SetMain: ({id}) => {
      const p = v.providers.find(p => p.id === id);
      if (!p) throw Error('模型不存在');
      if (p.role !== 'main') throw Error('专长模型不能设为主模型；请编辑它，把用途改为“主模型”');
      v.roles.main = id;
      publish();
      return true;
    },
    v3SpecialistToggle: ({id, enabled}) => {
      const p = v.providers.find(p => p.id === id && p.role === 'specialist');
      if (!p) throw Error('专长模型不存在');
      p.enabled = !!enabled;
      publish();
      return true;
    },
    v3ProviderProbe: async ({id}) => {
      const p = v.providers.find(p => p.id === id);
      if (!p) throw Error('模型不存在');
      const caps = await P.probe(p, getKey(p.id) || '', providerFetch || globalThis.fetch);
      onUsage({time: now(), role: 'probe', providerId: p.id, provider: p.name, model: p.model, input: caps.usage.input, output: caps.usage.output, cost: P.cost(p, caps.usage), purpose: 'capability-probe'});
      delete caps.usage;
      p.caps = caps;
      publish();
      return caps;
    },
    v3ModeSave: ({mode}) => { if (!MODES.includes(mode)) throw Error('无效的权限模式'); v.permissionMode = mode; publish(); return true; },
    v3BudgetSave: ({perTaskUSD, monthlyUSD}) => {
      const n = x => (x === '' || x === null || x === undefined) ? null : Number(x);
      const a = n(perTaskUSD), b = n(monthlyUSD);
      for (const x of [a, b]) if (x !== null && (!Number.isFinite(x) || x <= 0 || x > 10000)) throw Error('预算需为 0–10000 的正数，或留空表示不限制');
      v.budget = {perTaskUSD: a, monthlyUSD: b, requireKnownCost: v.budget.requireKnownCost !== false};
      publish();
      return true;
    },
    v3ConnSave: ({id, name, url, token, autoConnect}) => {
      let c = id ? v.connections.find(c => c.id === id) : null;
      if (id && !c) throw Error('连接不存在');
      if (c?.kind === 'blender' || c?.kind === 'unreal-aigw') { c.autoConnect = !!autoConnect; publish(); return {id: c.id}; }
      const cleanUrl = validateUrl(url);
      if (c?.kind === 'unreal') { c.url = cleanUrl; c.autoConnect = !!autoConnect; publish(); return {id: c.id}; }
      const nm = String(name || '').trim();
      if (!nm || nm.length > 60) throw Error('请填写 1–60 字的连接名称');
      if (!c) { c = {id: crypto.randomUUID(), kind: 'custom', name: nm, url: cleanUrl, autoConnect: !!autoConnect}; v.connections.push(c); }
      else Object.assign(c, {name: nm, url: cleanUrl, autoConnect: !!autoConnect});
      if (token !== undefined && token !== null && String(token).trim()) saveKey('conn:' + c.id, String(token).trim());
      publish();
      return {id: c.id};
    },
    v3ConnDelete: async ({id}) => {
      const c = v.connections.find(c => c.id === id);
      if (!c) throw Error('连接不存在');
      if (c.kind !== 'custom') throw Error('内置连接不能删除');
      await hub.disconnect(id).catch(() => {});
      v.connections = v.connections.filter(x => x.id !== id);
      dropKey('conn:' + id);
      publish();
      return true;
    },
    v3Connect: async ({id}) => { const r = await hub.connect(id); publish(); return r; },
    v3BlenderInstall: ({toolId} = {}) => { const r = installBlenderBridge(toolId); publish(); return r; },
    v3InstallAndConnect: async ({id, toolId, uproject} = {}) => {
      const c = v.connections.find(x => x.id === id);
      if (!c) throw Error('连接不存在');
      let install = null;
      if (c.kind === 'blender') install = installBlenderBridge(toolId);
      if (c.kind === 'unreal-aigw') {
        let file = uproject;
        if (!file) {
          try {
            const p = project();
            const candidates = p && fs.existsSync(p.root) ? fs.readdirSync(p.root, {withFileTypes: true}).filter(x => x.isFile() && path.extname(x.name).toLowerCase() === '.uproject').map(x => path.join(p.root, x.name)) : [];
            if (candidates.length === 1) file = candidates[0];
          } catch { /* 没有当前项目时改为弹窗选择 */ }
        }
        if (!file) {
          const r = await dialog.showOpenDialog(getWin(), {title: '选择要安装 AIGW 插件的 UE 工程（UE 5.4 及以上）', properties: ['openFile'], filters: [{name: 'Unreal Project', extensions: ['uproject']}]});
          if (r.canceled) return {cancelled: true};
          file = r.filePaths[0];
        }
        install = installUePlugin(file);
      }
      let connection = null, error = null;
      try { connection = await hub.connect(id); } catch (e) { error = e.message; }
      publish();
      return {install, connection, error};
    },
    v3Disconnect: async ({id}) => { await hub.disconnect(id); publish(); return true; },
    v3UeCheck: async () => {
      const r = await dialog.showOpenDialog(getWin(), {title: '检查 UE 工程是否已启用 Unreal MCP', properties: ['openFile'], filters: [{name: 'Unreal Project', extensions: ['uproject']}]});
      if (r.canceled) return null;
      const file = fs.realpathSync(r.filePaths[0]);
      if (fs.statSync(file).size > 1024 * 1024) throw Error('项目描述文件过大');
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const plugins = (j.Plugins || []).map(p => ({name: String(p.Name), enabled: p.Enabled !== false}));
      const assoc = String(j.EngineAssociation || '');
      const m = assoc.match(/^(\d+)\.(\d+)/);
      const versionOk = m ? (Number(m[1]) > 5 || (Number(m[1]) === 5 && Number(m[2]) >= 8)) : null;
      const mcp = plugins.find(p => /^ModelContextProtocol$/i.test(p.name));
      const related = plugins.filter(p => /mcp|modelcontext|toolset/i.test(p.name));
      const aigwVersionOk = m ? (Number(m[1]) > 5 || (Number(m[1]) === 5 && Number(m[2]) >= 4)) : null;
      const aigwInstalled = fs.existsSync(path.join(path.dirname(file), 'Plugins', 'AIGWBridge', 'AIGWBridge.uplugin'));
      return {file, name: path.basename(file), engineAssociation: assoc || '未指定（可能是源码版引擎）', versionOk, mcpListed: !!mcp, mcpEnabled: !!mcp?.enabled, related, aigwVersionOk, aigwInstalled};
    },
    v3BlenderReveal: () => {
      const z = blenderZip();
      if (!fs.existsSync(z)) throw Error('安装包缺失：' + z);
      shell.showItemInFolder(z);
      return {path: z};
    },
    v3BlenderSession: () => readBlenderSession(),
    // 3D 创作画布只读当前 Blender 会话，用于视口截图和场景概览；不会创建文件或工程。
    v3BlenderTool: async ({tool, args} = {}) => {
      const allowed = ['capture_viewport', 'get_scene_info', 'get_material_nodes', 'set_mode'];
      if (!allowed.includes(tool)) throw Error('3D 画布只允许读取 Blender 视口和场景概览');
      if (hub.runtime('blender').status !== 'ready') throw Error('请先在「软件连接」中连接 Blender（AIGW Bridge）');
      const q = 'blender__' + tool;
      if (!hub.lookup(q)) return {isError: true, text: '当前 Blender Bridge 未提供「' + tool + '」工具。请在软件连接中执行一次 Bridge 更新，或重启 Blender 后再试。', images: []};
      const res = await hub.call(q, args && typeof args === 'object' ? args : {}, {timeoutMs: 120000, summary: {maxImageBytes: 24 * 1024 * 1024, maxImages: 3}});
      onAudit({time: now(), sessionId: 'workspace-ui', tool: q, level: hub.levelOf(q, args), args, status: res.isError ? 'error' : 'ok', ms: res.ms});
      return {isError: !!res.isError, text: res.text, data: res.data, images: res.images || []};
    },
    // 姿态模式入口兼容旧版 Bridge：新版直接调用 set_mode，旧版使用受控 run_python 完成同一件事。
    v3BlenderMode: async ({mode} = {}) => {
      const wanted = String(mode || '').toUpperCase();
      if (!['OBJECT', 'POSE', 'EDIT'].includes(wanted)) throw Error('无效的 Blender 模式');
      if (hub.runtime('blender').status !== 'ready') return {isError: true, text: '请先连接 Blender（AIGW Bridge）'};
      const direct = 'blender__set_mode';
      let q = direct, args = {mode: wanted};
      if (!hub.lookup(direct)) {
        q = 'blender__run_python';
        if (!hub.lookup(q)) return {isError: true, text: '当前 Blender Bridge 没有姿态模式工具，请更新 Bridge 并重启 Blender。'};
        args = {code: "active=bpy.context.view_layer.objects.active\nif active is None:\n    raise RuntimeError('请先在 Blender 中选择对象或骨架')\nif '" + wanted + "' == 'POSE' and active.type != 'ARMATURE':\n    raise RuntimeError('姿态模式需要先选择骨架')\nif active.mode != '" + wanted + "':\n    bpy.ops.object.mode_set(mode='" + wanted + "')\nprint('当前模式：' + active.mode)"};
      }
      const res = await hub.call(q, args, {timeoutMs: 120000});
      onAudit({time: now(), sessionId: 'workspace-ui', tool: q, level: hub.levelOf(q, args), args: {mode: wanted}, status: res.isError ? 'error' : 'ok', ms: res.ms});
      return {isError: !!res.isError, text: res.text, images: res.images || []};
    },
    // 工作区界面直接调用 UE 插件的少数只读 / 编译类工具（例如虚幻 5 页的蓝图编译检查），不经过 AI
    v3UeTool: async ({tool, args} = {}) => {
      const allowed = ['blueprint_info', 'compile_blueprints', 'open_asset', 'list_assets', 'capture_viewport', 'get_level_info', 'focus_viewport'];
      if (!allowed.includes(tool)) throw Error('界面不能直接调用该工具');
      if (hub.runtime('unreal-aigw').status !== 'ready') throw Error('请先在「软件连接」中连接 Unreal Engine（AIGW 插件）');
      const q = 'unreal__' + tool;
      const res = await hub.call(q, args && typeof args === 'object' ? args : {}, {timeoutMs: 300000});
      onAudit({time: now(), sessionId: 'workspace-ui', tool: q, level: hub.levelOf(q, args), args, status: res.isError ? 'error' : 'ok', ms: res.ms});
      let data = null;
      try { data = JSON.parse(res.text); } catch { /* 纯文本结果 */ }
      return {isError: !!res.isError, text: res.text, data, images: res.images || []};
    },
    v3UnrealSession: () => { const s = readUnrealSession(); return s && {...s, token: undefined}; },
    v3UePluginInstall: async ({uproject} = {}) => {
      let file = uproject;
      if (!file) {
        const r = await dialog.showOpenDialog(getWin(), {title: '选择要安装 AIGW 插件的 UE 工程（UE 5.4 及以上）', properties: ['openFile'], filters: [{name: 'Unreal Project', extensions: ['uproject']}]});
        if (r.canceled) return null;
        file = r.filePaths[0];
      }
      const res = installUePlugin(file);
      publish();
      return res;
    },
    v3UePluginReveal: () => { const d = uePluginDir(); if (!fs.existsSync(d)) throw Error('插件文件缺失：' + d); shell.showItemInFolder(path.join(d, 'AIGWBridge.uplugin')); return {path: d}; },
    v3PickImages: async () => {
      const r = await dialog.showOpenDialog(getWin(), {title: '选择要发给 AI 的图片（最多 4 张）', properties: ['openFile', 'multiSelections'], filters: [{name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp']}]});
      if (r.canceled) return [];
      return r.filePaths.slice(0, 4).map(f => {
        const ext = path.extname(f).toLowerCase();
        if (!IMAGE_MIMES[ext]) throw Error('只支持 PNG / JPG / WEBP');
        if (fs.statSync(f).size > 8 * 1024 * 1024) throw Error(path.basename(f) + ' 超过 8 MB');
        return {name: path.basename(f), mime: IMAGE_MIMES[ext], data: fs.readFileSync(f).toString('base64')};
      });
    },
    v3Send: ({text, images, module = 'global'}) => {
      const imgs = checkImages(images);
      if (!MODULES.includes(module)) module = 'global';
      const selectedId = v.moduleAgents?.[module] || v.roles.main;
      const selected = selectedId ? v.providers.find(p => p.id === selectedId) : router.provider('main');
      if (!selected) throw Error('\u5c1a\u672a\u914d\u7f6e\u8be5\u6a21\u5757 AI \u6a21\u578b\uff0c\u8bf7\u5230\u6a21\u578b\u4e0e\u7cfb\u7edf\u4e2d\u7ed1\u5b9a\u3002');
      if (v.budget.requireKnownCost && !selected.local && (selected.price?.input === null || selected.price?.output === null || selected.price?.input === undefined || selected.price?.output === undefined)) throw Error('\u8be5\u6a21\u5757\u6a21\u578b\u672a\u586b\u5199\u8f93\u5165/\u8f93\u51fa\u4ef7\u683c\uff0c\u65e0\u6cd5\u5728\u672a\u77e5\u6210\u672c\u4e0b\u6267\u884c\u3002');
      const spend = monthSpend();
      if (v.budget.requireKnownCost && spend.unknownCost) throw Error(`\u672c\u6708\u6709 ${spend.unknownCost} \u6b21\u8c03\u7528\u672a\u586b\u5199\u4ef7\u683c\uff0c\u5df2\u6682\u505c\u65b0\u7684 AI \u4efb\u52a1\u3002`);
      if (v.budget.monthlyUSD && spend.cost >= v.budget.monthlyUSD) throw Error(`\u672c\u6708\u6a21\u578b\u8d39\u7528\u5df2\u8fbe $${spend.cost.toFixed(2)}\uff0c\u8d85\u8fc7\u6708\u5ea6\u9884\u7b97 $${v.budget.monthlyUSD}\u3002`);
      const s = current();
      s.module = module;
      void s.send({text, images: imgs}).catch(() => {});
      light();
      return true;
    },
    v3Stop: () => { const r = current().stop(); light(); return r; },
    v3Decide: ({itemId, decision}) => { current().decide(itemId, decision); light(); return true; },
    v3NewSession: () => {
      const s = current();
      if (s.running) throw Error('当前会话仍在执行，请先停止');
      saveSession(s);
      session = attach(new AgentSession(deps()));
      session.module = 'global';
      v.currentSessionId = null;
      publish();
      return session.id;
    },
    v3LoadSession: ({id}) => {
      if (!/^[0-9a-f-]{36}$/.test(String(id))) throw Error('会话编号无效');
      if (current().running) throw Error('当前会话仍在执行，请先停止');
      saveSession(session);
      const data = JSON.parse(fs.readFileSync(path.join(sessionDir, id + '.json'), 'utf8'));
      session = attach(AgentSession.restore(data, deps()));
      v.currentSessionId = id;
      publish();
      return true;
    },
    v3Image: ({id}) => current().image(String(id)),
    v3RulesLoad: () => readRules(),
    v3RulesSave: ({rules}) => {
      const p = project();
      if (!p) throw Error('请先打开项目');
      const text = String(rules || '');
      if (text.length > 6000) throw Error('项目规则请控制在 6000 字以内');
      const dir = path.join(p.root, '.aigw');
      fs.mkdirSync(dir, {recursive: true});
      fs.writeFileSync(path.join(dir, 'rules.md'), text, 'utf8');
      publish();
      return true;
    }
  };

  // UE 启动参数：若用户改了端口，启动编辑器时带上 -ModelContextProtocolPort
  function ueLaunchArgs() {
    const c = v.connections.find(c => c.id === 'unreal');
    try { const port = new URL(c.url).port; return port && port !== '8000' ? ['-ModelContextProtocolPort=' + port] : []; } catch { return []; }
  }

  async function autoConnect() {
    for (const c of v.connections) if (c.autoConnect) {
      try {
        if (c.kind === 'blender') installBlenderBridge();
        if (c.kind === 'unreal-aigw') {
          const p = project();
          const candidates = p && fs.existsSync(p.root) ? fs.readdirSync(p.root, {withFileTypes: true}).filter(x => x.isFile() && path.extname(x.name).toLowerCase() === '.uproject').map(x => path.join(p.root, x.name)) : [];
          if (candidates.length === 1) installUePlugin(candidates[0]);
        }
      } catch { /* 自动安装失败时保留连接错误，由连接页给出下一步 */ }
      await hub.connect(c.id).catch(() => {});
    }
  }

  async function shutdown() {
    try { current().stop(); saveSession(session); } catch { /* 忽略 */ }
    hub.stopHeartbeat();
    await hub.disconnectAll().catch(() => {});
  }

  return {snapshot, handlers, ueLaunchArgs, autoConnect, shutdown, hub, router, version: VERSION, running: () => !!session?.running};
}

module.exports = {create, VERSION};


