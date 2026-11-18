'use strict';
// 界面冒烟测试：用 Chromium 加载真实 ui/，window.workstation 桥接到真实 main.cjs handlers（假 electron）。
// 运行：node tests/ui-smoke.cjs [截图输出目录]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright');
const {bootMain} = require('./helpers/fake-electron.cjs');
const {startMockLLM} = require('./helpers/mock-llm.cjs');
const {startMockMcp} = require('./helpers/mock-mcp-server.cjs');

(async () => {
  const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'aigw-ui-'));
  fs.mkdirSync(out, {recursive: true});
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigw-ui-data-'));
  const sessionFile = path.join(dataDir, 'blender_bridge.json');
  process.env.AIGW_BLENDER_SESSION_FILE = sessionFile;
  const llm = await startMockLLM();
  const mcp = await startMockMcp();
  const py = spawn(process.env.PYTHON || 'python3', [path.join(__dirname, 'test_blender_bridge.py'), '--serve', sessionFile], {stdio: ['ignore', 'pipe', 'inherit']});
  await new Promise(r => py.stdout.on('data', d => { if (String(d).includes('READY')) r(); }));
  process.stderr.write('booting\n');
  const m = bootMain({dataDir});
  await m.invoke('snapshot');
  process.stderr.write('booted\n');
  const browser = await chromium.launch();
  const page = await browser.newPage({viewport: {width: 1440, height: 900}});
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push('console: ' + msg.text()); });
  await page.exposeFunction('__invoke', async (method, args) => {
    try { return {ok: true, value: await m.invoke(method, args)}; } catch (e) { return {ok: false, error: e.message}; }
  });
  await page.addInitScript(() => {
    window.workstation = {invoke: (m, a) => window.__invoke(m, a), filePath: () => '', onState: cb => { window.__stateCb = cb; return () => {}; }, onError: () => {}};
    window.confirm = () => true;
  });
  m.onState(state => { page.evaluate(s => window.__stateCb && window.__stateCb(s), state).catch(() => {}); });
  await page.goto('file://' + path.join(__dirname, '..', 'ui', 'index.html'));
  await page.waitForSelector('.titlebar');
  page.setDefaultTimeout(12000);
  const shot = async name => { console.log('STEP', name); await page.waitForTimeout(250); await page.screenshot({path: path.join(out, name + '.png')}); };

  try {
  await page.click('[data-page="copilot"]');
  await page.waitForSelector('.cp');
  await shot('01-copilot-empty');

  await page.click('[data-page="settings"]');
  await page.click('[data-action="v3-add"][data-role="main"]');
  await page.selectOption('#v3-preset', 'ollama');
  await page.fill('#v3-name', '本机测试模型');
  await page.fill('#v3-base', llm.url);
  await page.fill('#v3-model', 'mock-1');
  await page.fill('#v3-price-in', '1');
  await page.fill('#v3-price-out', '2');
  await page.click('[data-action="v3-save"][data-probe="1"]');
  await page.waitForSelector('.v3-model.active .badge.good', {timeout: 15000});
  // 专长模型：视觉识图
  await page.click('[data-action="v3-add"][data-role="specialist"]');
  await page.selectOption('#v3-preset', 'ollama');
  await page.fill('#v3-model', 'mock-eye');
  await page.fill('#v3-base', llm.url);
  await page.click('[data-action="v3-spec-pick"][data-spec="vision"]');
  if (await page.inputValue('#v3-model') !== 'mock-eye') errors.push('切换专长后表单内容丢失');
  await page.fill('#v3-notes', '看截图判断 UI 布局是否对齐');
  await page.click('[data-action="v3-save"][data-probe="1"]');
  await page.waitForSelector('.v3-model.spec .badge.spec-vision', {timeout: 15000});
  await page.waitForFunction(() => document.querySelectorAll('.v3-model.spec .badge.good').length >= 3, null, {timeout: 15000});
  if (await page.locator('text=2.0 旧版规划器').count()) errors.push('设置页仍有 2.0 旧版规划器');
  await shot('02-settings-model');

  await page.click('[data-page="connections"]');
  await page.waitForSelector('[data-action="v3-connect"][data-id="blender"]');
  await page.click('[data-action="v3-connect"][data-id="blender"]');
  await page.waitForSelector('.v3-card .badge.good');
  await page.fill('#v3-cname', '测试 MCP');
  await page.fill('#v3-curl', mcp.url);
  await page.click('[data-action="v3-conn-add"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-action="v3-connect"]').length >= 2);
  const customId = await page.evaluate(() => [...document.querySelectorAll('[data-action="v3-connect"]')].map(b => b.dataset.id).find(id => !['unreal', 'unreal-aigw', 'blender'].includes(id)));
  await page.click(`[data-action="v3-connect"][data-id="${customId}"]`);
  await page.waitForFunction(() => document.querySelectorAll('.v3-card .badge.good').length >= 2);
  await shot('03-connections');

  await page.click('[data-page="copilot"]');
  await page.fill('#cp-input', '帮我建一个方块并截图');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('.cp-msg.ai .cp-bubble')].some(b => b.textContent.includes('完成')), null, {timeout: 15000});
  await page.waitForSelector('.cp-shot[src]');
  await shot('04-copilot-tools');

  await page.fill('#cp-input', '跑脚本 print(1)');
  await page.click('[data-action="cp-send"]');
  await page.waitForSelector('.cp-tool.st-awaiting [data-decision="once"]', {timeout: 15000});
  await shot('05-copilot-approval');
  await page.click('.cp-tool.st-awaiting [data-decision="once"]');
  await page.waitForFunction(() => document.querySelectorAll('.cp-msg.ai').length >= 4, null, {timeout: 15000});
  await shot('06-copilot-approved');

  await page.click('[data-page="home"]');
  await shot('07-home');
  await page.click('[data-page="agent"]');
  await shot('08-legacy-agent');
  } catch (e) {
    errors.push('step failed: ' + e.message.split('\n')[0]);
    errors.push('toasts: ' + await page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ')));
    await page.screenshot({path: path.join(out, 'fail.png')});
  }

  await browser.close();
  py.kill();
  await llm.close(); await mcp.close();
  try { fs.rmSync(sessionFile); } catch { /* 已删除 */ }
  console.log(JSON.stringify({out, errors}, null, 1));
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
