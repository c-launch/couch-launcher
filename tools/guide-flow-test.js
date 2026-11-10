// The launcher's real main.js on a pretend Windows: pretend windows, a pretend "who is in front"
// and a pretend pauser, with a real child process as the game. Follows the guide through the
// GTA case and a hand-back that Windows refuses.
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), Module = require('module'), EventEmitter = require('events'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'couch-winflow-'));
Object.defineProperty(process, 'platform', { value: 'win32' });
const UD = path.join(TMP, 'userData');
const handlers = {}, shortcuts = {}, wins = [];
const world = { fg: null, allowFocus: true, calls: [], paused: new Set(), minimized: new Set() };
let nextH = 1000;

const app = new EventEmitter();
Object.assign(app, { getPath: (n) => (n === 'userData' ? UD : path.join(UD, n)), getVersion: () => '1.0.0', isPackaged: true, whenReady: () => Promise.resolve(), requestSingleInstanceLock: () => true,
  setLoginItemSettings() {}, getLoginItemSettings: () => ({}), disableHardwareAcceleration() {}, commandLine: { appendSwitch() {} }, quit() {}, exit() {}, relaunch() {}, setAppUserModelId() {},
  focus() {}, hide() {}, show() {}, isHidden: () => false, getApplicationNameForProtocol: () => '', dock: { show() {}, hide() {} } });
class BW extends EventEmitter {
  constructor(o) { super(); this.h = nextH++; this.o = o || {}; this.visible = false; this.min = false; wins.push(this);
    this.webContents = Object.assign(new EventEmitter(), { send: (ch) => { this.sent = (this.sent || []).concat(ch); }, setWindowOpenHandler() {}, isLoading: () => false, getURL: () => 'file://x/index.html', executeJavaScript: async () => '{}', capturePage: async () => ({ toPNG: () => Buffer.alloc(0) }) });
    setTimeout(() => this.emit('ready-to-show'), 5); }
  loadFile() { return Promise.resolve(); } loadURL() { return Promise.resolve(); }
  show() { this.visible = true; this.min = false; } hide() { this.visible = false; if (world.fg && world.fg.hwnd === this.h) world.fg = wins[0].visible && !wins[0].min && wins[0] !== this ? { hwnd: wins[0].h, pid: process.pid } : world.under; }
  focus() {} isFocused() { return !!world.fg && world.fg.hwnd === this.h; }
  isMinimized() { return this.min; } isDestroyed() { return false; } setBounds() {} setAlwaysOnTop() {} setFullScreen() {} isFullScreen() { return true; }
  restore() { this.min = false; } minimize() { this.min = true; world.calls.push('win.minimize'); if (world.fg && world.fg.hwnd === this.h) world.fg = world.under; }
  getNativeWindowHandle() { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(this.h)); return b; } setMenu() {} setIgnoreMouseEvents() {} setSkipTaskbar() {} isVisible() { return this.visible; }
  setSimpleFullScreen() {} isSimpleFullScreen() { return true; } moveTop() {} setVisibleOnAllWorkspaces() {} setFullScreenable() {} setHiddenInMissionControl() {} getBounds() { return display.bounds; }
}
const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 };
const electron = { app, BrowserWindow: BW,
  ipcMain: { handle(ch, fn) { handlers[ch] = (...a) => fn({}, ...a); }, on() {} },
  shell: { openExternal: async () => {}, openPath: async () => '' }, globalShortcut: { register: (k, fn) => { shortcuts[k] = fn; return true; }, unregisterAll() {} },
  Menu: { setApplicationMenu() {}, buildFromTemplate: (t) => t }, safeStorage: { isEncryptionAvailable: () => false }, dialog: {},
  screen: Object.assign(new EventEmitter(), { getAllDisplays: () => [display], getPrimaryDisplay: () => display, getDisplayMatching: () => display, dipToScreenRect: (w, r) => r, screenToDipRect: (w, r) => r }),
  nativeTheme: {}, Notification: class { static isSupported() { return false; } show() {} }, clipboard: { readText: () => '', writeText() {} }, powerSaveBlocker: { start() {} } };
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return req === 'electron' ? 'electron-stub' : orig.call(this, req, ...rest); };
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: electron };
const errors = [];
process.on('unhandledRejection', (e) => errors.push(e && e.stack || e));
process.on('uncaughtException', (e) => errors.push(e && e.stack || e));

