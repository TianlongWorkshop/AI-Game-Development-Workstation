'use strict';
// 用假的 electron 模块在 Node 中启动 main.cjs，以便对真实的主进程 handlers 做端到端测试（无需 Electron）。
const Module = require('node:module');
const path = require('node:path');

function bootMain({dataDir, dialogQueue = []} = {}) {
  process.env.AIGW_DATA_DIR = dataDir;
  const ipc = {};
  const states = [];
  const listeners = new Set();
  const revealed = [];
  let readyResolve;
  const ready = new Promise(r => { readyResolve = r; });
  const MAIN_FRAME = {id: 'main'};
  let win = null;
  const fake = {
    app: {
      setPath() {}, setName() {}, requestSingleInstanceLock: () => true, quit() {}, exit(code) { fake.exitCode = code; },
      on() {}, whenReady: () => ready
    },
    BrowserWindow: class {
      constructor(opts) {
        this.opts = opts;
        this.webContents = {mainFrame: MAIN_FRAME, send: (ch, payload) => { if (ch === 'state') { states.push(payload); for (const l of listeners) l(payload); } }, setWindowOpenHandler() {}, on() {}};
        win = this;
      }
      loadFile() { return Promise.resolve(); }
      show() {} on() {} isDestroyed() { return false; } minimize() {} maximize() {} unmaximize() {} isMaximized() { return false; } close() {} destroy() {}
    },
    ipcMain: {handle(ch, fn) { ipc[ch] = fn; }},
    dialog: {
      showOpenDialog: async () => dialogQueue.shift() || {canceled: true, filePaths: []},
      showSaveDialog: async () => ({canceled: true}),
      showMessageBox: async () => ({response: 0}),
      showErrorBox: (t, m) => { throw new Error(t + ': ' + m); }
    },
    shell: {showItemInFolder: p => revealed.push(p)},
    // 测试用“加密”：可逆变换，保证文件中不出现明文
    safeStorage: {isEncryptionAvailable: () => true, encryptString: s => Buffer.from(Buffer.from(s, 'utf8').map(b => b ^ 0x5a)), decryptString: b => Buffer.from(b.map(x => x ^ 0x5a)).toString('utf8')},
    session: {defaultSession: {setPermissionRequestHandler() {}}},
    Menu: {setApplicationMenu() {}},
    net: {fetch: (u, o) => globalThis.fetch(u, o)}
  };
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'electron') return 'fake-electron';
    return origResolve.call(this, request, ...rest);
  };
  require.cache['fake-electron'] = {id: 'fake-electron', filename: 'fake-electron', loaded: true, exports: fake};
  const mainPath = path.join(__dirname, '..', '..', 'main.cjs');
  delete require.cache[mainPath];
  require(mainPath);
  readyResolve();
  const invoke = async (method, args) => {
    for (let i = 0; i < 100 && !ipc.workstation; i++) await new Promise(r => setTimeout(r, 20));
    const r = await ipc.workstation({sender: win.webContents, senderFrame: MAIN_FRAME}, method, args);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  return {invoke, states, onState: fn => listeners.add(fn), revealed, dialogQueue, fake, lastState: () => states.at(-1)};
}

module.exports = {bootMain};
