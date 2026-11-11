'use strict';
// Couch TV's app core: one normal, resizable window showing the Movies & TV screens
// (../renderer, in "TV only" mode), with the same Movies & TV part the launcher uses (../tvmain).
//
// What is shared with Couch Launcher (kept in the launcher's settings folder, see boot.js):
// your Stremio sign-in, addons, list, what you've watched, Cable TV's channels, the video
// player (mpv) and the helpers for commercials. Couch TV's own settings (look, quality,
// subtitles, where its window was) are its own, started from the launcher's the first time.
const { app, BrowserWindow, ipcMain, shell, Menu, safeStorage, dialog, screen, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

// Fail-safe for updates (as in the launcher). boot.js falls back to the built-in app when an
// update can't be loaded at all. This covers the update that loads but never gets as far as
// showing its first screen: each start is counted until the screen reports it is up; after two
// starts in a row that didn't get there, this stops right here, and boot.js runs the built-in
// app instead. Only when running as an installed update.
const UPDATE_RUN = (() => { try { return path.resolve(__dirname).startsWith(path.join(path.resolve(app.getPath('userData')), 'update') + path.sep); } catch (_) { return false; } })();
const healthFile = () => path.join(app.getPath('userData'), 'update-health.json');
const readHealth = () => { try { const h = JSON.parse(fs.readFileSync(healthFile(), 'utf8')); return h && typeof h === 'object' ? h : null; } catch (_) { return null; } };
if (UPDATE_RUN) {
  const h = readHealth();
  if (h && h.version === global.couchVersion && !h.ok && h.starts >= 2) {
    try { fs.unlinkSync(healthFile()); } catch (_) { /* gone */ }
    throw new Error('This update didn’t get to its first screen twice in a row');
  }
}
const library = require('../library');
const { readJson, writeJson } = require('../safefile');
const { createWin32 } = require('../win32');
const { registerFsBrowse } = require('./fsbrowse');
const { createEmbed } = require('./embed');
const { CORE, pickOwn, onScreen } = require('./util');

const MAC = process.platform === 'darwin';
const VERSION = global.couchVersion || require('../../package.json').version;
const SHARED = global.couchTvShared || path.join(app.getPath('appData'), 'Couch Launcher');
const SRC = path.join(__dirname, '..');

// Mistakes go to errors.log in Couch TV's settings folder (a few of the same in a row at most).
let lastLogged = '', sameLogged = 0;
function logError(kind, err) {
  try {
    const text = kind + ': ' + String((err && err.stack) || err).slice(0, 2000);
    if (text === lastLogged) { if (++sameLogged > 3) return; } else { lastLogged = text; sameLogged = 0; }
    const f = path.join(app.getPath('userData'), 'errors.log');
    try { if (fs.statSync(f).size > 512 * 1024) fs.renameSync(f, f + '.old'); } catch (_) { /* new file */ }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, new Date().toISOString() + ' ' + text + '\n');
  } catch (_) { /* nowhere to write */ }
}
process.on('uncaughtException', (err) => logError('error', err));
process.on('unhandledRejection', (err) => logError('unhandled', err));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // (Update fail-safe, see the top of this file: one more start that hasn't shown its screen yet.)
  let healthy = !UPDATE_RUN;
  if (UPDATE_RUN) {
    const h = readHealth(), same = h && h.version === global.couchVersion;
    if (same && h.ok) healthy = true;
    else { try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(healthFile(), JSON.stringify({ version: global.couchVersion, starts: same ? (Number(h.starts) || 0) + 1 : 1, ok: false })); } catch (_) { /* not counted */ } }
  }
  const markHealthy = () => {
    if (healthy) return;
    healthy = true;
    try { fs.writeFileSync(healthFile(), JSON.stringify({ version: global.couchVersion, starts: 0, ok: true })); } catch (_) { /* counted again next time */ }
  };
  let win = null;
  let tvPart = null;
  const file = () => path.join(app.getPath('userData'), 'settings.json');
  // { settings: {...}, window: { x, y, width, height, maximized } }
  let saved = null;
  let lib = null; // what the screens are given: shaped like the launcher's library, with no games
  function load() {
    saved = readJson(file());
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = null;
    if (!saved) {
      // First time: start from how Movies & TV is set up in the launcher (if it is installed).
      let from = null;
      try { const l = readJson(path.join(SHARED, 'library.json')); from = l && l.settings; } catch (_) { from = null; }
      saved = { settings: pickOwn(from), window: null };
    }
    if (!saved.settings || typeof saved.settings !== 'object') saved.settings = {};
    lib = library.emptyLibrary();
    Object.assign(lib.settings, pickOwn(saved.settings), { windowed: true, autostart: false });
  }
  let saveT = null;
  const persist = () => {
    saved.settings = pickOwn(lib.settings);
    try { writeJson(file(), saved, true); } catch (err) { logError('save', err); }
  };
  const persistSoon = () => { clearTimeout(saveT); saveT = setTimeout(persist, 500); };

  const w32 = createWin32();
  // The player's picture inside this window (Windows; see embed.js). Without it, or with
  // Settings › Play videos in the window switched off, videos take the whole screen.
  const embedApi = createEmbed();
  const hwnd = () => { const b = win.getNativeWindowHandle(); return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0); };
  const fitPlayer = () => { try { if (embedApi && tvPart && tvPart.inWindow && win && !win.isDestroyed()) embedApi.fit(hwnd()); } catch (_) { /* the player follows by itself too */ } };
  const follow = () => { try { if (tvPart) tvPart.follow(); } catch (_) { /* closing */ } fitPlayer(); };
  const embed = {
    wid: () => (embedApi && lib && lib.settings.tvInWindow !== false && win && !win.isDestroyed() && !win.isMinimized() ? hwnd() : null),
    bounds: () => win.getContentBounds(),
    parent: () => win,
    fullscreen: () => { if (win && !win.isDestroyed()) win.setFullScreen(!win.isFullScreen()); },
    front: () => { if (win && !win.isDestroyed() && !win.isFocused()) bringBack(); }
  };
  function send(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
  function handle(ch, fn) {
    return ipcMain.handle(ch, async (_e, ...args) => {
      try { return { ok: true, value: await fn(...args) }; } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
    });
  }

  // The screen Couch TV's window is on: videos open there.
  function targetDisplay() {
    try { if (win && !win.isDestroyed()) return screen.getDisplayMatching(win.getBounds()); } catch (_) { /* the main one */ }
    return screen.getPrimaryDisplay();
  }
  const toPx = (rect) => (process.platform === 'win32' && screen.dipToScreenRect ? screen.dipToScreenRect(null, rect) : rect);
  // The player's window appears a moment after it is started: once it does it is put over that
  // whole screen and given the keyboard (again if it moved itself while loading).
  function presentApp(exes, titlePrefix, ms) {
    let stopped = false;
    if (!w32) return () => {};
    const done = new Map();
    const until = Date.now() + (ms || 15000);
    const tick = () => {
      if (stopped) return;
      let h = null;
      try { h = w32.findAppWindow(exes, titlePrefix, true); } catch (_) { h = null; }
      if (h && (done.get(h) || 0) < 3) {
        try {
          const b = toPx(targetDisplay().bounds), r = w32.rect(h);
          const there = r && r.x === b.x && r.y === b.y && r.width === b.width && r.height === b.height;
          if (!done.has(h) || !there) {
            done.set(h, (done.get(h) || 0) + 1);
            if (!there) w32.move(h, b.x, b.y, b.width, b.height);
            w32.forceForeground(h);
          }
        } catch (_) { /* the window went away */ }
      }
      if (Date.now() < until) setTimeout(tick, 700);
    };
    tick();
    return () => { stopped = true; };
  }
  function bringBack() {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    if (MAC) { try { if (app.isHidden()) app.show(); } catch (_) { /* older Electron */ } }
    win.show();
    try { if (w32) w32.forceForeground(w32.hwndOf(win)); } catch (_) { /* focus() below */ }
    if (MAC) app.focus({ steal: true });
    win.focus();
  }

  // ---------- the window
  function rememberWindow() {
    if (!win || win.isDestroyed() || !saved) return;
    try {
      if (win.isMinimized() || win.isFullScreen()) return;
      const b = win.getNormalBounds();
      saved.window = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() };
      persistSoon();
    } catch (_) { /* closed meanwhile */ }
  }
  function createWindow() {
    const w = saved.window;
    const ok = onScreen(w, screen.getAllDisplays());
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.min(1280, area.width - 80), height = Math.min(760, area.height - 80);
    win = new BrowserWindow(Object.assign({
      title: 'Couch TV',
      icon: path.join(SRC, 'renderer', 'couchtv.png'),
      minWidth: 820, minHeight: 520,
      backgroundColor: lib.settings.tvMode === 'light' ? '#F5F5F7' : '#000000',
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(SRC, 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
      }
    }, ok ? { x: w.x, y: w.y, width: w.width, height: w.height } : { width, height, center: true }));
    if (ok && w.maximized) win.maximize();
    Menu.setApplicationMenu(MAC ? Menu.buildFromTemplate([
      { label: 'Couch TV', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'togglefullscreen' }] },
      { role: 'windowMenu' }]) : null);
    if (MAC) { try { app.setAboutPanelOptions({ applicationName: 'Couch TV', applicationVersion: VERSION, copyright: 'Made by Jahdiel', credits: 'Movies, series and Cable TV.' }); } catch (_) { /* older Electron */ } }
    win.once('ready-to-show', () => { win.show(); win.focus(); });
    win.on('page-title-updated', (e) => e.preventDefault()); // the page is the launcher's: the title stays "Couch TV"
    win.loadFile(path.join(SRC, 'renderer', 'index.html'), { query: { tvapp: '1' } });
    for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, rememberWindow);
    // What plays inside the window (its picture and the controls over it) goes where it goes.
    for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen']) win.on(ev, follow);
    for (const ev of ['maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen']) win.on(ev, () => setTimeout(follow, 300)); // (once the change has settled)
    win.on('focus', () => send('window:focus'));
    win.on('enter-full-screen', () => send('tvapp:fullscreen', true));
    win.on('leave-full-screen', () => send('tvapp:fullscreen', false));
    win.on('close', () => { clearTimeout(saveT); persist(); });
    win.on('closed', () => { win = null; app.quit(); });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    // F11 (and Alt+Enter): full screen and back, whatever the page is doing.
    win.webContents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown' || input.isAutoRepeat) return;
      if (input.key === 'F11' || (input.key === 'Enter' && input.alt)) { e.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
    });
    // A screen that crashed or froze is loaded again (three times in ten minutes at most).
    const times = [];
    let hung = null;
    const again = (why) => {
      logError('screen', why);
      const t = Date.now();
      while (times.length && t - times[0] > 10 * 60e3) times.shift();
      if (times.length >= 3 || !win || win.isDestroyed()) return;
      times.push(t);
      try { if (tvPart && tvPart.playing) tvPart.stop('back'); } catch (_) { /* reload anyway */ }
      const w0 = win;
      setTimeout(() => { try { if (!w0.isDestroyed()) w0.webContents.reload(); } catch (_) { /* closed meanwhile */ } }, 300);
    };
    win.webContents.on('render-process-gone', (_e, d) => { if (!d || d.reason !== 'clean-exit') again('stopped (' + ((d && d.reason) || 'unknown') + ')'); });
    win.on('unresponsive', () => { clearTimeout(hung); hung = setTimeout(() => { hung = null; try { win.webContents.forcefullyCrashRenderer(); } catch (_) { again('froze'); } }, 20000); });
    win.on('responsive', () => { clearTimeout(hung); hung = null; });
  }

  app.on('second-instance', () => bringBack());
  app.on('window-all-closed', () => app.quit());

  app.whenReady().then(() => {
    try { fs.mkdirSync(SHARED, { recursive: true }); } catch (err) { logError('shared folder', err); }
    load();

    // The sign-in: with the launcher's key it is one and the same for both (Windows).
    const storeOpts = { ownSlot: 'authTv', other: null };
    try { storeOpts.other = require('../sharedkey').open(SHARED); } catch (err) { logError('shared sign-in', err); }

    // ---------- what the screens ask for
    handle('lib:load', () => lib);
    handle('lib:save', (data) => {
      const next = pickOwn(data && data.settings);
      for (const k of CORE) { if (lib.settings[k] !== undefined) next[k] = lib.settings[k]; else delete next[k]; }
      Object.assign(lib.settings, next);
      persist();
      return true;
    });
    handle('app:info', () => ({
      platform: process.platform, version: VERSION, tvApp: true, windowed: true, updateFailed: global.couchUpdateFailed || null,
      hotkey: false, guideButton: false, guideError: null, autostart: null, emulators: {}, canEmbed: !!embedApi,
      sharedWithLauncher: fs.existsSync(path.join(SHARED, 'library.json')), sharedSignIn: !!storeOpts.other
    }));
    handle('app:started', () => { markHealthy(); return true; });
    let screenErrors = 0;
    handle('log:error', (what) => { if (screenErrors++ < 40) logError('screen', String(what || '').slice(0, 1500)); return true; });
    handle('pads:get', () => []);
    handle('tvapp:fullscreen', (on) => {
      if (!win || win.isDestroyed()) return false;
      win.setFullScreen(on == null ? !win.isFullScreen() : !!on);
      return win.isFullScreen();
    });
    registerFsBrowse(handle, { app, dialog, win: () => win });
    // A key pressed while something plays inside the window (the keyboard stays with Couch TV).
    handle('tv:key', (name, repeat, heldMs) => {
      if (!tvPart || !tvPart.playing || !win || win.isDestroyed()) return false;
      name = String(name || '');
      if (name === 'FULL') { if (!repeat) win.setFullScreen(!win.isFullScreen()); }
      else if (name === 'ESC') { if (!repeat) { if (win.isFullScreen()) win.setFullScreen(false); else tvPart.key('B', false, 0); } }
      else tvPart.key(name, !!repeat, Number(heldMs) || 0);
      return true;
    });

    // ---------- Movies & TV (the launcher's own part, keeping its files in the launcher's folder)
    tvPart = require('../tvmain').setupTv({
      app, safeStorage, shell, clipboard, BrowserWindow, handle, send,
      settings: () => lib.settings, saveSettings: () => persist(),
      targetDisplay, toPx, presentApp, bringBack,
      dataDir: SHARED, storeOpts, embed
    });

    // The controller, while a video is playing (the player's own controls). The rest of the
    // time the window reads it itself, like any page.
    let controller = null, watching = false;
    setInterval(() => {
      const playing = !!(tvPart && tvPart.playing);
      if (playing === watching) return;
      watching = playing;
      try {
        if (playing && !controller) {
          controller = require('../hotkey').createControllerWatcher({
            onGuide() {}, onCombo() {}, onPress() {}, onBack() {}, usePs: () => true,
            // (Inside the window: only while Couch TV is the program in use, so a controller
            // used for something else doesn't also work what is playing here.)
            onButtons: (mask, lx, ly) => { if (tvPart && tvPart.playing && (!tvPart.inWindow || (win && !win.isDestroyed() && win.isFocused()))) tvPart.input(mask, lx, ly); }
          });
        }
        if (controller) { if (playing) controller.start(); else controller.stop(); }
      } catch (err) { logError('controller', err); }
    }, 500);
    // While something plays inside the window: its picture fills the window, and the keyboard
    // stays with Couch TV (the player's picture must never end up holding it).
    setInterval(() => {
      if (!embedApi || !tvPart || !tvPart.inWindow || !win || win.isDestroyed()) return;
      fitPlayer();
      try { if (win.isFocused() && embedApi.focusPid() !== process.pid) win.webContents.focus(); } catch (_) { /* next time */ }
    }, 700);

    // ---------- updates (the launcher's own update files: one version for both)
    const UPDATE_REPO = 'c-launch/couch-launcher';
    const updDir = () => path.join(app.getPath('userData'), 'downloads');
    let updater = null;
    const upd = () => updater || (updater = require('../updater').createUpdater({
      userData: app.getPath('userData'), folders: [updDir(), app.getPath('downloads')], currentVersion: VERSION,
      newer: global.couchNewer || ((a, b) => String(a) !== String(b) && String(a).localeCompare(String(b), undefined, { numeric: true }) > 0),
      needs: [path.join('src', 'couchtv', 'main.js')]
    }));
    async function checkAll(online) {
      let netErr = null;
      if (online) { try { await upd().download(UPDATE_REPO, updDir()); } catch (e) { netErr = e; } }
      const r = await upd().check();
      if (r.status !== 'ready' && netErr) r.offline = String(netErr.message || netErr);
      return r;
    }
    handle('update:check', () => checkAll(true));
    handle('update:install', () => {
      const v = upd().install();
      setTimeout(() => { app.relaunch(); app.exit(0); }, 300);
      return v;
    });
    // Looked for a few seconds after starting, then every 3 hours (never while something plays).
    let offered = null;
    const autoCheck = async () => {
      if (process.env.COUCH_TV_SELFTEST || (tvPart && tvPart.playing)) return;
      try {
        const r = await checkAll(true);
        if (r.status === 'ready' && !(tvPart && tvPart.playing) && offered !== r.version) { offered = r.version; send('update:found', r); }
      } catch (_) { /* checked again later or from Settings */ }
    };
    setTimeout(autoCheck, 5000);
    setInterval(autoCheck, 3 * 60 * 60 * 1000);

    createWindow();
    if (process.env.COUCH_TV_SELFTEST) require('./selftest').run({ app, win: () => win, logError, storeOpts, SHARED, safeStorage, embedApi, hwnd, tvPart });
  });

  app.on('before-quit', () => { try { if (tvPart) tvPart.quit(); } catch (_) { /* closing anyway */ } });
}
