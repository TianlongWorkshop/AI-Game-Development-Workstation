'use strict';
// AIGW 3.0 · 模型路由：一个主模型 + 若干专长模型
// 主模型负责理解、规划和调用工具；专长模型（视觉识图 / 代码蓝图 / 3D 动画美术 / 快速省钱 / 自定义）
// 由主模型通过 consult_specialist 请教，视觉专长还会在主模型不能识图时代看截图。

const P = require('./providers.cjs');

class Router {
  constructor({getProviders, getRoles, getKey, fetchImpl = globalThis.fetch, onUsage} = {}) {
    this.getProviders = getProviders;
    this.getRoles = getRoles;
    this.getKey = getKey;
    this.fetch = fetchImpl;
    this.onUsage = onUsage || (() => {});
  }

  list() { return this.getProviders() || []; }

  mainProvider() {
    const roles = this.getRoles() || {};
    const list = this.list();
    return list.find(p => p.id === roles.main) || null;
  }

  // 已启用的专长模型（按添加顺序）
  specialists() { return this.list().filter(p => p.role === 'specialist' && p.enabled !== false); }

  // 按专长类型找第一个可用的专长模型；视觉专长要求未被检测为“不支持识图”
  specialistFor(kind) {
    return this.specialists().find(p => p.specialty === kind && !(SPEC_NEEDS[kind] && p.caps && p.caps[SPEC_NEEDS[kind]] === false)) || null;
  }

  // 兼容旧角色名：vision → 视觉专长，cheap → 快速专长；都没有时回落主模型
  provider(role = 'main') {
    if (role === 'main') return this.mainProvider();
    if (typeof role === 'string' && role.startsWith('id:')) return this.list().find(p => p.id === role.slice(3)) || null;
    const kind = {vision: 'vision', cheap: 'fast'}[role] || role;
    return this.specialistFor(kind) || this.mainProvider();
  }

  supports(role, cap) {
    const p = this.provider(role);
    return !!(p && p.caps && p.caps[cap]);
  }

  describe() {
    const brief = p => p ? {id: p.id, name: p.name, model: p.model, caps: p.caps || null} : null;
    return {
      main: brief(this.mainProvider()),
      specialists: this.specialists().map(p => ({...brief(p), specialty: p.specialty, label: P.SPECIALTIES[p.specialty]?.label || p.specialty, notes: p.notes || ''}))
    };
  }

  async chat(role, req, meta = {}) {
    const cfg = this.provider(role);
    if (!cfg) throw Error('尚未配置主模型。请到「模型与系统」添加主模型。');
    return this.chatWith(cfg, req, {role: role.startsWith?.('id:') ? 'specialist' : role, ...meta});
  }

  async chatWith(cfg, req, meta = {}) {
    const key = cfg.local ? (this.getKey(cfg.id) || '') : this.getKey(cfg.id);
    const started = Date.now();
    const res = await P.chat(cfg, key, req, this.fetch);
    const cost = P.cost(cfg, res.usage);
    const entry = {time: new Date().toISOString(), role: meta.role || cfg.role || 'main', providerId: cfg.id, provider: cfg.name, model: cfg.model, input: res.usage.input, output: res.usage.output, cost, ms: Date.now() - started, ...meta};
    try { this.onUsage(entry); } catch { /* 记账失败不影响主流程 */ }
    return {...res, cost, providerId: cfg.id, model: cfg.model};
  }
}

const SPEC_NEEDS = {vision: 'vision'};

module.exports = {Router};
