// Startup check run before every publish: starts the app core (src/main.js) the way the
// installed launcher starts an update, under a stand-in for Electron, and fails if it can't
// start, falls back to the built-in copy, or registers a handler twice.
// Usage: node tools/smoke-test.js
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), Module = require('module'), EventEmitter = require('events');
const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'couch-smoke-'));
const UD = path.join(TMP, 'userData');
const problems = [];
const channels = new Set();
let windows = 0;

const app = new EventEmitter();
Object.assign(app, {
  getPath: (n) => (n === 'userData' ? UD : path.join(UD, n)), getVersion: () => '1.0.0', isPackaged: true,
  whenReady: () => Promise.resolve(), requestSingleInstanceLock: () => true, setLoginItemSettings() {}, getLoginItemSettings: () => ({}),
  disableHardwareAcceleration() {}, commandLine: { appendSwitch() {} }, quit() {}, exit() {}, relaunch() {}, setAppUserModelId() {}
});
class BW extends EventEmitter {
  constructor() { super(); windows++; this.webContents = Object.assign(new EventEmitter(), { send() {}, setWindowOpenHandler() {} }); }
  loadFile() { return Promise.resolve(); } loadURL() { return Promise.resolve(); } show() {} hide() {} focus() {} isFocused() { return true; }
  isMinimized() { return false; } isDestroyed() { return false; } setBounds() {} setAlwaysOnTop() {} setFullScreen() {} isFullScreen() { return true; }
  restore() {} minimize() {} getNativeWindowHandle() { return Buffer.alloc(8); } setMenu() {} setIgnoreMouseEvents() {} setSkipTaskbar() {} isVisible() { return true; }
}
const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 };
const electron = {
  app, BrowserWindow: BW,
  ipcMain: { handle(ch) { if (channels.has(ch)) problems.push('handler registered twice: ' + ch); channels.add(ch); }, on() {} },
  shell: { openExternal: async () => {}, openPath: async () => '' }, globalShortcut: { register: () => true, unregisterAll() {} },
  Menu: { setApplicationMenu() {} }, safeStorage: { isEncryptionAvailable: () => false }, dialog: {},
  screen: Object.assign(new EventEmitter(), { getAllDisplays: () => [display], getPrimaryDisplay: () => display, getDisplayMatching: () => display, dipToScreenRect: (w, r) => r, screenToDipRect: (w, r) => r }),
  Notification: class { static isSupported() { return false; } show() {} }, clipboard: { readText: () => '', writeText() {} }, powerSaveBlocker: { start() {} }
};
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return req === 'electron' ? 'electron-stub' : orig.call(this, req, ...rest); };
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: electron };
process.on('unhandledRejection', (e) => problems.push('startup error: ' + (e && e.stack || e)));
process.on('uncaughtException', (e) => problems.push('startup error: ' + (e && e.stack || e)));

// Installed app = an old built-in copy; the code being published = the update.
const APP = path.join(TMP, 'app');
fs.mkdirSync(path.join(APP, 'src'), { recursive: true });
fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify({ version: '1.0.0' }));
fs.copyFileSync(path.join(ROOT, 'src', 'boot.js'), path.join(APP, 'src', 'boot.js'));
fs.writeFileSync(path.join(APP, 'src', 'main.js'), "global.__fellBack = true;");
fs.mkdirSync(path.join(UD, 'update'), { recursive: true });
fs.cpSync(path.join(ROOT, 'src'), path.join(UD, 'update', 'src'), { recursive: true });
fs.writeFileSync(path.join(UD, 'update', 'version.json'), JSON.stringify({ version: '999.0.0' }));

require(path.join(APP, 'src', 'boot.js'));
setTimeout(() => {
  if (global.__fellBack) problems.unshift('the update could not start: ' + (global.couchUpdateFailed || 'unknown error'));
  if (!windows) problems.push('no window was created');
  if (channels.size < 20) problems.push('only ' + channels.size + ' handlers registered');
  fs.rmSync(TMP, { recursive: true, force: true });
  if (problems.length) { console.error('STARTUP CHECK FAILED\n- ' + problems.join('\n- ')); process.exit(1); }
  console.log('startup check ok: ' + windows + ' windows, ' + channels.size + ' handlers');
  process.exit(0);
}, 2500);
