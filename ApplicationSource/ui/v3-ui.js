'use strict';
// AIGW 3.0 · 界面：AI 助手、模型设置、AI 连接。
// 与 app.js 共享全局：S、page、esc、btn、icon、api、toast、render、go、empty、formatTime。
let cpDraft = '', cpModule = 'global', cpAttachments = [], v3Edit = null, v3UeCheck = null, v3UeInstalled = null, v3RulesDraft = null, cpSending = false;
const v3ImageCache = new Map();
const V3_LEVEL = ['L0 只读', 'L1 编辑', 'L2 脚本', 'L3 高风险'];
const V3_STATUS = {ready: '已连接', connecting: '连接中', disconnected: '未连接', error: '连接失败', lost: '连接中断'};
const v3 = () => S?.v3 || null;
const v3Conn = id => v3()?.connections.find(c => c.id === id);
// UE 有两条连接（自研插件 / 官方 MCP）：优先显示已连接的那条，否则显示自研插件
const v3UeConn = () => { const a = v3Conn('unreal-aigw'), b = v3Conn('unreal'); return [a, b].find(c => c?.status === 'ready') || [a, b].find(c => c?.status === 'connecting') || a || b; };
const v3Money = n => (typeof n === 'number' ? '$' + (n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)) : '—');

// ---------- 轻量 Markdown（先转义再处理） ----------
function v3Md(text) {
  const blocks = String(text || '').split(/```/);
  return blocks.map((part, i) => {
    if (i % 2) return `<pre class="cp-code">${esc(part.replace(/^[a-zA-Z0-9_+-]*\n/, ''))}</pre>`;
    return esc(part).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
  }).join('');
}

// ---------- AI 助手页 ----------
function v3CopilotPage() {
  const d = v3();
  if (!d) return '<div class="loading">正在载入 3.0 服务…</div>';
  const main = d.roleInfo?.main;
  const ue = v3UeConn(), bl = v3Conn('blender');
  const running = d.session.running;
  const caps = c => c ? `${c.tools ? '工具✓' : '工具✗'} ${c.vision ? '视觉✓' : '视觉✗'}` : '未检测';
  const chip = (label, ok, title = '') => `<span class="cp-chip ${ok ? 'good' : ''}" title="${esc(title)}"><i class="dot ${ok ? 'good' : ''}"></i>${label}</span>`;
  return `<div class="cp">
  <div class="cp-head">
    <div><h2>AI 助手</h2><p>用自然语言让 AI 直接在 Unreal Engine 与 Blender 里操作；每一步都显示在下方，可停止、可撤销。</p></div>
    <div class="row wrap cp-tools">
      <select id="cp-module" title="?? AI"><option value="global" ${cpModule==='global'?'selected':''}>\u603b\u63a7\u5927\u8111</option><option value="3d" ${cpModule==='3d'?'selected':''}>3D \u521b\u4f5c</option><option value="animation" ${cpModule==='animation'?'selected':''}>\u52a8\u753b</option><option value="materials" ${cpModule==='materials'?'selected':''}>\u7f8e\u672f\u4e0e\u6750\u8d28</option><option value="ue" ${cpModule==='ue'?'selected':''}>\u865a\u5e7b\u4e94</option><option value="assets" ${cpModule==='assets'?'selected':''}>\u8d44\u4ea7\u4e2d\u5fc3</option></select><select id="cp-mode" title="权限模式"><option value="auto" ${d.permissionMode === 'auto' ? 'selected' : ''}>自动：只读与编辑直接执行</option><option value="ask" ${d.permissionMode === 'ask' ? 'selected' : ''}>询问：每个编辑都先确认</option></select>
      <select id="cp-session" title="会话"><option value="${esc(d.session.id)}">当前：${esc(d.session.title)}</option>${d.sessions.filter(s => s.id !== d.session.id).map(s => `<option value="${esc(s.id)}">${esc(s.title)} · ${formatTime(s.savedAt)}</option>`).join('')}</select>
      ${btn(icon('plus') + ' 新会话', 'cp-new', running ? 'disabled' : '', 'small')}
    </div>
  </div>
  <div class="cp-status">
    ${chip('主模型：' + (main ? esc(main.name) : '未设置'), !!main, main ? main.model + ' · ' + caps(main.caps) : '')}
    ${(d.roleInfo?.specialists || []).length ? `<span class="cp-chip" title="${esc(d.roleInfo.specialists.map(p => p.label + '：' + p.name + ' · ' + p.model).join('\n'))}">专长模型 ${d.roleInfo.specialists.length} 个</span>` : ''}
    ${chip('UE：' + (V3_STATUS[ue?.status] || '未连接'), ue?.status === 'ready', ue?.error || '')}
    ${chip('Blender：' + (V3_STATUS[bl?.status] || '未连接'), bl?.status === 'ready', bl?.error || '')}
    <span class="cp-chip">可用工具 ${d.toolCount}</span>
    <span class="cp-chip">本月 ${v3Money(d.spend.cost)}${d.spend.unknownCost ? '+' : ''}</span>
  </div>
  ${!main ? `<div class="notice">还没有配置主模型。添加一个 OpenAI、Claude、DeepSeek、Gemini、通义千问或本地模型后即可开始。 ${btn('去添加模型', 'goto-settings', '', 'small primary')}</div>` : ''}
  ${main && !d.toolCount ? `<div class="notice info">AI 现在只能对话。连接 Unreal Engine 或 Blender 后，它才能直接在软件里动手。 ${btn('去连接软件', 'goto-connections', '', 'small')}</div>` : ''}
  <div class="cp-log" id="cp-log">${v3LogHTML()}</div>
  <div class="cp-composer">
    <div class="cp-attach" id="cp-attach">${v3AttachHTML()}</div>
    <textarea id="cp-input" placeholder="例如：在 Blender 里建一个 2 米的木箱，材质偏暖棕色，然后截图给我看。（Ctrl+Enter 发送）">${esc(cpDraft)}</textarea>
    <div class="row">
      ${btn(icon('image') + ' 附加图片', 'cp-attach-add', running ? 'disabled' : '', 'small ghost')}
      <span class="tiny muted">Ctrl+Enter 发送 · Esc 停止</span><div class="fill"></div>
      ${running ? btn('停止', 'cp-stop', '', 'small danger') : ''}
      ${btn(running || cpSending ? '<i class="busy-indicator"></i> 执行中' : '发送', 'cp-send', running || cpSending ? 'disabled' : '', 'primary')}
    </div>
  </div>
</div>`;
}

function v3AttachHTML() {
  return cpAttachments.map((a, i) => `<span class="cp-att"><img alt="${esc(a.name)}" src="data:${a.mime};base64,${a.data}"><button class="ghost small" data-action="cp-attach-remove" data-index="${i}" title="移除">×</button></span>`).join('');
}

const V3_SUGGEST = [
  '读取 Blender 场景，告诉我有哪些物体',
  '在 Blender 里建一个 2 米的木箱，暖棕色木材质，然后截图给我看',
  '列出 Unreal 里可用的工具集，并说明你能帮我做什么',
  '把 Blender 里的木箱命名为 SM_Crate_01，导出 FBX 到 D:/MyGame/Exports/SM_Crate_01.fbx'
];

function v3LogHTML() {
  const d = v3();
  const items = d?.session.items || [];
  if (!items.length) return `<div class="cp-empty">${icon('spark')}<h3>想让 AI 做什么？</h3><p>可以从这些开始：</p><div class="cp-suggest">${V3_SUGGEST.map(s => `<button data-action="cp-suggest" data-text="${esc(s)}">${esc(s)}</button>`).join('')}</div></div>`;
  return items.map(v3ItemHTML).join('');
}

function v3ImgTag(ref, cls) { return `<img class="${cls}" data-img="${esc(ref.id)}" alt="图像">`; }

function v3ItemHTML(it) {
  if (it.type === 'user') return `<div class="cp-msg user"><div class="cp-bubble">${v3Md(it.text)}${(it.images || []).length ? `<div class="cp-imgs">${it.images.map(r => v3ImgTag(r, 'cp-thumb')).join('')}</div>` : ''}</div></div>`;
  if (it.type === 'assistant') return `<div class="cp-msg ai"><div class="cp-avatar">AI</div><div class="cp-bubble">${v3Md(it.text)}<div class="cp-meta">${esc(it.model || '')}${typeof it.cost === 'number' ? ' · ' + v3Money(it.cost) : ''}</div></div></div>`;
  if (it.type === 'thinking') return `<div class="cp-thinking"><i class="busy-indicator"></i> ${esc(it.text)}</div>`;
  if (it.type === 'info') return `<div class="cp-info">${v3Md(it.text)}</div>`;
  if (it.type === 'error') return `<div class="cp-error">${esc(it.text)}</div>`;
  if (it.type !== 'tool') return '';
  const kind = /^unreal/.test(it.kind || '') ? 'U' : it.kind === 'blender' ? 'B' : it.kind === 'specialist' ? '专' : 'M';
  const st = {running: '执行中', ok: '完成', error: '失败', denied: '已拒绝', stopped: '已停止', awaiting: '等待你确认'}[it.status] || it.status;
  const args = it.args && Object.keys(it.args).length ? JSON.stringify(it.args, null, 2) : '';
  const code = typeof it.args?.code === 'string' ? it.args.code : null;
  const why = ['', '这是编辑操作（询问模式下需要确认）。执行后可在 UE / Blender 中撤销。', 'AI 要在软件里执行一段脚本。请先读一遍代码，确认没有你不想要的操作。', '这是不可逆或影响较大的操作（删除、项目设置、打包、提交等）。请确认后再允许。'][it.level] || '';
  return `<div class="cp-tool st-${esc(it.status)} lv${it.level}">
  <div class="cp-tool-head"><span class="cp-kind ${esc(it.kind)}">${kind}</span><span class="cp-tool-name">${esc(it.tool || it.name)}</span><span class="badge lvl lvl${it.level}">${V3_LEVEL[it.level] || ''}</span><span class="cp-tool-status">${it.status === 'running' ? '<i class="busy-indicator"></i> ' : ''}${st}${it.approval === 'session' ? ' · 本会话已允许同类' : ''}</span>${it.ms ? `<span class="tiny muted">${(it.ms / 1000).toFixed(1)} 秒</span>` : ''}</div>
  ${it.status === 'awaiting' ? `<div class="cp-approve"><p>${why}</p>${code ? `<pre class="cp-code">${esc(code)}</pre>` : args ? `<pre class="cp-code">${esc(args)}</pre>` : ''}<div class="row">${btn('允许本次', 'cp-decide', `data-id="${esc(it.id)}" data-decision="once"`, 'small primary')}${it.level < 3 ? btn('本会话允许同类', 'cp-decide', `data-id="${esc(it.id)}" data-decision="session"`, 'small') : ''}${btn('拒绝', 'cp-decide', `data-id="${esc(it.id)}" data-decision="deny"`, 'small danger')}</div></div>` : ''}
  ${it.status !== 'awaiting' && (args || it.resultText) ? `<details><summary>参数与结果</summary>${args ? `<pre class="cp-code">${esc(args)}</pre>` : ''}${it.resultText ? `<pre class="cp-code result">${esc(it.resultText)}</pre>` : ''}</details>` : ''}
  ${(it.images || []).length ? `<div class="cp-imgs">${it.images.map(r => v3ImgTag(r, 'cp-shot')).join('')}</div>` : ''}
</div>`;
}

async function v3LoadImages(root = document) {
  for (const img of root.querySelectorAll('img[data-img]:not([src])')) {
    const id = img.dataset.img;
    if (v3ImageCache.has(id)) { img.src = v3ImageCache.get(id) || ''; if (!v3ImageCache.get(id)) img.replaceWith(Object.assign(document.createElement('span'), {className: 'tiny muted', textContent: '（图像未保存）'})); continue; }
    try {
      const url = await api('v3Image', {id});
      v3ImageCache.set(id, url);
      if (url) img.src = url; else img.replaceWith(Object.assign(document.createElement('span'), {className: 'tiny muted', textContent: '（图像未保存）'}));
    } catch { /* 忽略 */ }
  }
}

function v3RefreshLog() {
  const log = document.getElementById('cp-log');
  if (!log) return;
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 60;
  const html = v3LogHTML();
  if (log.__html !== html) { log.innerHTML = html; log.__html = html; void v3LoadImages(log); }
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function v3AfterRender() {
  if (page === 'copilot') {
    const log = document.getElementById('cp-log');
    if (log) { log.__html = log.innerHTML; log.scrollTop = log.scrollHeight; void v3LoadImages(log); }
  }
  if (page === 'settings' && v3RulesDraft === null && S?.activeProjectId) {
    v3RulesDraft = '';
    api('v3RulesLoad').then(t => { v3RulesDraft = t || ''; const el = document.getElementById('v3-rules'); if (el && !el.value) el.value = v3RulesDraft; }).catch(() => {});
  }
}

// ---------- 模型设置 ----------
function v3SettingsSection() {
  const d = v3();
  if (!d) return '';
  const capBadge = (p, k, label) => !p.caps ? '' : `<span class="badge ${p.caps[k] ? 'good' : 'warn'}" title="${esc(p.caps.errors?.[k] || '')}">${label}${p.caps[k] ? '✓' : '✗'}</span>`;
  const caps = p => p.caps ? capBadge(p, 'text', '文本') + ' ' + capBadge(p, 'tools', '工具') + ' ' + capBadge(p, 'vision', '识图') : '<span class="badge">未检测</span>';
  const meta = p => `${esc({openai: 'OpenAI 兼容', anthropic: 'Anthropic', gemini: 'Gemini'}[p.type])}${p.local ? ' · 本机' : ''} · ${p.hasKey ? '密钥已加密保存' : p.local ? '本机服务' : '缺少密钥'}${p.price?.input !== null && p.price?.input !== undefined ? ` · 输入 $${p.price.input} / 输出 $${p.price.output} 每百万 token` : ' · 未填价格'}`;
  const acts = p => `${btn('检测', 'v3-probe', `data-id="${esc(p.id)}"`, 'small')}${btn('编辑', 'v3-edit', `data-id="${esc(p.id)}"`, 'small ghost')}${btn('删除', 'v3-del', `data-id="${esc(p.id)}"`, 'small ghost danger')}`;
  const mains = d.providers.filter(p => p.role !== 'specialist');
  const specs = d.providers.filter(p => p.role === 'specialist');
  const mainRow = p => {
    const active = d.roles.main === p.id;
    return `<div class="v3-model ${active ? 'active' : ''}"><div class="fill"><div class="row wrap"><strong>${esc(p.name)}</strong><span class="mono tiny muted">${esc(p.model)}</span>${active ? '<span class="badge good">当前主模型</span>' : btn('设为主模型', 'v3-set-main', `data-id="${esc(p.id)}"`, 'small ghost')}</div><div class="row wrap" style="margin-top:6px">${caps(p)}<span class="tiny muted">${meta(p)}</span></div>${active && p.caps && !p.caps.tools ? '<div class="notice">这个模型没有通过“工具”检测，AI 助手只能对话，不能操作 UE / Blender。</div>' : ''}</div><div class="v3-actions">${acts(p)}</div></div>`;
  };
  const specRow = p => {
    const sp = d.specialties?.[p.specialty];
    const warn = p.specialty === 'vision' && p.caps && !p.caps.vision;
    return `<div class="v3-model spec ${p.enabled === false ? 'off' : ''}"><div class="fill"><div class="row wrap"><span class="badge spec-${esc(p.specialty)}">${esc(sp?.label || p.specialty)}</span><strong>${esc(p.name)}</strong><span class="mono tiny muted">${esc(p.model)}</span><label class="v3-check" style="margin:0"><input type="checkbox" data-action="v3-spec-toggle" data-id="${esc(p.id)}" ${p.enabled !== false ? 'checked' : ''}> 启用</label></div><p class="tiny" style="margin:6px 0">${esc(p.notes || sp?.hint || '')}</p><div class="row wrap">${caps(p)}<span class="tiny muted">${meta(p)}</span></div>${warn ? '<div class="notice">这个模型没有通过“识图”检测，不能用作视觉识图专长。</div>' : ''}</div><div class="v3-actions">${acts(p)}</div></div>`;
  };
  const editing = role => v3Edit && (v3Edit.role === 'specialist') === (role === 'specialist') ? v3ProviderForm() : '';
  const moduleNames={global:'\u603b\u63a7\u5927\u8111','3d':'3D \u521b\u4f5c',animation:'\u52a8\u753b',materials:'\u7f8e\u672f\u4e0e\u6750\u8d28',ue:'\u865a\u5e7b\u4e94',assets:'\u8d44\u4ea7\u4e2d\u5fc3',workflow:'\u5de5\u4f5c\u6d41'};
  const moduleRows=Object.entries(moduleNames).map(([m,label])=>{const selected=d.moduleAgents?.[m]||'';return `<div class="row module-agent-row"><strong>${label}</strong><span class="fill tiny muted">${m==='global'?'\u9ed8\u8ba4\u4e3b\u6a21\u578b':'\u8be5\u5de5\u4f5c\u533a\u72ec\u7acb\u6a21\u578b\uff1b\u4e3a\u7a7a\u65f6\u56de\u9000\u5230\u603b\u63a7\u5927\u8111'}</span><select data-module-agent="${m}"><option value="">\u56de\u9000\u5230\u603b\u63a7\u5927\u8111</option>${mains.map(p=>`<option value="${esc(p.id)}" ${selected===p.id?'selected':''}>${esc(p.name)} ? ${esc(p.model)}</option>`).join('')}</select></div>`;}).join('');
  return `<div class="settings-form v3-wide">
  <div class="section-heading"><h3>主模型</h3>${btn(icon('plus') + ' 添加主模型', 'v3-add', 'data-role="main"', 'small primary')}</div>
  <p class="tiny">主模型负责理解你的意图、规划步骤、调用工具操作 UE / Blender，需要通过“工具”检测。可以添加几个备选，随时切换当前主模型。密钥用 Windows 加密保存，只从主进程发送到你填写的地址。</p>
  ${mains.length ? mains.map(mainRow).join('') : empty('还没有主模型。点击「添加主模型」，选择 OpenAI、Claude、DeepSeek、Gemini、通义千问或本地 Ollama。', 'spark')}
  ${editing('main')}
  <hr class="section-divider">
  <div class="section-heading"><h3>\u6a21\u5757 AI \u7ed1\u5b9a</h3><span class="tiny muted">\u6bcf\u4e2a\u5de5\u4f5c\u533a\u53ef\u4ee5\u5355\u72ec\u4f7f\u7528\u66f4\u9002\u5408\u81ea\u5df1\u7684\u6a21\u578b</span></div>
  <div class="module-agent-list">${moduleRows}</div>
  <hr class="section-divider">
  <div class="section-heading"><h3>专长模型 <span class="tiny muted">${specs.length} / 8</span></h3>${btn(icon('plus') + ' 添加专长模型', 'v3-add', 'data-role="specialist"', 'small primary')}</div>
  <p class="tiny">按用途单独配置的模型，可以添加多个，一个一个配：视觉识图、代码 / 蓝图、3D / 动画 / 美术、快速省钱，或写一段用途说明自定义。主模型遇到对应工作时会主动请教它们；“视觉识图”专长还会在主模型不能识图时代看截图。专长模型只回答问题，不直接操作软件。</p>
  ${specs.length ? specs.map(specRow).join('') : '<p class="tiny muted">还没有专长模型。不配也能用，所有工作都由主模型完成。</p>'}
  ${editing('specialist')}
  <hr class="section-divider">
  <div class="section-heading"><h3>预算与权限</h3><span class="tiny muted">本月已用 ${v3Money(d.spend.cost)}${d.spend.unknownCost ? `（另有 ${d.spend.unknownCost} 次调用未填价格）` : ''} · ${d.spend.calls} 次调用</span></div>
  <div class="split3"><div class="field"><label for="v3-budget-task">单次任务上限（USD，留空不限）</label><input id="v3-budget-task" type="number" step="0.1" min="0" value="${d.budget.perTaskUSD ?? ''}"></div><div class="field"><label for="v3-budget-month">每月上限（USD，留空不限）</label><input id="v3-budget-month" type="number" step="1" min="0" value="${d.budget.monthlyUSD ?? ''}"></div><div class="field"><label for="v3-mode">默认权限模式</label><select id="v3-mode"><option value="auto" ${d.permissionMode === 'auto' ? 'selected' : ''}>自动</option><option value="ask" ${d.permissionMode === 'ask' ? 'selected' : ''}>询问</option></select></div></div>
  ${btn('保存预算与权限', 'v3-budget', '', 'small')}
  <p class="tiny muted" style="margin-top:8px">费用按你填写的单价估算（主模型和专长模型都计入），实际以服务商账单为准。脚本（L2）与删除、项目设置、打包等（L3）操作无论哪种模式都需要你确认。</p>
  ${d.ledger.length ? `<table class="table" style="margin-top:12px"><thead><tr><th>时间</th><th>模型</th><th>用途</th><th>输入 / 输出 token</th><th>费用</th></tr></thead><tbody>${d.ledger.slice(0, 10).map(e => `<tr><td>${formatTime(e.time)}</td><td>${esc(e.provider)} · ${esc(e.model)}</td><td class="tiny">${esc({main: '主模型', specialist: '专长', probe: '能力检测', vision: '视觉'}[e.role] || e.role || '')}${e.purpose && e.purpose !== 'capability-probe' ? ' · ' + esc(e.purpose) : ''}</td><td>${e.input} / ${e.output}</td><td>${v3Money(e.cost)}</td></tr>`).join('')}</tbody></table>` : ''}
  <hr class="section-divider">
  <div class="section-heading"><h3>项目规则（给 AI 的长期约定）</h3><span class="tiny muted">保存在项目的 .aigw/rules.md</span></div>
  ${S.activeProjectId ? `<textarea id="v3-rules" placeholder="例如：所有静态网格用 SM_ 前缀；UI 文本用中文；角色身高 1.8 米；美术风格为低多边形卡通。">${esc(v3RulesDraft || '')}</textarea><div style="margin-top:8px">${btn('保存项目规则', 'v3-rules-save', '', 'small')}</div>` : '<p class="tiny muted">打开项目后可设置。</p>'}
  <hr class="section-divider">
  <h3>关于此版本</h3><p class="tiny" style="margin-top:10px">${esc(S.version)} · Windows 桌面预览版，未签名。</p>
</div>`;
}

const v3SpecDefaultName = k => ({vision: '视觉识图', code: '代码蓝图', art: '3D动画美术', fast: '快速省钱', custom: ''}[k] ?? '');
// 切换专长时保留表单里已经填写的内容
function v3KeepForm() {
  if (!v3Edit) return;
  const val = id => document.getElementById(id)?.value;
  const map = {preset: 'v3-preset', type: 'v3-type', name: 'v3-name', baseUrl: 'v3-base', model: 'v3-model', maxOutputTokens: 'v3-maxout', notes: 'v3-notes'};
  for (const [k, id] of Object.entries(map)) { const x = val(id); if (x !== undefined) v3Edit[k] = x; }
  const pi = val('v3-price-in'), po = val('v3-price-out');
  if (pi !== undefined) v3Edit.price = {input: pi, output: po};
}

function v3ProviderForm() {
  const d = v3();
  const e = v3Edit;
  const presetOpts = Object.entries(d.presets).map(([k, p]) => `<option value="${k}" ${e.preset === k ? 'selected' : ''}>${esc(p.label)}</option>`).join('');
  return `<div class="v3-form">
  <div class="section-heading"><h3>${e.id ? '编辑' : '添加'}${e.role === 'specialist' ? '专长模型' : '主模型'}</h3>${btn('取消', 'v3-cancel', '', 'small ghost')}</div>
  ${e.role === 'specialist' ? `<div class="field"><label>专长</label><div class="v3-spec-pick">${Object.entries(d.specialties || {}).map(([k, sp]) => `<button type="button" class="recipe ${e.specialty === k ? 'active' : ''}" data-action="v3-spec-pick" data-spec="${k}"><strong>${esc(sp.label)}</strong><p>${esc(sp.hint)}</p></button>`).join('')}</div></div>
  <div class="field"><label for="v3-notes">用途说明${e.specialty === 'custom' ? '（必填）' : '（可选，写给主模型看：什么时候该请教它）'}</label><textarea id="v3-notes" maxlength="400" style="height:64px" placeholder="例如：只负责 UE 蓝图和 C++，回答要给出具体节点 / 代码">${esc(e.notes || '')}</textarea></div>` : ''}
  <div class="split"><div class="field"><label for="v3-preset">服务商</label><select id="v3-preset">${presetOpts}</select></div><div class="field"><label for="v3-name">显示名称</label><input id="v3-name" maxlength="60" value="${esc(e.name || '')}"></div></div>
  <div class="split"><div class="field"><label for="v3-base">接口地址</label><input id="v3-base" class="mono" value="${esc(e.baseUrl || '')}"></div><div class="field"><label for="v3-model">模型名</label><input id="v3-model" class="mono" placeholder="以服务商控制台显示的模型 ID 为准" value="${esc(e.model || '')}"></div></div>
  <div class="field"><label for="v3-type">接口类型</label><select id="v3-type">${['openai', 'anthropic', 'gemini'].map(t => `<option value="${t}" ${e.type === t ? 'selected' : ''}>${{openai: 'OpenAI 兼容（OpenAI / DeepSeek / 通义千问 / Ollama / vLLM / LM Studio 等）', anthropic: 'Anthropic Messages', gemini: 'Google Gemini'}[t]}</option>`).join('')}</select></div>
  <div class="field"><label for="v3-key">API Key ${e.id ? '（留空则保留原密钥）' : '（本机服务可留空）'}</label><input id="v3-key" type="password" autocomplete="off" spellcheck="false"></div>
  <div class="split3"><div class="field"><label for="v3-price-in">输入单价（USD / 百万 token，可选）</label><input id="v3-price-in" type="number" step="0.01" min="0" value="${e.price?.input ?? ''}"></div><div class="field"><label for="v3-price-out">输出单价（可选）</label><input id="v3-price-out" type="number" step="0.01" min="0" value="${e.price?.output ?? ''}"></div><div class="field"><label for="v3-maxout">单次最大输出 token</label><input id="v3-maxout" type="number" step="256" min="256" value="${e.maxOutputTokens || 4096}"></div></div>
  <div class="row">${btn('保存并检测能力', 'v3-save', 'data-probe="1"', 'primary small')}${btn('仅保存', 'v3-save', '', 'small')}</div>
  <p class="tiny muted" style="margin-top:8px">检测会发送 3 个极小请求（文本、工具调用、识别一张 8×8 测试图），会产生少量费用。${e.role === 'specialist' ? '专长模型不需要通过“工具”检测；视觉识图专长需要通过“识图”检测。' : '主模型需要通过“工具”检测才能操作软件。'}</p>
</div>`;
}

// ---------- 软件连接 ----------
function v3ConnectionsSection() {
  const d = v3();
  if (!d) return '';
  const card = c => {
    const ready = c.status === 'ready';
    const isUe = /^unreal/.test(c.kind);
    const logo = isUe ? 'U' : c.kind === 'blender' ? 'B' : 'M';
    const levels = c.levels || [0, 0, 0, 0];
    return `<section class="v3-card">
  <div class="row"><div class="tool-logo ${isUe ? 'ue' : ''}">${logo}</div><div class="fill"><div class="row wrap"><strong>${esc(c.name)}</strong><span class="badge ${ready ? 'good' : c.status === 'error' || c.status === 'lost' ? 'warn' : ''}">${V3_STATUS[c.status] || c.status}${ready ? ` · ${c.toolCount} 个工具` : ''}</span>${c.serverInfo?.name ? `<span class="tiny muted">${esc(c.serverInfo.name)} ${esc(c.serverInfo.version || '')}</span>` : ''}</div><div class="path mono tiny">${esc(c.url || (c.kind === 'blender' ? '等待 Blender 中的桥接启动…' : c.kind === 'unreal-aigw' ? '等待装有 AIGW 插件的 UE 编辑器启动…' : ''))}</div></div>
  <div class="row">${ready ? btn('断开', 'v3-disconnect', `data-id="${esc(c.id)}"`, 'small') : btn(c.status === 'connecting' ? '连接中…' : ((c.kind === 'blender' || c.kind === 'unreal-aigw') ? '安装并连接' : '连接'), (c.kind === 'blender' || c.kind === 'unreal-aigw') ? 'v3-install-connect' : 'v3-connect', `data-id="${esc(c.id)}" ${c.status === 'connecting' ? 'disabled' : ''}`, 'small primary')}${c.kind === 'custom' ? btn('删除', 'v3-conn-del', `data-id="${esc(c.id)}"`, 'small ghost danger') : ''}</div></div>
  ${c.error ? `<div class="notice">${esc(c.error)}</div>` : ''}
  <label class="v3-check"><input type="checkbox" data-action="v3-auto" data-id="${esc(c.id)}" ${c.autoConnect ? 'checked' : ''}> 启动工作站时自动连接</label>
  ${c.kind === 'unreal' ? `<div class="v3-steps"><ol><li>用 <strong>UE 5.8 或更高版本</strong> 打开你的工程。</li><li>菜单 <strong>编辑 &gt; 插件</strong>，搜索并启用 <strong>Unreal MCP</strong>（实验性）和 <strong>All Toolsets</strong>，按提示重启编辑器。</li><li>默认地址为 <span class="mono">http://127.0.0.1:8000/mcp</span>。如在 UE 的 <strong>编辑器偏好设置 &gt; Agentic Workflows &gt; Model Context Protocol</strong> 改了端口，在下面同步修改（从工作站启动 UE 时会自动带上端口参数）。</li><li>点击「连接」。</li></ol>
  <div class="row"><input id="v3-url-unreal" class="mono" value="${esc(c.url)}" aria-label="Unreal MCP 地址">${btn('保存地址', 'v3-url-save', '', 'small')}${btn('检查 UE 工程', 'v3-ue-check', '', 'small ghost')}</div>
  ${v3UeCheck ? `<div class="notice ${v3UeCheck.versionOk && v3UeCheck.mcpEnabled ? 'info' : ''}">${esc(v3UeCheck.name)} · 引擎 ${esc(v3UeCheck.engineAssociation)}<br>${v3UeCheck.versionOk === false ? '⚠ 官方 Unreal MCP 需要 UE 5.8 或更高版本；' + (v3UeCheck.aigwVersionOk ? '这个工程请改用上面的「AIGW 插件」连接。' : '自研 AIGW 插件需要 UE 5.4 及以上。') : v3UeCheck.versionOk ? '✓ 引擎版本满足要求。' : '无法从工程判断引擎版本（可能是源码版引擎）。'}<br>${v3UeCheck.mcpEnabled ? '✓ 工程已启用 ModelContextProtocol 插件。' : '✗ 工程文件中没有启用 ModelContextProtocol（Unreal MCP）。请按上面第 2 步在编辑器中启用。'}${v3UeCheck.related.length ? '<br>相关插件：' + v3UeCheck.related.map(p => esc(p.name) + (p.enabled ? '（启用）' : '（禁用）')).join('、') : ''}</div>` : ''}
  <p class="tiny muted">提示：官方插件目前是实验性功能且没有鉴权，本机其他程序也能调用编辑器工具。不用时可断开，或在 UE 中关闭自动启动。</p></div>` : ''}
  ${c.kind === 'unreal-aigw' ? `<div class="v3-steps"><p class="tiny"><strong>推荐。</strong>工作站自研插件，支持 UE 5.4 及以上（含 5.6、5.7），有鉴权；提供生成 / 变换 / 颜色 / 导入 / PIE / 截图 / 撤销分组 / 蓝图结构与编译 / 受控脚本等 20 个工具。</p><ol><li>${btn('单独安装插件', 'v3-ue-install', d.uePlugin ? '' : 'disabled', 'small ghost')} 首次点击上方「安装并连接」时会自动选择当前项目中的 <span class="mono">.uproject</span>，安装到工程的 <span class="mono">Plugins/AIGWBridge</span>（不改动工程文件；重复安装会把旧版本备份到 Saved）。${btn('打开插件目录', 'v3-ue-plugin-dir', d.uePlugin ? '' : 'disabled', 'small ghost')}</li><li>用 UE 打开该工程。插件依赖的 Python Editor Script Plugin 与 Editor Scripting Utilities 会自动启用；首次打开如提示启用插件，选“是”。</li><li>编辑器启动后插件自动运行，输出日志里会出现 <span class="mono">AIGW Bridge 已启动</span>。回到这里点「连接」。端口和令牌写在 <span class="mono">~/.aigw/unreal_bridge.json</span>，无需手填。</li></ol>
  ${v3UeInstalled ? `<div class="notice info">已安装到 ${esc(v3UeInstalled.pluginDir)}${v3UeInstalled.backup ? '；旧版本已备份到 ' + esc(v3UeInstalled.backup) : ''}。如果工程已在 UE 中打开，请重启编辑器。</div>` : ''}
  <p class="tiny ${c.session ? '' : 'muted'}">${c.session ? `检测到 UE ${esc((c.session.engine || '').split('-')[0])} 的插件，工程 ${esc(c.session.project || '')}，端口 ${c.session.port}` : '尚未检测到运行中的 UE 插件。'}</p></div>` : ''}
  ${c.kind === 'blender' ? `<div class="v3-steps"><ol><li>首次点击「安装并连接」时，工作站会把 AIGW Bridge 一次性安装到当前 Blender 的用户扩展目录；3D 创作、动画、美术与材质共用这一份插件，已安装当前版本会直接复用。安装包：<span class="mono">aigw_bridge-0.1.3.zip</span>。 ${btn('定位安装包', 'v3-blender-zip', d.blenderZip ? '' : 'disabled', 'small ghost')}</li><li>启用后桥接自动在本机启动（3D 视图按 N，在「AIGW」标签可启动 / 停止）。</li><li>点击「连接」。端口和令牌由 Blender 写入 <span class="mono">~/.aigw/blender_bridge.json</span>，无需手填。</li></ol>
  <p class="tiny ${c.blenderSession ? '' : 'muted'}">${c.blenderSession ? `检测到 Blender ${esc(c.blenderSession.blender || '')} 的桥接，端口 ${c.blenderSession.port}，启动于 ${esc(c.blenderSession.startedAt || '')}` : '尚未检测到运行中的 Blender 桥接。'}</p></div>` : ''}
  ${c.tools?.length ? `<details><summary>工具清单（L0 ${levels[0]} · L1 ${levels[1]} · L2 ${levels[2]} · L3 ${levels[3]}）</summary><table class="table"><tbody>${c.tools.map(t => `<tr><td class="mono">${esc(t.name)}</td><td><span class="badge lvl lvl${t.level}">${V3_LEVEL[t.level]}</span></td><td class="tiny">${esc(t.description)}</td></tr>`).join('')}</tbody></table></details>` : ''}
</section>`;
  };
  return `${head('AI 连接', 'AI 通过 MCP 直接操作 Unreal Engine 与 Blender。点击安装并连接时会自动补齐缺失插件，当前版本已存在则直接复用。只有显示“已连接”时 AI 才能动手。', btn(icon('spark') + ' 打开 AI 助手', 'goto-copilot', '', 'small'))}
${d.connections.map(card).join('')}
<section class="v3-card"><div class="section-heading"><h3>添加其他 MCP 服务</h3><span class="tiny muted">例如团队自建的工具服务</span></div>
<div class="split3"><div class="field"><label for="v3-cname">名称</label><input id="v3-cname" maxlength="60"></div><div class="field"><label for="v3-curl">地址（本机可用 http）</label><input id="v3-curl" class="mono" placeholder="http://127.0.0.1:3000/mcp"></div><div class="field"><label for="v3-ctoken">令牌（可选）</label><input id="v3-ctoken" type="password" autocomplete="off"></div></div>
${btn('添加', 'v3-conn-add', '', 'small')}</section>
<hr class="section-divider"><h3 style="margin-bottom:12px">2.0 软件启动与绑定</h3>`;
}

function v3StatusbarHTML() {
  const d = v3();
  if (!d) return '';
  const ue = v3UeConn(), bl = v3Conn('blender'), main = d.roleInfo?.main;
  return `<span><i class="dot ${ue?.status === 'ready' ? 'good' : ''}"></i>UE ${V3_STATUS[ue?.status] || '未连接'}</span><span><i class="dot ${bl?.status === 'ready' ? 'good' : ''}"></i>Blender 桥接 ${V3_STATUS[bl?.status] || '未连接'}</span><span><i class="dot ${main ? 'good' : ''}"></i>主模型 ${esc(main?.name || '未设置')}</span>`;
}

// 状态更新时局部刷新，避免打断输入。在 app.js 更新 S 之前调用：old 为旧状态，next 为新状态。
function v3OnState(old, next) {
  if (page === 'copilot') {
    const prev = old?.v3, cur = next?.v3;
    if (!cur) return false;
    const headKey = d => JSON.stringify([d.roleInfo, d.connections.map(c => [c.status, c.toolCount]), d.toolCount, d.session.running, d.session.id, d.sessions.length, d.permissionMode]);
    if (!prev || headKey(prev) !== headKey(cur)) return true;
    queueMicrotask(v3RefreshLog);
    return false;
  }
  if (page === 'settings' || page === 'connections') {
    const pick = s => s?.v3 ? JSON.stringify([s.v3.providers, s.v3.roles, s.v3.connections.map(c => [c.status, c.error, c.toolCount, c.url, c.autoConnect, c.blenderSession, c.session]), s.v3.uePlugin, s.v3.budget, s.v3.permissionMode, s.v3.spend]) : '';
    return pick(old) !== pick(next);
  }
  return false;
}

async function v3Send() {
  const text = cpDraft.trim();
  if (!text && !cpAttachments.length) { toast('请输入要 AI 做的事'); return; }
  cpSending = true;
  try {
    await api('v3Send', {text, images: cpAttachments, module: cpModule});
    cpDraft = ''; cpAttachments = [];
    const input = document.getElementById('cp-input');
    if (input) input.value = '';
    const att = document.getElementById('cp-attach');
    if (att) att.innerHTML = '';
  } finally { cpSending = false; }
}

function v3PresetFill(key) {
  const p = v3()?.presets[key];
  if (!p) return;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  set('v3-type', p.type);
  set('v3-base', p.baseUrl);
  const name = document.getElementById('v3-name');
  if (name && (!name.value || Object.values(v3().presets).some(x => x.label === name.value))) name.value = p.label;
}

async function v3Action(name, data, el) {
  switch (name) {
    case 'goto-copilot': go('copilot'); return;
    case 'goto-settings': go('settings'); return;
    case 'goto-connections': go('connections'); return;
    case 'cp-suggest': cpDraft = data.text; { const i = document.getElementById('cp-input'); if (i) { i.value = cpDraft; i.focus(); } } return;
    case 'cp-send': await v3Send(); return;
    case 'cp-stop': await api('v3Stop'); return;
    case 'cp-new': await api('v3NewSession'); v3ImageCache.clear(); render(); return;
    case 'cp-decide': await api('v3Decide', {itemId: data.id, decision: data.decision}); return;
    case 'cp-attach-add': {
      const imgs = await api('v3PickImages');
      cpAttachments = [...cpAttachments, ...imgs].slice(0, 4);
      const att = document.getElementById('cp-attach');
      if (att) att.innerHTML = v3AttachHTML();
      return;
    }
    case 'cp-attach-remove': cpAttachments.splice(Number(data.index), 1); { const att = document.getElementById('cp-attach'); if (att) att.innerHTML = v3AttachHTML(); } return;
    case 'v3-add': {
      const spec = data.role === 'specialist';
      v3Edit = {preset: 'deepseek', type: 'openai', name: spec ? '' : 'DeepSeek', baseUrl: v3().presets.deepseek.baseUrl, model: '', maxOutputTokens: 4096, price: {}, role: spec ? 'specialist' : 'main', specialty: spec ? 'code' : undefined, notes: ''};
      if (spec) v3Edit.name = v3SpecDefaultName('code');
      render(); return;
    }
    case 'v3-spec-pick': {
      v3KeepForm();
      const old = v3Edit.specialty;
      v3Edit.specialty = data.spec;
      if (!v3Edit.id && (!v3Edit.name || v3Edit.name === v3SpecDefaultName(old))) v3Edit.name = v3SpecDefaultName(data.spec);
      render(); return;
    }
    case 'v3-set-main': await api('v3SetMain', {id: data.id}); toast('已切换主模型。'); return;
    case 'v3-edit': v3Edit = {...v3().providers.find(p => p.id === data.id)}; render(); return;
    case 'v3-cancel': v3Edit = null; render(); return;
    case 'v3-save': {
      const val = id => document.getElementById(id)?.value ?? '';
      const provider = {id: v3Edit?.id, preset: val('v3-preset'), type: val('v3-type'), name: val('v3-name'), baseUrl: val('v3-base'), model: val('v3-model'), maxOutputTokens: val('v3-maxout'), price: {input: val('v3-price-in'), output: val('v3-price-out')}, role: v3Edit?.role || 'main'};
      if (provider.role === 'specialist') Object.assign(provider, {specialty: v3Edit.specialty, notes: val('v3-notes'), enabled: v3Edit.enabled !== false});
      const r = await api('v3ProviderSave', {provider, key: val('v3-key')});
      v3Edit = null;
      toast('模型已保存。');
      if (data.probe) await v3Probe(r.id);
      render();
      return;
    }
    case 'v3-probe': await v3Probe(data.id); return;
    case 'v3-del': if (confirm('删除这个模型配置及其加密密钥？')) { await api('v3ProviderDelete', {id: data.id}); toast('已删除。'); } return;
    case 'v3-module-agent': await api('v3ModuleAgentSave', {module: data.module, providerId: el?.value || ''}); toast('\u6a21\u5757 AI \u5df2\u66f4\u65b0'); return;
    case 'v3-budget': await api('v3BudgetSave', {perTaskUSD: document.getElementById('v3-budget-task').value, monthlyUSD: document.getElementById('v3-budget-month').value}); await api('v3ModeSave', {mode: document.getElementById('v3-mode').value}); toast('预算与权限已保存。'); return;
    case 'v3-rules-save': { const t = document.getElementById('v3-rules').value; await api('v3RulesSave', {rules: t}); v3RulesDraft = t; toast('项目规则已保存到 .aigw/rules.md。'); return; }
    case 'v3-connect': {
      const c = v3Conn(data.id);
      try { const r = await api('v3Connect', {id: data.id}); if (r) toast(`${c?.name || '连接'}：已连接，${r.toolCount} 个工具可用。`); }
      catch (e) { toast(e.message, true); }
      return;
    }
    case 'v3-install-connect': {
      const c = v3Conn(data.id);
      try {
        const r = await api('v3InstallAndConnect', {id: data.id});
        if (r.cancelled) return;
        const installed = r.install?.alreadyInstalled ? '插件已是当前版本，已复用。' : r.install ? `插件已安装到 ${r.install.path || r.install.pluginDir}。` : '';
        if (r.connection) toast(`${c?.name || '连接'}：已连接，${r.connection.toolCount} 个工具可用。${installed}`);
        else if (r.error) toast(`${installed || '插件准备完成'} ${r.install?.needsRestart ? '请重启对应软件后再连接。' : ''}${r.error}`, true);
        else toast(installed || '插件准备完成。');
      } catch (e) { toast(e.message, true); }
      return;
    }
    case 'v3-spec-toggle': await api('v3SpecialistToggle', {id: data.id, enabled: el.checked}); toast(el.checked ? '已启用该专长模型。' : '已停用该专长模型，主模型不会再请教它。'); return;
    case 'v3-disconnect': await api('v3Disconnect', {id: data.id}); toast('已断开。'); return;
    case 'v3-auto': {
      const c = v3Conn(data.id);
      await api('v3ConnSave', {id: data.id, name: c.name, url: c.url || 'http://127.0.0.1/', autoConnect: el.checked});
      return;
    }
    case 'v3-url-save': await api('v3ConnSave', {id: 'unreal', url: document.getElementById('v3-url-unreal').value, autoConnect: v3Conn('unreal')?.autoConnect}); toast('地址已保存。'); return;
    case 'v3-ue-check': { const r = await api('v3UeCheck'); if (r) { v3UeCheck = r; render(); } return; }
    case 'v3-blender-zip': await api('v3BlenderReveal'); return;
    case 'v3-ue-install': { const r = await api('v3UePluginInstall'); if (r) { v3UeInstalled = r; toast('插件已安装到工程。'); render(); } return; }
    case 'v3-ue-plugin-dir': await api('v3UePluginReveal'); return;
    case 'v3-conn-add': {
      await api('v3ConnSave', {name: document.getElementById('v3-cname').value, url: document.getElementById('v3-curl').value, token: document.getElementById('v3-ctoken').value, autoConnect: false});
      toast('已添加，点击「连接」测试。');
      return;
    }
    case 'v3-conn-del': if (confirm('删除这个 MCP 连接？')) await api('v3ConnDelete', {id: data.id}); return;
    default: return;
  }
}

async function v3Probe(id) {
  toast('正在检测模型能力（约 10–40 秒）…');
  const caps = await api('v3ProviderProbe', {id});
  const parts = [`文本${caps.text ? '✓' : '✗'}`, `工具调用${caps.tools ? '✓' : '✗'}`, `视觉${caps.vision ? '✓' : '✗'}`];
  toast('检测完成：' + parts.join('  ') + (caps.tools ? '' : '。没有工具调用能力的模型不能操作 UE / Blender。'), !caps.text || !caps.tools);
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-action]');
  if (!t || t.disabled || t.tagName === 'INPUT') return;
  const a = t.dataset.action;
  if (!/^(cp-|v3-|goto-(copilot|settings|connections))/.test(a)) return;
  void v3Action(a, t.dataset, t).catch(err => toast(err.message, true));
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.matches?.('input[type=checkbox][data-action^="v3-"]')) { void v3Action(t.dataset.action, t.dataset, t).catch(err => { toast(err.message, true); render(); }); return; }
  if (t.id === 'cp-module') { cpModule = t.value; return; }
  if (t.dataset?.moduleAgent) { void api('v3ModuleAgentSave', {module: t.dataset.moduleAgent, providerId: t.value}).then(() => toast('\u6a21\u5757 AI \u5df2\u66f4\u65b0')).catch(err => toast(err.message, true)); return; }
  if (t.id === 'cp-mode') void api('v3ModeSave', {mode: t.value}).then(() => toast(t.value === 'ask' ? '已切换为询问模式：每个编辑操作都会先问你。' : '已切换为自动模式：只读与编辑操作直接执行，脚本和高风险操作仍需确认。')).catch(err => toast(err.message, true));
  if (t.id === 'cp-session' && t.value !== v3()?.session.id) void api('v3LoadSession', {id: t.value}).then(() => { v3ImageCache.clear(); render(); }).catch(err => { toast(err.message, true); render(); });
  if (t.id === 'v3-preset') v3PresetFill(t.value);
});
document.addEventListener('input', e => {
  if (e.target.id === 'cp-input') cpDraft = e.target.value;
  if (e.target.id === 'v3-rules') v3RulesDraft = e.target.value;
});
document.addEventListener('keydown', e => {
  if (e.target.id === 'cp-input' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void v3Send().catch(err => toast(err.message, true)); }
  if (e.key === 'Escape' && page === 'copilot' && v3()?.session.running) void api('v3Stop').catch(() => {});
});





