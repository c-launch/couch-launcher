// Couch TV's real app core (src/couchtv) on a pretend computer: a pretend window system, the
// launcher's settings folder already there. Checks that it starts as its own app in a normal
// window, shares the launcher's Movies & TV data without touching the launcher's own files,
// keeps its own settings, and remembers where its window was.
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), Module = require('module'), EventEmitter = require('events'), assert = require('assert'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'couch-tv-'));
Object.defineProperty(process, 'platform', { value: 'win32' });
const APPDATA = path.join(TMP, 'AppData', 'Roaming');
const LAUNCHER = path.join(APPDATA, 'Couch Launcher'), OWN = path.join(APPDATA, 'Couch TV');
fs.mkdirSync(LAUNCHER, { recursive: true });
delete process.env.COUCH_TV_HOME; delete process.env.COUCH_TV_SHARED; delete process.env.COUCH_TV_SELFTEST;

const sk = require(path.join(SRC, 'sharedkey.js'));
const KEY = crypto.randomBytes(32);
// The launcher's folder, as the launcher leaves it.
const launcherLib = JSON.stringify({ version: 1, games: [{ id: 'g1', title: 'A Game', source: 'custom', launch: { type: 'exe', exe: 'C:\\g.exe' } }],
  settings: { theme: 'frosted', tvMode: 'light', tvQuality: '4K', tvSubLang: 'es', tvAutoPlay: true, tvIntro: false, mpvPath: 'C:\\mpv\\mpv.exe', displayId: 5, userName: 'Jay', cableSubs: 'en' } });
fs.writeFileSync(path.join(LAUNCHER, 'library.json'), launcherLib);
fs.writeFileSync(path.join(LAUNCHER, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), Buffer.from(KEY).reverse()]).toString('base64') } }));
fs.writeFileSync(path.join(LAUNCHER, 'tv.json'), JSON.stringify({ auth: { enc: sk.encrypt('ACCOUNT-KEY', KEY).toString('base64') }, user: { email: 'j@example.com' }, addons: [], addonsAt: Date.now(), library: {}, libraryAt: Date.now(), watched: { 'tt1:1:1': true }, dirty: {}, last: {} }));
// (Windows "unprotecting" the launcher's key: pretended. Everything after that is the real code.)
const realOpen = sk.open;
sk.open = (dir, o) => realOpen(dir, Object.assign({ platform: 'win32', ways: [['pretend', (b) => Buffer.from(b).reverse()]] }, o || {}));