const APP = path.join(TMP, 'app');
fs.mkdirSync(path.join(APP, 'src'), { recursive: true });
fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify({ version: '1.0.0' }));
fs.copyFileSync(path.join(ROOT, 'src', 'boot.js'), path.join(APP, 'src', 'boot.js'));
fs.writeFileSync(path.join(APP, 'src', 'main.js'), 'global.__fellBack = true;');
const SRC = path.join(UD, 'update', 'src');
fs.mkdirSync(path.join(UD, 'update'), { recursive: true });
fs.cpSync(path.join(ROOT, 'src'), SRC, { recursive: true });
fs.writeFileSync(path.join(UD, 'update', 'version.json'), JSON.stringify({ version: '999.0.0' }));
fs.writeFileSync(path.join(UD, 'library.json'), JSON.stringify({ games: [{ id: 'g1', title: 'Grand Theft Auto V', source: 'custom', launch: { type: 'exe', exe: '/bin/sleep' }, args: '120' }], settings: { firstRun: false } }));

// the pretend Windows
const GAME_H = 500;
const w32 = new Proxy({
  foreground: () => world.fg, hwndOf: (bw) => bw.h, exists: (h) => !!h, exclusiveFullScreen: () => false, isIconic: (h) => world.minimized.has(h), isZoomed: () => false,
  minimize: (h) => { world.calls.push('minimize ' + h); world.minimized.add(h); if (world.fg && world.fg.hwnd === h) world.fg = null; },
  restore: (h) => { world.calls.push('restore ' + h); world.minimized.delete(h); },
  focus: (h) => { world.calls.push('focus ' + h); },
  forceForeground(h) {
    world.calls.push('force ' + h);
    assert.ok(!(world.fg && world.paused.has(world.fg.pid) && !this.isFrozen(world.fg.pid)), 'isFrozen must know paused programs');
    const own = wins.find((x) => x.h === h);
    if (own ? world.allowFocus : world.allowGame) world.fg = { hwnd: h, pid: own ? process.pid : world.gamePid };
  },
  placeBelow: () => true, rect: () => ({ x: 0, y: 0, width: 1920, height: 1080 }), windowOfPids: () => GAME_H, findAppWindow: () => null, frontInfo: () => null, dpiScale: () => 1
}, { get: (t, k) => (k in t ? t[k] : (k === 'isGentle' || k === 'isFrozen' ? undefined : () => null)), set: (t, k, v) => { t[k] = v; return true; } });
require.cache[path.join(SRC, 'win32.js')] = { id: 'w', filename: path.join(SRC, 'win32.js'), loaded: true, exports: { createWin32: () => w32 } };
// the controller reader: the test presses the buttons
require.cache[path.join(SRC, 'hotkey.js')] = { id: 'h', filename: path.join(SRC, 'hotkey.js'), loaded: true, exports: {
  createControllerWatcher: (o) => { world.ctl = o; return { start() {}, stop() {}, setGameRunning() {}, setJoin() {}, available: true, guide: true, xboxShareReadable: false, shareDebug: () => ({ xbox: [] }), learnShare: () => false, macDebug: () => ({}) }; },
  loadXInput: () => { throw new Error('no XInput here'); }, readPads: () => [], padType: () => 'xbox' } };
const padExt = () => (wins[0].sent || []).filter((ch) => ch === 'pad:ext').length;
const press = async (n) => { for (let i = 0; i < (n || 5); i++) { world.ctl.onButtons(0x1000, 0, 0); await wait(20); world.ctl.onButtons(0, 0, 0); await wait(20); } };
const pauser = { available: true, isPaused: () => world.paused.size > 0, has: (p) => world.paused.has(p),
  pause(pids, still) { world.calls.push('pause'); return new Promise((res) => setTimeout(() => { if (!still || still()) for (const p of pids) world.paused.add(p); res(); }, 300)); },
  resumeAll() { if (world.paused.size) world.calls.push('resume'); world.paused.clear(); }, resumeAfterPending() { this.resumeAll(); return Promise.resolve(); } };
require.cache[path.join(SRC, 'pause.js')] = { id: 'p', filename: path.join(SRC, 'pause.js'), loaded: true, exports: { createPauser: () => pauser } };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// a frozen game must never be the window in front for longer than a blink
let frozenFront = 0;
setInterval(() => { if (world.fg && world.paused.has(world.fg.pid)) { if (++frozenFront > 8) { console.error('FROZEN GAME LEFT IN FRONT', world.calls); process.exit(1); } } else frozenFront = 0; }, 50);

require(path.join(APP, 'src', 'boot.js'));
(async () => {
  await wait(2500);
  assert.ok(!global.__fellBack, 'the launcher started: ' + global.couchUpdateFailed);
  const win = wins[0];
  world.fg = { hwnd: win.h, pid: process.pid };
  const r = await handlers.launch('g1');
  assert.ok(r.ok, JSON.stringify(r));
  const st = (await handlers['game:status']()).value;
  assert.ok(st && st.gameId === 'g1');
  const ps = require('child_process').execFileSync('pgrep', ['-n', '-f', 'sleep 120']).toString().trim();
  world.gamePid = Number(ps); world.under = { hwnd: GAME_H, pid: world.gamePid }; world.allowGame = true;
  // the game takes the screen
  world.fg = world.under; win.emit('blur'); await wait(700);
  assert.ok(world.calls.includes('focus ' + GAME_H), 'handed over: ' + world.calls);
  await wait(1200); assert.ok(!world.paused.size && !world.calls.includes('pause'), 'not paused while playing');
  // playing with the controller: the launcher behind the game neither reads it nor pulls the screen back
  world.calls.length = 0; let n0 = padExt();
  await press(10);
  assert.ok(padExt() === n0 && !world.calls.some((x) => x === 'force ' + win.h) && world.fg.hwnd === GAME_H, 'hands off the controller in a game: ' + world.calls);

  // 1) guide: it gets the screen, the game is paused
  world.calls.length = 0;
  shortcuts['Control+Alt+Home'](); await wait(1300);
  const ov = wins[1];
  assert.ok(ov && ov.visible && world.fg.hwnd === ov.h, 'guide open and in front');
  assert.ok(world.paused.has(world.gamePid), 'game paused: ' + world.calls);
  // 2) GTA takes the screen back, frozen
  world.calls.length = 0; world.fg = world.under;
  await wait(250); assert.ok(!world.paused.size, 'woken at once: ' + world.calls);
  await wait(900);
  assert.ok(!ov.visible && world.calls.includes('minimize ' + GAME_H), 'game stepped aside, guide on the launcher screen: ' + world.calls);
  assert.ok(world.calls.indexOf('resume') < world.calls.indexOf('minimize ' + GAME_H), 'woken before it is asked to step aside');
  assert.ok(world.fg && world.fg.hwnd === win.h, 'launcher in front');
  assert.ok((win.sent || []).includes('overlay'), 'guide shown on the launcher screen');
  await wait(1200); assert.ok(world.paused.has(world.gamePid), 'paused behind the launcher');
  // 3) Resume, and Windows refuses to hand the screen to the game: asked again, then the launcher minimizes
  world.calls.length = 0; world.allowGame = false;
  assert.ok((await handlers['game:resume']()).ok);
  await wait(200); assert.ok(!world.paused.size && world.calls.includes('restore ' + GAME_H), 'woken and restored: ' + world.calls);
  await wait(2200);
  assert.ok(world.calls.filter((c) => c === 'force ' + GAME_H).length >= 3 && world.calls.includes('win.minimize'), 'retried, then minimized: ' + world.calls);
  assert.ok(world.fg.hwnd === GAME_H && !world.paused.size, 'game in front and awake');
  await wait(2500); assert.ok(!world.paused.size && !world.calls.includes('pause'), 'left alone while playing');
  // the launcher asked for the front earlier (guide on its own screen) and the game has the screen
  // again: still hands off, however the game got it back
  win.min = false; world.calls.length = 0; n0 = padExt();
  await press(10); await wait(3200); await press(10);
  assert.ok(padExt() === n0 && !world.calls.some((x) => x === 'force ' + win.h) && world.fg.hwnd === GAME_H, 'hands off after the guide too: ' + world.calls + ' ' + (padExt() - n0));
  // 4) guide again: this game now uses the launcher's own screen straight away
  world.calls.length = 0; world.allowGame = true;
  shortcuts['Control+Alt+Home'](); await wait(900);
  assert.ok(world.calls.includes('minimize ' + GAME_H) && world.fg.hwnd === win.h && !win.min, 'second guide press: ' + world.calls);
  // guide button again = back to the game? at least nothing is fought over
  await wait(1500); assert.ok(world.paused.has(world.gamePid));
  await handlers['game:resume'](); await wait(800);
  assert.ok(world.fg.hwnd === GAME_H && !world.paused.size);
  // 5) the game closes: nothing left frozen, launcher back
  world.calls.length = 0;
  process.kill(world.gamePid); await wait(900);
  assert.strictEqual((await handlers['game:status']()).value, null);
  assert.ok(!world.paused.size);
  assert.deepStrictEqual(errors, [], 'no errors: ' + errors.join('\n'));
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('windows guide flow ok');
  process.exit(0);
})().catch((e) => { console.error(e, '\ncalls:', world.calls, '\nerrors:', errors); try { process.kill(world.gamePid); } catch (_) {} process.exit(1); });