const handlers = {}, wins = [];
const paths = { appData: APPDATA, home: path.join(TMP, 'home'), desktop: path.join(TMP, 'home', 'Desktop'), downloads: path.join(TMP, 'home', 'Downloads'), documents: path.join(TMP, 'home', 'Documents') };
let lock = true, quits = 0, name = 'Electron';
const app = new EventEmitter();
Object.assign(app, {
  getPath: (n) => { if (!paths[n]) throw new Error('no path ' + n); return paths[n]; }, setPath: (n, p) => { paths[n] = p; },
  setName: (n) => { name = n; }, getName: () => name, isPackaged: true, whenReady: () => Promise.resolve(), requestSingleInstanceLock: () => lock,
  quit() { quits++; }, focus() {}, show() {}, isHidden: () => false, setAboutPanelOptions() {}, getVersion: () => '0'
});
const displays = [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 }];
class BW extends EventEmitter {
  constructor(o) {
    super(); this.o = o || {}; this.visible = false; this.min = false; this.max = false; this.full = false; this.dead = false; wins.push(this);
    this.bounds = { x: o.x != null ? o.x : 320, y: o.y != null ? o.y : 140, width: o.width, height: o.height };
    this.sent = [];
    this.webContents = Object.assign(new EventEmitter(), { send: (ch, v) => this.sent.push([ch, v]), setWindowOpenHandler: (f) => { this.openHandler = f; }, reload: () => { this.reloads = (this.reloads || 0) + 1; }, forcefullyCrashRenderer() {} });
    setTimeout(() => this.emit('ready-to-show'), 5);
  }
  loadFile(f, o) { this.file = String(f); this.loadOpts = o || null; return Promise.resolve(); }
  show() { this.visible = true; this.min = false; } hide() { this.visible = false; } showInactive() { this.visible = true; } focus() { this.focused = true; }
  isMinimized() { return this.min; } restore() { this.min = false; } isDestroyed() { return this.dead; } destroy() { this.dead = true; }
  maximize() { this.max = true; } isMaximized() { return this.max; }
  setFullScreen(on) { this.full = !!on; this.emit(on ? 'enter-full-screen' : 'leave-full-screen'); } isFullScreen() { return this.full; }
  getBounds() { return this.bounds; } getNormalBounds() { return this.bounds; } setBounds(b) { Object.assign(this.bounds, b); }
  setAlwaysOnTop() {} setIgnoreMouseEvents() {}
  getNativeWindowHandle() { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(1000 + wins.indexOf(this))); return b; }
}
const electron = { app, BrowserWindow: BW,
  ipcMain: { handle(ch, fn) { assert.ok(!handlers[ch], 'handled twice: ' + ch); handlers[ch] = (...a) => fn({}, ...a); }, on() {} },
  shell: { openExternal: async () => {} }, Menu: { setApplicationMenu(m) { electron.menu = m; }, buildFromTemplate: (t) => t },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('OWN:' + s), decryptString: (b) => { const t = b.toString(); if (!t.startsWith('OWN:')) throw new Error('not mine'); return t.slice(4); } },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  screen: Object.assign(new EventEmitter(), { getAllDisplays: () => displays, getPrimaryDisplay: () => displays[0], getDisplayMatching: () => displays[0], dipToScreenRect: (w, r) => r }),
  clipboard: { readText: () => '', writeText() {} } };
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return req === 'electron' ? 'electron-stub' : orig.call(this, req, ...rest); };
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: electron };
const world = { calls: [] };
require.cache[path.join(SRC, 'win32.js')] = { id: 'w', filename: path.join(SRC, 'win32.js'), loaded: true, exports: { createWin32: () => ({
  hwndOf: (bw) => 1000 + wins.indexOf(bw), forceForeground: (h) => world.calls.push('front ' + h), findAppWindow: () => null, rect: () => null, move() {} }) } };
require.cache[path.join(SRC, 'hotkey.js')] = { id: 'h', filename: path.join(SRC, 'hotkey.js'), loaded: true, exports: { createControllerWatcher: (o) => { world.ctl = o; return { start() { world.calls.push('pad start'); }, stop() { world.calls.push('pad stop'); } }; } } };
const errors = [];
process.on('unhandledRejection', (e) => errors.push(e && e.stack || e));
process.on('uncaughtException', (e) => { console.error(e); process.exit(1); });
let verdict = false;
process.on('exit', (c) => { if (!verdict && c === 0) { console.error('couch tv test ended without a verdict'); process.exitCode = 1; } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// (What crosses between the screen and the app core is always a copy, as with the real thing.)
const copy = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const call = async (ch, ...a) => { assert.ok(handlers[ch], 'no handler for ' + ch); const r = copy(await handlers[ch](...a.map(copy))); if (!r.ok) throw new Error(r.error); return r.value; };
const freshStart = () => {
  for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(SRC, 'couchtv')) || /[\\/]src[\\/](tvmain|stremio|cable|library)\.js$/.test(k)) delete require.cache[k];
  for (const k of Object.keys(handlers)) delete handlers[k];
  app.removeAllListeners(); wins.length = 0; delete paths.userData;
  require(path.join(SRC, 'couchtv', 'boot.js'));
};

(async () => {
  freshStart();
  await sleep(60);
  // ---------- its own app, its own folder
  assert.strictEqual(name, 'Couch TV');
  assert.strictEqual(paths.userData, OWN, 'settings folder: ' + paths.userData);
  assert.strictEqual(global.couchTvShared, LAUNCHER);
  assert.strictEqual(wins.length, 1, 'one window');
  const w = wins[0];
  assert.ok(/renderer[\\/]index\.html$/.test(w.file) && w.loadOpts && w.loadOpts.query.tvapp === '1', 'the launcher’s screens in TV-only mode');
  assert.strictEqual(w.o.title, 'Couch TV');
  assert.ok(!w.o.fullscreen && !w.o.simpleFullscreen && w.o.frame !== false && w.o.resizable !== false, 'a normal window: not full screen, with its frame, resizable');
  assert.ok(w.o.width <= 1280 && w.o.height <= 760 && w.o.width >= 820 && w.o.center === true, 'first time: a sensible size in the middle');
  assert.ok(w.o.minWidth >= 800 && w.o.minHeight >= 500);
  assert.ok(fs.existsSync(w.o.icon), 'its icon is there: ' + w.o.icon);
  assert.ok(fs.existsSync(w.o.webPreferences.preload) && w.o.webPreferences.contextIsolation && w.o.webPreferences.sandbox && !w.o.webPreferences.nodeIntegration);
  assert.strictEqual(electron.menu, null, 'no menu bar on Windows');
  assert.ok(w.visible, 'shown');
  let prevented = false; w.emit('page-title-updated', { preventDefault() { prevented = true; } });
  assert.ok(prevented, 'the title stays Couch TV');
  assert.deepStrictEqual(w.openHandler(), { action: 'deny' });

  // ---------- everything the screens ask for is answered
  const preload = fs.readFileSync(path.join(SRC, 'preload.js'), 'utf8');
  const channels = [...preload.matchAll(/call\('(tv:[A-Za-z]+)'/g)].map((m) => m[1]).filter((c) => c !== 'tv:guideStop');
  assert.ok(channels.length > 30);
  for (const ch of channels.concat(['lib:load', 'lib:save', 'app:info', 'app:started', 'log:error', 'pads:get', 'fs:list', 'fs:pick', 'fs:stat', 'tvapp:fullscreen'])) assert.ok(handlers[ch], 'answers ' + ch);
  for (const ch of ['launch', 'scan', 'overlay:hide', 'app:power', 'update:install', 'yt:open']) assert.ok(!handlers[ch], 'has nothing to do with ' + ch);

  // ---------- settings: started from the launcher's, then its own
  const lib = await call('lib:load');
  assert.deepStrictEqual(lib.games, [], 'no games');
  assert.strictEqual(lib.settings.tvMode, 'light'); assert.strictEqual(lib.settings.tvQuality, '4K'); assert.strictEqual(lib.settings.tvSubLang, 'es');
  assert.strictEqual(lib.settings.tvAutoPlay, true); assert.strictEqual(lib.settings.tvIntro, false); assert.strictEqual(lib.settings.mpvPath, 'C:\\mpv\\mpv.exe');
  assert.strictEqual(lib.settings.theme, 'macos', 'the launcher’s other settings are not carried over');
  assert.strictEqual(lib.settings.userName, 'Player');
  assert.strictEqual(w.o.backgroundColor, '#F5F5F7', 'the window starts in its look (light)');
  const info = await call('app:info');
  assert.ok(info.tvApp && info.windowed && info.sharedWithLauncher && info.sharedSignIn && info.version, JSON.stringify(info));
  lib.settings.tvMode = 'dark'; lib.settings.tvQuality = '720p'; lib.settings.theme = 'macoslight'; lib.settings.mpvPath = 'C:\\evil.exe'; lib.settings.cableSubs = 'zz'; lib.settings.userName = 'X';
  lib.games = [{ id: 'x' }];
  await call('lib:save', lib);
  const own = JSON.parse(fs.readFileSync(path.join(OWN, 'settings.json'), 'utf8'));
  assert.strictEqual(own.settings.tvMode, 'dark'); assert.strictEqual(own.settings.tvQuality, '720p');
  assert.strictEqual(own.settings.mpvPath, 'C:\\mpv\\mpv.exe', 'the screen cannot change where the player is');
  assert.strictEqual(own.settings.cableSubs, 'en');
  assert.ok(!('theme' in own.settings) && !('userName' in own.settings) && !own.games, 'only Couch TV’s own settings are kept: ' + Object.keys(own.settings));
  assert.strictEqual(fs.readFileSync(path.join(LAUNCHER, 'library.json'), 'utf8'), launcherLib, 'the launcher’s library and settings are never written');
  assert.ok(!fs.existsSync(path.join(OWN, 'tv.json')) && !fs.existsSync(path.join(OWN, 'cable.json')), 'no second copy of the Movies & TV data');
  await call('lib:save', null); await call('lib:save', { settings: 'x' }); // (nonsense changes nothing)
  assert.strictEqual((await call('lib:load')).settings.tvMode, 'dark');

  // ---------- the launcher's Movies & TV data, sign-in included
  const st = await call('tv:status');
  assert.strictEqual(st.signedIn, true, 'signed in with the launcher’s sign-in');
  assert.strictEqual(st.email, 'j@example.com');
  assert.deepStrictEqual(await call('tv:watched', ['tt1:1:1', 'tt2:1:1']), { 'tt1:1:1': true });
  await call('tv:setWatched', 'tt2:1:1', true);
  await sleep(600);
  const tvj = JSON.parse(fs.readFileSync(path.join(LAUNCHER, 'tv.json'), 'utf8'));
  assert.ok(tvj.watched['tt2:1:1'] && tvj.watched['tt1:1:1'], 'saved in the launcher’s file');
  assert.strictEqual(sk.decrypt(Buffer.from(tvj.auth.enc, 'base64'), KEY), 'ACCOUNT-KEY', 'the sign-in is still the launcher’s to read');
  const eras = await call('tv:cableEras');
  assert.ok(Array.isArray(eras) && eras.length >= 2);
  await call('tv:cableSetEras', [eras[0].id]); await sleep(500);
  assert.ok(fs.existsSync(path.join(LAUNCHER, 'cable.json')), 'Cable TV’s channels are kept in the launcher’s folder');
  await assert.rejects(call('tv:play', { meta: { id: 'tt1', type: 'movie', name: 'X' } }), /NO_MPV|mpv/i, 'without a player it says so');

  // ---------- small things
  assert.strictEqual(await call('app:started'), true);
  assert.strictEqual(await call('log:error', 'a screen mistake'), true);
  assert.ok(/a screen mistake/.test(fs.readFileSync(path.join(OWN, 'errors.log'), 'utf8')), 'mistakes are written to its own errors.log');
  assert.deepStrictEqual(await call('pads:get'), []);
  assert.strictEqual(await call('tvapp:fullscreen'), true); assert.ok(w.full);
  assert.ok(w.sent.some(([ch, v]) => ch === 'tvapp:fullscreen' && v === true), 'the screen is told');
  assert.strictEqual(await call('tvapp:fullscreen', false), false);
  let stopped = false; w.webContents.emit('before-input-event', { preventDefault() { stopped = true; } }, { type: 'keyDown', key: 'F11' });
  assert.ok(stopped && w.full, 'F11 goes full screen');
  w.webContents.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', key: 'F11' });
  assert.ok(!w.full, 'and back');
  w.webContents.emit('before-input-event', { preventDefault() { throw new Error('other keys are the page’s'); } }, { type: 'keyDown', key: 'Enter' });
  const top = await call('fs:list', '');
  assert.ok(top.entries.some((e) => e.name === 'Home folder'));
  assert.deepStrictEqual(await call('fs:stat', path.join(LAUNCHER, 'tv.json')), { exists: true, isDir: false, path: path.join(LAUNCHER, 'tv.json') });
  assert.strictEqual(await call('fs:pick', {}), null);
  // A second start: the one already open comes forward.
  w.min = true; app.emit('second-instance');
  assert.ok(!w.min && world.calls.includes('front 1000'), 'a second start brings the window forward');
  // A crashed screen is loaded again, a few times at most.
  for (let i = 0; i < 5; i++) w.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  await sleep(400);
  assert.strictEqual(w.reloads, 3, 'reloaded ' + w.reloads + ' times');
  w.webContents.emit('render-process-gone', {}, { reason: 'clean-exit' });

  // ---------- where the window was
  w.bounds = { x: 200, y: 120, width: 1400, height: 800 }; w.emit('resize');
  w.full = true; w.bounds = { x: 0, y: 0, width: 1920, height: 1080 }; w.emit('resize'); w.full = false; // (full screen is not a place to come back to)
  w.bounds = { x: 200, y: 120, width: 1400, height: 800 };
  w.emit('close'); w.dead = true; w.emit('closed');
  assert.ok(quits >= 1, 'closing the window ends the app');
  app.emit('before-quit');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(OWN, 'settings.json'), 'utf8')).window, { x: 200, y: 120, width: 1400, height: 800, maximized: false });
  freshStart(); await sleep(60);
  let w2 = wins[0];
  assert.ok(w2.o.x === 200 && w2.o.y === 120 && w2.o.width === 1400 && w2.o.height === 800 && !w2.o.center, 'opens where it was');
  assert.strictEqual((await call('lib:load')).settings.tvMode, 'dark', 'its own settings, not the launcher’s again');
  assert.strictEqual(w2.o.backgroundColor, '#000000');
  w2.max = true; w2.emit('maximize'); w2.emit('close'); w2.dead = true; app.emit('before-quit');
  freshStart(); await sleep(60);
  w2 = wins[0];
  assert.ok(w2.max, 'opens maximized when it was');
  // The screen it was on is gone: back to the middle of the main one.
  const s = JSON.parse(fs.readFileSync(path.join(OWN, 'settings.json'), 'utf8'));
  s.window = { x: 5000, y: 300, width: 1400, height: 800, maximized: false };
  w2.emit('close'); w2.dead = true; app.emit('before-quit');
  fs.writeFileSync(path.join(OWN, 'settings.json'), JSON.stringify(s));
  freshStart(); await sleep(60);
  assert.ok(wins[0].o.center === true && wins[0].o.x === undefined, 'a window left on a screen that is gone opens in the middle');
  // A damaged settings file: starts from the launcher's again instead of failing.
  wins[0].dead = true;
  fs.writeFileSync(path.join(OWN, 'settings.json'), '{ nope'); try { fs.unlinkSync(path.join(OWN, 'settings.json.bak')); } catch (_) { /* none */ }
  freshStart(); await sleep(60);
  assert.strictEqual((await call('lib:load')).settings.tvQuality, '4K');
  wins[0].dead = true;

  // ---------- already running: the second one leaves at once
  lock = false; const q0 = quits;
  freshStart(); await sleep(30);
  assert.ok(quits > q0 && wins.length === 0, 'a second copy quits without a window');
  lock = true;

  // ---------- no launcher on this PC: still starts, with defaults, and makes the shared folder
  fs.rmSync(LAUNCHER, { recursive: true, force: true }); fs.rmSync(OWN, { recursive: true, force: true });
  freshStart(); await sleep(60);
  assert.strictEqual(wins.length, 1);
  const l3 = await call('lib:load');
  assert.strictEqual(l3.settings.tvMode, 'dark'); assert.strictEqual(l3.settings.tvQuality, '1080p');
  const i3 = await call('app:info');
  assert.ok(!i3.sharedWithLauncher && !i3.sharedSignIn);
  assert.strictEqual((await call('tv:status')).signedIn, false);
  await call('tv:setWatched', 'tt5', true); await sleep(600);
  assert.ok(fs.existsSync(path.join(LAUNCHER, 'tv.json')), 'kept where the launcher will find it');
  assert.ok(!fs.existsSync(path.join(LAUNCHER, 'library.json')), 'and nothing of the launcher’s own is made up');
  wins[0].dead = true;

  await sleep(50);
  assert.deepStrictEqual(errors, [], 'no stray errors: ' + errors.join('\n'));
  fs.rmSync(TMP, { recursive: true, force: true });
  verdict = true;
  console.log('couch tv ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
