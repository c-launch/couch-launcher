'use strict';
const { app, BrowserWindow, ipcMain, shell, globalShortcut, Menu, safeStorage, dialog, screen, Notification, clipboard, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const scanners = require('./scanners');
const library = require('./library');
const { createControllerWatcher, loadXInput, readPads } = require('./hotkey');
const { createPadMouse } = require('./padmouse');
const { createXbox } = require('./xbox');
const { createUpdater } = require('./updater');
const { createDiscordRpc } = require('./discordrpc');
const players = require('./players');
const { createDisplay } = require('./display');
const { createNews } = require('./news');
const clipsMod = require('./clips');
const { createSteam } = require('./steam');
const { createMedia } = require('./media');
const { createPauser } = require('./pause');
const { createWin32 } = require('./win32');
const { createArtFinder } = require('./artfinder');

const VERSION = global.couchVersion || require('../package.json').version;
const newerThan = global.couchNewer || ((a, b) => String(a) > String(b));

const WINDOWED = process.argv.includes('--windowed');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  let lib = null;
  const libFile = () => path.join(app.getPath('userData'), 'library.json');
  const artDir = () => path.join(app.getPath('userData'), 'art');

  // What is running right now (only one game at a time).
  // { gameId, child, pids, dir, startedAt, pending, seen, miss, watchTimer }
  let running = null;
  let tvPart = null; // Movies & TV (set up below, with the other features)
  let yt = null;     // YouTube (its TV interface in its own window)

  // Xbox button opens the guide; View + Menu held during a game brings the launcher back.
  const controller = createControllerWatcher({
    onPress: (slot) => send('pad:a', slot),
    onGuide: () => guidePressed(),
    onCombo: () => guidePressed(),
    usePs: () => !(lib && lib.settings && lib.settings.psPads === false),
    // While a movie or episode plays, the controller drives the player.
    // Share button -> Medal (tap: screenshot, hold: clip). Not inside the launcher itself.
    onCapture: (st) => {
      if (!capture || !lib || lib.settings.medalShare === false) return;
      if (win && !win.isDestroyed() && win.isFocused()) return;
      if (overlayShown()) return;
      capture.input(st);
    },
    onButtons: (mask, lx, ly) => {
      if (tvPart && tvPart.playing) tvPart.input(mask, lx, ly);
      else if (yt && yt.isFront()) yt.input(mask, lx, ly);
    },
    // B on the boot screen while Steam/Epic has focus (the launcher can't hear it then).
    onBack: () => {
      const r = running;
      if (r && r.boot && win && !win.isDestroyed() && !win.isFocused()) { cancelLaunch(); send('launch:cancelled', { gameId: r.gameId }); }
    }
  });

  // Medal: the launcher presses Medal's own hotkeys (Settings › Controllers › Clips with Medal).
  let shotHintAt = 0;
  const capture = require('./capture').createCapture({
    mode: () => (lib && lib.settings.medalXbox) || 'auto',
    fire: (kind) => {
      if (!w32 || !lib) return;
      const key = kind === 'clip' ? (lib.settings.medalClipKey || 'F8') : lib.settings.medalShotKey;
      const k = require('./capture').parseKey(key);
      if (!k) {
        if (Date.now() - shotHintAt > 30000) { shotHintAt = Date.now(); notify('Screenshot key not set', 'Hold Share for a clip. For screenshots, set Medal’s screenshot key in Settings › Controllers.'); }
        return;
      }
      w32.keys(k.mods, k.vk).catch(() => {});
    }
  });
  const pauser = createPauser();
  // Controller as a mouse in Apple Music / Spotify (setting, on by default).
  const padMouse = createPadMouse(loadXInput, () => !(lib && lib.settings && lib.settings.musicMouse === false));
  const w32 = createWin32();

  // Pause the game whenever the guide or the launcher is in front of it (setting, on by default).
  const wantPause = () => {
    const r = running;
    if (!r || !r.started || r.closing || !pauser.available) return false;
    if (lib && lib.settings && lib.settings.pauseGame === false) return false;
    return overlayShown() || !!(win && !win.isDestroyed() && win.isFocused());
  };
  function updatePause() {
    if (wantPause()) pauser.pause(running.child ? [running.child.pid] : (running.pids || []), wantPause);
    else pauser.resumeAfterPending();
  }

  function send(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
  const canClose = () => !!(running && (running.child || (running.pids && running.pids.length)));

  // ---------- Guide over the game ----------
  // A see-through window that floats above the game, so the guide opens without leaving it.
  // (Games in exclusive full screen can't be drawn over; most games use borderless full screen.)
  let overlay = null;
  function createOverlay() {
    const b = targetDisplay().bounds;
    overlay = new BrowserWindow({
      x: b.x, y: b.y, width: b.width, height: b.height,
      transparent: true, frame: false, show: false, skipTaskbar: true, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false, hasShadow: false, backgroundColor: '#00000000',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
    });
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { overlay: '1' } });
    overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    overlay.webContents.on('will-navigate', (e) => e.preventDefault());
    overlay.on('closed', () => { overlay = null; });
  }
  const overlayShown = () => !!(overlay && !overlay.isDestroyed() && overlay.isVisible());
  function showOverlay() {
    if (!overlay || overlay.isDestroyed()) createOverlay();
    // Remember the window that had the screen (the game's own), to give it focus back after.
    if (w32 && running) {
      try {
        const fg = w32.foreground();
        if (fg && fg.pid !== process.pid && !(overlay && !overlay.isDestroyed() && fg.hwnd === w32.hwndOf(overlay))) running.backTo = fg.hwnd;
      } catch (_) { /* fine */ }
    }
    overlay.setBounds(targetDisplay().bounds);
    overlay.webContents.send('overlay:open', { gameId: running ? running.gameId : null, canClose: canClose() });
    overlay.show();
    overlay.setAlwaysOnTop(true, 'screen-saver');
    if (w32) w32.forceForeground(w32.hwndOf(overlay));
    overlay.focus();
    setTimeout(updatePause, 150); // after the game has seen it lost focus
  }
  // Hiding it hands focus back to the game underneath.
  // refocus: back to the game (B / Resume / Xbox button). Not when something else opens next.
  function hideOverlay(refocus) {
    if (!overlayShown()) return;
    overlay.webContents.send('overlay:closed');
    const r = running;
    // Unpause first, so the game is awake when it gets focus back.
    pauser.resumeAfterPending().then(() => {
      if (overlay && !overlay.isDestroyed()) overlay.hide();
      if (refocus && r && running === r) focusGame(r);
      setTimeout(updatePause, 100);
    });
  }
  // Gives the game its focus back. Some games (Roblox) don't take it back when the guide hides.
  function focusGame(r) {
    if (!w32) return;
    let h = [r.backTo, r.gameHwnd].find((x) => x && w32.exists(x));
    if (!h && (r.pids || []).length) { try { h = w32.windowOfPids(r.pids); } catch (_) { h = null; } }
    if (!h && r.child) { try { h = w32.windowOfPids([r.child.pid]); } catch (_) { h = null; } }
    if (!h) return;
    r.gameHwnd = h;
    w32.forceForeground(h);
    // Ask once more a moment later, in case the game was still waking up.
    setTimeout(() => { try { const fg = w32.foreground(); if (running === r && w32.exists(h) && (!fg || fg.hwnd !== h)) w32.forceForeground(h); } catch (_) { /* fine */ } }, 250);
  }
  // Xbox button / View + Menu / Ctrl+Alt+Home.
  function guidePressed() {
    if (!win || win.isDestroyed()) return;
    // Watching something: stop there (your spot is saved) and come back with the guide open.
    if (tvPart && tvPart.playing) { tvPart.stop('guide'); setTimeout(() => send('guide'), 450); return; }
    // In YouTube: it pauses and steps aside; opening it again carries on where you were.
    if (yt && yt.isFront()) { yt.hide(); bringBack(false); return; }
    if (overlayShown()) { hideOverlay(true); return; }
    const gameHasScreen = running && (win.isMinimized() || !win.isFocused());
    if (gameHasScreen) {
      // Exclusive full screen: nothing can float over the game, so step it aside and open the
      // guide on the launcher's own screen instead (Resume brings the game back).
      if (running.exclusive || (w32 && w32.exclusiveFullScreen())) { guideInLauncher(running); return; }
      showOverlay();
      checkOverlayKept(running);
      return;
    }
    if (!win.isFocused()) {
      // Coming back from a store the launcher opened: close it (Settings › Controllers).
      if (!running && openedApps.size && lib.settings.autoCloseApps !== false) closeOpenedApps();
      bringBack(false); // on the desktop or in another app: come to the front
    }
    send('guide');
  }

  function guideInLauncher(r) {
    r.exclusive = true;
    if (overlayShown()) { overlay.webContents.send('overlay:closed'); overlay.hide(); }
    if (w32) {
      try {
        const fg = w32.foreground();
        if (fg && fg.pid !== process.pid) r.backTo = fg.hwnd;
        const h = [r.backTo, r.gameHwnd].find((x) => x && w32.exists(x));
        if (h) { r.gameHwnd = h; w32.minimize(h); }
      } catch (_) { /* fine */ }
    }
    setTimeout(() => { if (running === r) bringBack(true); }, 150);
  }
  // Some games in exclusive full screen take the screen right back, so the guide flickers and
  // goes away. If that happens, use the launcher's own screen for this game from now on.
  function checkOverlayKept(r) {
    setTimeout(() => {
      if (running !== r || !overlayShown() || !overlay || overlay.isDestroyed()) return;
      let fg = null;
      try { fg = w32 && w32.foreground(); } catch (_) { fg = null; }
      const lost = !overlay.isFocused() && fg && fg.pid !== process.pid;
      if (lost) guideInLauncher(r);
    }, 700);
  }

  // Stores opened from the launcher, closed when you press the Xbox button to come back.
  // Music apps and Discord are left alone (music and calls keep going); so are emulator
  // setup windows (unsaved settings).
  const openedApps = new Map(); // kind -> { exes, title }
  function closeOpenedApps() {
    if (!w32) { openedApps.clear(); return; }
    for (const [kind, a] of openedApps) {
      if (a.stop) a.stop(); // stop putting its windows in front
      if (kind === 'steam-bp') {
        // Steam's own "leave Big Picture" link; if Big Picture is still up after a moment,
        // close its window (like Alt+F4), which drops Steam back to its normal window.
        shell.openExternal('steam://close/bigpicture').catch(() => {});
        setTimeout(() => {
          let h = null;
          try { h = w32.findAppWindow(['steam.exe'], 'Steam Big Picture', true); } catch (_) { h = null; }
          if (h) w32.close(h);
        }, 1500);
        // Steam's normal window pops up after Big Picture closes: stay in front of it.
        for (const ms of [2500, 4500]) setTimeout(() => { if (!running) bringBack(false); }, ms);
      } else {
        let h = null;
        try { h = w32.findAppWindow(a.exes, a.title); } catch (_) { h = null; }
        if (h) w32.close(h);
      }
    }
    openedApps.clear();
  }

  function bringBack(showGuide) {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    // Windows blocks background programs from taking focus; take it the way overlay tools do.
    win.setAlwaysOnTop(true);
    if (w32) w32.forceForeground(w32.hwndOf(win));
    win.focus();
    setTimeout(() => { if (win && !win.isDestroyed()) win.setAlwaysOnTop(false); }, 300);
    if (showGuide && running) send('overlay', { gameId: running.gameId, canClose: canClose() });
  }

  // The monitor chosen in Settings › Display (or the main one).
  function targetDisplay() {
    const all = screen.getAllDisplays();
    const id = lib && lib.settings && lib.settings.displayId;
    return all.find((d) => String(d.id) === String(id)) || screen.getPrimaryDisplay();
  }
  // Apps the launcher opens (music, Discord, stores, emulator setup) fill the chosen display.
  const toPx = (rect) => (process.platform === 'win32' && screen.dipToScreenRect ? screen.dipToScreenRect(null, rect) : rect);
  const toDip = (rect) => (process.platform === 'win32' && screen.screenToDipRect ? screen.screenToDipRect(null, rect) : rect);
  // Is this window on the chosen display (its middle)?
  function onChosenDisplay(h) {
    const r = w32.rect(h);
    if (!r || w32.isIconic(h)) return false;
    const b = toPx(targetDisplay().bounds), cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    return cx >= b.x && cx < b.x + b.width && cy >= b.y && cy < b.y + b.height;
  }
  // Normal windows are maximized on the chosen display. Borderless full-screen windows (Steam
  // Big Picture, some launchers) are given the display's exact size and spot instead.
  function fillChosenDisplay(h, focus) {
    if (!w32 || !h) return;
    try {
      const d = targetDisplay();
      const cur = w32.rect(h);
      let fullScreen = false;
      if (cur && !w32.isIconic(h) && !w32.isZoomed(h)) {
        const on = toPx(screen.getDisplayMatching(toDip(cur)).bounds);
        fullScreen = cur.width >= on.width * 0.95 && cur.height >= on.height * 0.95;
      }
      if (fullScreen) {
        const b = toPx(d.bounds);
        w32.move(h, b.x, b.y, b.width, b.height);
        if (focus !== false) w32.forceForeground(h);
      } else {
        w32.fill(h, toPx(d.workArea), focus);
      }
    } catch (_) { /* window went away */ }
  }
  // Watches for an app's window for a while (splash screens come first) and places each new one.
  function presentApp(exes, titlePrefix, ms) {
    let stopped = false;
    if (!w32) return () => {};
    const done = new Map(); // window -> times placed
    const until = Date.now() + (ms || 20000);
    const tick = () => {
      if (stopped) return;
      let h = null;
      try { h = w32.findAppWindow(exes, titlePrefix); } catch (_) { h = null; }
      if (h && !done.has(h)) { done.set(h, 1); fillChosenDisplay(h); }
      // Apps that move themselves back to "their" screen while loading (Steam Big Picture)
      // get put back, a few times at most.
      else if (h && done.get(h) < 6 && !onChosenDisplay(h)) { done.set(h, done.get(h) + 1); fillChosenDisplay(h, false); }
      if (Date.now() < until) setTimeout(tick, 700);
    };
    tick();
    return () => { stopped = true; };
  }
  function placeWindows() {
    const d = targetDisplay();
    if (win && !win.isDestroyed()) {
      const wasFull = win.isFullScreen();
      if (wasFull) win.setFullScreen(false);
      if (WINDOWED) win.setBounds({ x: d.workArea.x + 60, y: d.workArea.y + 60, width: Math.min(1600, d.workArea.width - 120), height: Math.min(900, d.workArea.height - 120) });
      else { win.setBounds(d.bounds); setTimeout(() => { if (win && !win.isDestroyed()) win.setFullScreen(true); }, wasFull ? 250 : 0); }
    }
    if (overlay && !overlay.isDestroyed()) overlay.setBounds(d.bounds);
  }

  function createWindow() {
    const d0 = targetDisplay().bounds;
    win = new BrowserWindow({
      icon: path.join(__dirname, 'renderer', 'logo.png'), // taskbar icon while running
      x: WINDOWED ? d0.x + 60 : d0.x,
      y: WINDOWED ? d0.y + 60 : d0.y,
      width: 1600,
      height: 900,
      fullscreen: !WINDOWED,
      frame: WINDOWED,
      backgroundColor: '#0A0D12',
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    });
    Menu.setApplicationMenu(null);
    win.once('ready-to-show', () => { win.show(); win.focus(); });
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

    // Once the game takes over the screen, get out of its way.
    win.on('blur', () => {
      setTimeout(updatePause, 50);
      const r = running;
      if (!r || !r.pending) return;
      if (r.boot) return; // store game: Steam/Epic's own launch box is taking focus; stay on top of it
      r.pending = false;
      setTimeout(() => { if (running === r && win && !win.isDestroyed() && !win.isFocused()) handOver(r); }, 250);
    });
    win.on('focus', () => {
      const r = running;
      // The game's window just closed and Windows handed the screen back: that's the game ending.
      if (r && r.gameHwnd && w32 && !w32.exists(r.gameHwnd)) {
        if (!r.child) pidsIn(r.dir).then((pids) => { if (running === r && pids && !pids.length) endGame(r); });
        return; // no guide for this
      }
      send('window:focus');
      setTimeout(updatePause, 150);
    });
    win.on('closed', () => { win = null; app.quit(); }); // the guide window alone never keeps the app running
    // Links inside the app never open new windows.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
  }

  function persist() {
    try { library.save(libFile(), lib); } catch (err) { console.error('Save failed:', err); }
  }

  async function scanSource(source) {
    const p = lib.platforms;
    if (source === 'msstore' || source === 'roblox') {
      const r = !p[source].enabled ? { found: false, games: [] } : source === 'msstore' ? await scanners.scanMsStore() : scanners.scanRoblox();
      // Keep the list if the check itself failed (e.g. PowerShell blocked), instead of wiping it.
      if (r.found || !p[source].enabled) library.mergeScan(lib, source, r.games);
      return { source, found: r.found, count: r.games.length };
    }
    if (source === 'steam') {
      const r = p.steam.enabled ? scanners.scanSteam() : { found: false, games: [] };
      // EmuDeck also adds ROMs to Steam. When the same game was found directly through its
      // emulator (same ROM file or same name), keep only that one.
      r.games = scanners.dropEmuDuplicates(r.games, lib.games.filter((g) => g.launch && g.launch.type === 'emu'));
      library.mergeScan(lib, 'steam', r.games);
      return { source, found: r.found, count: r.games.length };
    }
    if (source === 'epic') {
      const r = p.epic.enabled ? scanners.scanEpic() : { found: false, games: [] };
      library.mergeScan(lib, 'epic', r.games);
      return { source, found: r.found, count: r.games.length };
    }
    if (scanners.EMULATORS[source]) {
      const cfg = p[source];
      const on = cfg.enabled !== false;
      const ok = on && !!(cfg.exe && fs.existsSync(cfg.exe));
      const games = ok ? scanners.scanEmulator(source, cfg) : [];
      // Only drop games when the emulator is set up; a missing drive shouldn't wipe your list.
      const noFolder = source === 'rpcs3' || require('./emuscan').needsNoFolder(source);
      if (!on) library.mergeScan(lib, source, []); // turned off: its games leave the library
      else if (ok && (noFolder || scanners.dirsOf(cfg.dir).some((d) => fs.existsSync(d)))) library.mergeScan(lib, source, games);
      return { source, found: ok, count: games.length };
    }
    return { source, found: false, count: 0 };
  }

  function splitArgs(str) {
    const out = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m;
    while ((m = re.exec(String(str || '')))) out.push(m[1] !== undefined ? m[1] : m[2]);
    return out;
  }

  // Boot screen stays above everything (including Steam/Epic's "Launching…" box) until the game runs.
  function holdBoot(r) {
    r.boot = true;
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver');
    // Never hold forever: if the game hasn't shown up, step aside so Steam/Epic can show what they need.
    r.bootTimer = setTimeout(() => { if (running === r && r.boot) handOver(r); }, 30000);
  }
  // Steps aside so the game has the screen. With the game's window known, the launcher tucks
  // itself directly underneath it (no minimize, so no glimpse of the desktop going in or out).
  function handOver(r, fg) {
    if (r.bootTimer) clearTimeout(r.bootTimer);
    r.boot = false;
    r.pending = false;
    if (!win || win.isDestroyed() || running !== r) return;
    win.setAlwaysOnTop(false);
    const game = fg || gameWindow(r);
    if (game && w32) {
      r.gameHwnd = game.hwnd;
      if (game.pid) r.gamePid = game.pid;
      moveGameToChosenMonitor(r);
      w32.placeBelow(w32.hwndOf(win), game.hwnd);
      w32.focus(game.hwnd);
    } else {
      win.minimize();
    }
    r.started = true;
    send('game:started', { gameId: r.gameId });
  }
  // Games open on Windows' main monitor; if a different one is chosen in Settings › Display,
  // move the game's window there (works for windowed and borderless full-screen games).
  function moveGameToChosenMonitor(r) {
    if (!w32 || !r.gameHwnd || !lib.settings.displayId) return;
    const d = targetDisplay();
    if (d.id === screen.getPrimaryDisplay().id) return;
    const px = process.platform === 'win32' && screen.dipToScreenRect ? screen.dipToScreenRect(null, d.bounds) : d.bounds;
    const place = () => {
      if (running !== r || !w32.exists(r.gameHwnd)) return;
      const cur = w32.rect(r.gameHwnd);
      const inside = cur && cur.x >= px.x - 8 && cur.y >= px.y - 8 && cur.x + cur.width <= px.x + px.width + 8 && cur.y + cur.height <= px.y + px.height + 8;
      if (inside) return;
      // A game filling its monitor (borderless full screen) fills the chosen one too;
      // a smaller window keeps its size, centered.
      const prim = screen.dipToScreenRect ? screen.dipToScreenRect(null, screen.getPrimaryDisplay().bounds) : screen.getPrimaryDisplay().bounds;
      const fill = !cur || (cur.width >= prim.width * 0.95 && cur.height >= prim.height * 0.95) || cur.width > px.width || cur.height > px.height;
      if (fill) w32.move(r.gameHwnd, px.x, px.y, px.width, px.height);
      else w32.move(r.gameHwnd, px.x + Math.round((px.width - cur.width) / 2), px.y + Math.round((px.height - cur.height) / 2), cur.width, cur.height);
    };
    place();
    // Some games reposition themselves while they finish starting: check again.
    setTimeout(place, 1500);
    setTimeout(place, 5000);
  }

  // The window that has the screen now, if it isn't ours (and, for store games, belongs to the game).
  function gameWindow(r) {
    if (!w32) return null;
    const fg = w32.foreground();
    if (!fg || fg.pid === process.pid) return null;
    if (overlay && !overlay.isDestroyed() && fg.hwnd === w32.hwndOf(overlay)) return null;
    if (!r.child && r.dir && !(r.pids || []).includes(fg.pid)) return null;
    return fg;
  }
  function releaseBoot(r) {
    if (!r) return;
    if (r.bootTimer) clearTimeout(r.bootTimer);
    if (r.boot && win && !win.isDestroyed()) win.setAlwaysOnTop(false);
    r.boot = false;
  }

  // Ends tracking of the current game, counts play time and returns to the launcher.
  function endGame(r, extra) {
    if (!r || running !== r) return;
    restoreDisplay(r);
    if (r.cancelled) {
      if (r.watchTimer) clearInterval(r.watchTimer);
      running = null; controller.setGameRunning(false); pauser.resumeAll();
      send('game:exited', { gameId: r.gameId, seconds: 0, cancelled: true });
      return;
    }
    if (r.watchTimer) clearInterval(r.watchTimer);
    releaseBoot(r);
    if (r.fgWatch) clearInterval(r.fgWatch);
    running = null;
    pauser.resumeAll();
    hideOverlay();
    controller.setGameRunning(false);
    const seconds = extra && extra.error ? 0 : Math.round((Date.now() - r.startedAt) / 1000);
    const g = lib.games.find((x) => x.id === r.gameId);
    if (g && seconds) { g.playtime = (g.playtime || 0) + seconds; persist(); }
    if (r.emu && g && g.launch && rsm().supported(r.emu) && lib.settings.saveStates !== false) { try { rsm().recordAfter(r.emu, (lib.platforms[r.emu] || {}).exe, r.gameId, g.launch, r.startedAt); } catch (_) { /* fine */ } }
    if (r.emu && typeof afterGameBackup === 'function') afterGameBackup(r.emu);
    bringBack(false);
    send('game:exited', Object.assign({ gameId: r.gameId, seconds }, extra || {}));
  }

  function startProcess(exe, args, cwd, gameId) {
    if (!exe || !fs.existsSync(exe)) throw new Error('Program not found: ' + (exe || '(not set)'));
    const child = spawn(exe, args, { cwd, detached: false, windowsHide: false, stdio: 'ignore' });
    const r = { gameId, child, pids: [], startedAt: Date.now(), pending: true };
    running = r;
    child.on('error', (err) => endGame(r, { error: String(err.message || err) }));
    child.on('exit', () => endGame(r));
  }

  // Store games (Steam/Epic) start through their launcher, so find the game's own processes
  // by looking for programs running from the game's install folder.
  function pidsIn(dir) {
    return new Promise((resolve) => {
      if (process.platform !== 'win32' || !dir) return resolve(null);
      const d = dir.endsWith('\\') ? dir : dir + '\\';
      // Crash reporters (Roblox, Unity, Unreal...) keep running after a game closes: ignore them.
      const ps = "$d='" + d.replace(/'/g, "''") + "'; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($d, [StringComparison]::OrdinalIgnoreCase) -and $_.Name -notmatch 'crash|bugreport|errorreport|crashpad|werfault' } | ForEach-Object { $_.ProcessId }";
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
        { windowsHide: true, timeout: 15000 },
        (err, out) => resolve(err ? null : String(out).split(/\s+/).map(Number).filter((n) => n > 0)));
    });
  }
  function watchStoreGame(r) {
    let busy = false;
    r.watchTimer = setInterval(async () => {
      if (running !== r) { clearInterval(r.watchTimer); return; }
      if (busy) return;
      busy = true;
      const pids = await pidsIn(r.dir);
      busy = false;
      if (running !== r || pids === null) return; // couldn't check this time; try again
      if (pids.length) {
        r.pids = pids; r.seen = true; r.miss = 0;
        if (r.cancelled) { if (Date.now() < (r.killUntil || 0)) killAll(pids, true); return; }
        if (r.boot && !r.fgWatch) {
          // Wait for the game's own window to take the screen (Steam's launch box doesn't count).
          r.fgWatch = setInterval(() => {
            if (running !== r || !r.boot) { clearInterval(r.fgWatch); return; }
            const g = gameWindow(r);
            if (g) { clearInterval(r.fgWatch); handOver(r, g); }
          }, 300);
        }
      }
      else if (r.seen) { r.pids = []; if (++r.miss >= 2) endGame(r); } // closed
      else if (r.cancelled && Date.now() > (r.killUntil || 0)) { clearInterval(r.watchTimer); if (running === r) { running = null; controller.setGameRunning(false); } }
      else if (Date.now() - r.startedAt > 180000) clearInterval(r.watchTimer); // never showed up: stop looking
    }, r.seen ? 1500 : 3000);
  }

  // Cancel on the boot screen: the game hasn't really started, so close whatever did start.
  // A store game that Steam/Epic starts a moment later is closed as soon as it appears.
  function cancelLaunch() {
    const r = running;
    if (!r) return;
    r.cancelled = true;
    releaseBoot(r);
    if (r.fgWatch) clearInterval(r.fgWatch);
    if (r.child) { killAll([r.child.pid], true); return; }
    if (r.pids && r.pids.length) killAll(r.pids, true);
    if (r.dir && r.watchTimer) { r.killUntil = Date.now() + 60000; return; } // keep watching briefly
    if (r.watchTimer) clearInterval(r.watchTimer);
    running = null;
    controller.setGameRunning(false);
  }

  // Asks the game to close the normal way (like clicking X), so it can save or ask first.
  // force = true ends it immediately.
  function closeRunning(force) {
    if (!running) return false;
    const pids = running.child ? [running.child.pid] : (running.pids || []);
    if (!pids.length) return false;
    const r = running;
    r.closing = true; // a paused game can't answer "close", so wake it first
    pauser.resumeAfterPending().then(async () => {
      // Dolphin: save a state first, so you can pick up right there next time.
      if (!force && r.emu === 'dolphin' && lib.settings.saveStates !== false) { try { await saveDolphinState(r); } catch (_) { /* closes anyway */ } }
      if (running !== r) return;
      killAll(pids, force);
      // Emulators answer "close" with their own "are you sure?" box, hidden behind the launcher.
      // Game progress lives in the game's saves, so finish the job if the emulator is still open.
      if (!force) setTimeout(() => { if (running === r) r.closing = false; }, 8000); // it said no to closing
      if (!force && (r.isEmu || r.forceClose)) setTimeout(() => { if (running === r) killAll(running.child ? [running.child.pid] : (running.pids || pids), true); }, 4000);
    });
    return true;
  }
  function killAll(pids, force) {
    for (const pid of pids) {
      if (!pid) continue;
      if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T'].concat(force ? ['/F'] : []), { windowsHide: true }, () => {});
      else try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); } catch (_) { /* gone */ }
    }
  }

  function launchGame(gameId, opts) {
    opts = opts || {};
    const g = lib.games.find((x) => x.id === gameId);
    if (!g) throw new Error('Game not found');
    if (canClose()) throw new Error('Another game is still running');
    if (running) {
      restoreDisplay(running);
      if (running.watchTimer) clearInterval(running.watchTimer);
      if (running.fgWatch) clearInterval(running.fgWatch);
      if (running.bootTimer) clearTimeout(running.bootTimer);
      running = null;
    }
    g.lastPlayed = Date.now();
    persist();
    const L = g.launch || {};
    if (L.type === 'url') {
      running = { gameId, child: null, pids: [], dir: L.dir || null, startedAt: Date.now(), pending: true, seen: false, miss: 0 };
      if (running.dir) { watchStoreGame(running); holdBoot(running); }
      shell.openExternal(L.url);
    } else if (L.type === 'appx') {
      // Microsoft Store / Xbox app game: started the way the Start menu does it.
      if (!/^[\w.-]+_[a-z0-9]+![\w.-]+$/i.test(String(L.aumid || ''))) throw new Error('This Store game can’t be started');
      running = { gameId, child: null, pids: [], dir: L.dir || null, startedAt: Date.now(), pending: true, seen: false, miss: 0 };
      if (running.dir) { watchStoreGame(running); holdBoot(running); }
      execFile('explorer.exe', ['shell:AppsFolder\\' + L.aumid], { windowsHide: true }, () => {});
    } else if (L.type === 'emu') {
      const emu = scanners.EMULATORS[L.emu];
      const cfg = lib.platforms[L.emu] || {};
      if (!emu) throw new Error('Unknown emulator');
      if (!cfg.exe) throw new Error(emu.name + ' is not set up yet. Open Settings › Platforms › Emulators.');
      if (cfg.enabled === false) throw new Error(emu.name + ' is turned off in Settings › Platforms › Emulators');
      if (!fs.existsSync(L.file)) throw new Error('Game file not found: ' + L.file);
      const extra = splitArgs(g.args);
      // Dolphin: pick up where you left off (the save state made when you last closed it).
      const st = L.emu === 'dolphin' && opts.resume ? savedState(gameId) : null;
      // GameCube ports 2-4 are off by default in Dolphin: plug in one per player (this run only).
      const ports = [];
      if (L.emu === 'dolphin' && playerCount.dolphin) for (let p = 0; p < 4; p++) ports.push('-C', 'Dolphin.Core.SIDevice' + p + '=' + (p < playerCount.dolphin ? 6 : 0));
      // A game in several regions: the version you picked in its menu.
      const file = g.altFile && (L.alts || []).some((a) => a.file === g.altFile) && fs.existsSync(g.altFile) ? g.altFile : L.file;
      // RetroArch / DuckStation / PCSX2: their own save-on-exit, and resuming from it when asked.
      let rs = [];
      if (rsm().supported(L.emu) && lib.settings.saveStates !== false) { try { rsm().prepare(L.emu, cfg.exe); rs = rsm().args(L.emu, gameId, !!opts.resume); } catch (_) { rs = []; } }
      startProcess(cfg.exe, extra.concat(st ? ['-s', st] : [], ports, rs, emu.args(file, L, cfg)), path.dirname(cfg.exe), gameId);
      running.isEmu = true;
      running.emu = L.emu;
    } else if (L.type === 'exe') {
      startProcess(L.exe, splitArgs(g.args), path.dirname(L.exe || '.'), gameId);
    } else if (L.type === 'open') {
      // Shortcuts (.lnk / .url / .bat): Windows opens them; the launcher can't track when they close.
      if (!L.path || !fs.existsSync(L.path)) throw new Error('Shortcut not found: ' + (L.path || '(not set)'));
      const r = { gameId, child: null, pids: [], startedAt: Date.now(), pending: true };
      running = r;
      shell.openPath(L.path).then((err) => { if (err) endGame(r, { error: err }); });
    } else {
      throw new Error('This game has no launch target');
    }
    controller.setGameRunning(true);
    applyDisplay(running, g);
    if (g.source === 'roblox') running.forceClose = true; // Roblox ignores a normal close; nothing to save
    running.audioDirs = L.type === 'url' || L.type === 'appx' ? [L.dir] : L.type === 'emu' ? [path.dirname(lib.platforms[L.emu].exe)] : L.type === 'exe' ? [path.dirname(L.exe)] : [];
    scheduleGameVolume(running);
    return { ok: true, tracked: L.type === 'emu' || L.type === 'exe', watching: (L.type === 'url' || L.type === 'appx') && !!L.dir };
  }

  // ---------- Controllers: battery levels and a heads-up when one runs low ----------
  let pads = [], padsSig = '';
  const lowWarned = new Set();
  function startPadWatch() {
    const check = () => {
      let list = [];
      try { list = readPads(); } catch (_) { list = []; }
      const sig = JSON.stringify(list);
      if (sig !== padsSig) { padsSig = sig; pads = list; send('pads', pads); sendOverlay('pads', pads); }
      for (const p of list) {
        const low = p.power === 'battery' && p.level <= 1;
        if (low && !lowWarned.has(p.slot) && lib.settings.notifyBattery !== false) {
          lowWarned.add(p.slot);
          notify('Controller ' + (p.slot + 1) + ' battery is ' + (p.level === 0 ? 'almost empty' : 'low'), 'Charge it or swap the batteries soon.');
        }
        if (!low) lowWarned.delete(p.slot);
      }
      for (const s of [...lowWarned]) if (!list.some((p) => p.slot === s)) lowWarned.delete(s);
    };
    check();
    setInterval(check, 20000);
  }
  handle('pads:get', () => pads);
  handle('capture:status', () => ({ xboxShareReadable: controller.xboxShareReadable }));

  // ---------- "Who's playing?": controllers into Player 1-4 of the emulator ----------
  const emuOf = (gameId) => {
    const g = lib.games.find((x) => x.id === gameId);
    const L = g && g.launch;
    if (!L || L.type !== 'emu') throw new Error('Not an emulator game');
    const cfg = lib.platforms[L.emu] || {};
    return { emu: L.emu, exe: cfg.exe };
  };
  const playerCount = {}; // emulator -> players set up for this session
  handle('players:listen', (on) => { controller.setJoin(!!on); return true; });
  handle('players:set', (gameId, slots) => {
    const { emu, exe } = emuOf(gameId);
    const list = (Array.isArray(slots) ? slots : []).map(Number).filter((n) => n >= 0 && n <= 3);
    const connected = readPads().map((p) => p.slot);
    const n = players.setPlayers(emu, exe, list, connected.length ? connected : list);
    playerCount[emu] = n;
    return n;
  });
  // One controller: make sure it's Player 1 (only once you've used "Who's playing?" for that
  // emulator, so settings you never asked the launcher to touch stay as they are).
  handle('players:solo', (gameId) => {
    const { emu, exe } = emuOf(gameId);
    const connected = readPads().map((p) => p.slot);
    if (connected.length !== 1) return false;
    const f = emu === 'ryujinx' ? players.ryujinxConfigPath(exe) : emu === 'rpcs3' ? players.rpcs3InputFile(exe)
      : (players.dolphinUserDir(exe) ? path.join(players.dolphinUserDir(exe), 'Config', 'GCPadNew.ini') : null);
    if (!f || !fs.existsSync(f + '.couch-original')) return false;
    try { players.setPlayers(emu, exe, connected, connected); playerCount[emu] = 1; return true; } catch (_) { return false; }
  });

  // Windows notification (shows over games too) plus a toast in the launcher.
  function notify(title, body) {
    try { if (Notification.isSupported()) new Notification({ title, body, silent: false }).show(); } catch (_) { /* not available */ }
    send('notice', { title, body });
  }
  function sendOverlay(ch, payload) { if (overlay && !overlay.isDestroyed()) overlay.webContents.send(ch, payload); }

  // ---------- Dolphin save states: made when you close or switch, offered next time ----------
  // Save and resume for RetroArch, DuckStation and PCSX2 (Dolphin's is below).
  let resumer = null;
  const rsm = () => resumer || (resumer = require('./resume').createResume({ userDataDir: app.getPath('userData') }));
  const statesFile = () => path.join(app.getPath('userData'), 'states.json');
  const readStates = () => { try { return JSON.parse(fs.readFileSync(statesFile(), 'utf8')) || {}; } catch (_) { return {}; } };
  function savedState(gameId) { const s = readStates()[gameId]; return s && s.file && fs.existsSync(s.file) ? s.file : null; }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function saveDolphinState(r) {
    if (!w32 || !r.child) return;
    const user = players.dolphinUserDir((lib.platforms.dolphin || {}).exe);
    if (!user) return;
    const dir = path.join(user, 'StateSaves');
    let h = [r.gameHwnd, r.backTo].find((x) => x && w32.exists(x));
    if (!h) { try { h = w32.windowOfPids([r.child.pid]); } catch (_) { h = null; } }
    if (!h) return;
    const t0 = Date.now() - 500;
    w32.forceForeground(h);
    await wait(400);
    await w32.keys([0x10], 0x79); // Shift+F10: Dolphin's "Save State Slot 10" (slot 1 is yours)
    for (let i = 0; i < 16; i++) {
      await wait(250);
      let best = null;
      try {
        for (const n of fs.readdirSync(dir)) {
          if (!/\.s10$/i.test(n)) continue;
          const f = path.join(dir, n), m = fs.statSync(f).mtimeMs;
          if (m >= t0 && (!best || m > best.m)) best = { f, m };
        }
      } catch (_) { best = null; }
      if (best) {
        await wait(300); // let Dolphin finish writing it
        const all = readStates();
        all[r.gameId] = { file: best.f, at: Date.now() };
        try { fs.writeFileSync(statesFile(), JSON.stringify(all)); } catch (_) { /* not critical */ }
        return;
      }
    }
  }
  handle('states:get', (gameId) => {
    const s = readStates()[String(gameId)];
    if (s && s.file && fs.existsSync(s.file)) return { at: s.at };
    const r = rsm().has(String(gameId));
    return r ? { at: r.at } : null;
  });

  // ---------- Per-game TV / display settings ----------
  let disp = null;
  const dsp = () => (disp === null ? (disp = createDisplay() || false) : disp);
  function displayDevice() { return dsp() ? dsp().deviceAt(toPx(targetDisplay().bounds)) : null; }
  function applyDisplay(r, g) {
    const want = g && g.display;
    if (!want || !dsp() || !r) return;
    try {
      const dev = displayDevice();
      if (!dev) return;
      r.dispRestore = { name: dev.name };
      if (want.w || want.hz) { if (dsp().setMode(dev.name, want)) r.dispRestore.mode = true; }
      if (want.hdr === 'on' || want.hdr === 'off') {
        const h = dsp().hdr(dev.name);
        if (h && h.supported && h.enabled !== (want.hdr === 'on')) { dsp().setHdr(dev.name, want.hdr === 'on'); r.dispRestore.hdr = h.enabled; }
      }
    } catch (e) { send('notice', { title: String(e.message || e) }); }
  }
  function restoreDisplay(r) {
    const x = r && r.dispRestore;
    if (!x || !dsp()) return;
    r.dispRestore = null;
    try { if (x.mode) dsp().restoreMode(x.name); } catch (_) { /* fine */ }
    try { if (typeof x.hdr === 'boolean') dsp().setHdr(x.name, x.hdr); } catch (_) { /* fine */ }
    setTimeout(placeWindows, 800);
  }
  handle('display:modes', () => {
    const dev = displayDevice();
    if (!dev) return null;
    return { current: dsp().current(dev.name), modes: dsp().modes(dev.name), hdr: dsp().hdr(dev.name) };
  });
  app.on('will-quit', () => { if (running) restoreDisplay(running); });

  // ---------- Game / music balance (like Xbox's game-chat mixer) ----------
  // -100 = all game (music turned down) … 0 = both full … 100 = all music (game turned down).
  const balanceFile = () => path.join(app.getPath('userData'), 'audio.json');
  let audioBalance = 0;
  try { audioBalance = Math.max(-100, Math.min(100, Math.round(Number(JSON.parse(fs.readFileSync(balanceFile(), 'utf8')).balance) / 10) * 10)) || 0; } catch (_) { /* default */ }
  const levels = (b) => ({ game: 100 - Math.max(0, b), music: 100 + Math.min(0, b) });
  function gameAudioTarget(r) {
    const pids = (r.child ? [r.child.pid] : []).concat(r.pids || [], r.gamePid ? [r.gamePid] : []);
    return { pids, dirs: (r.audioDirs || []).filter(Boolean) };
  }
  function applyGameVolume(r) {
    if (process.platform !== 'win32' || !r || running !== r) return Promise.resolve(null);
    const t = gameAudioTarget(r);
    if (!t.pids.length && !t.dirs.length) return Promise.resolve(null);
    return md().gameVolume(levels(audioBalance).game, t.pids, t.dirs).catch(() => null);
  }
  // Windows remembers each game's volume, so set it every time a game starts (its sound
  // can take a while to appear, so try a few times).
  function scheduleGameVolume(r) {
    for (const ms of [4000, 12000, 30000, 60000]) setTimeout(() => { if (running === r) applyGameVolume(r); }, ms);
  }

  // ---------- IPC ----------
  // A function declaration (not a const), so features anywhere in this file can register
  // their handlers no matter where they sit: an ordering mistake here stopped 1.6.x starting.
  function handle(ch, fn) {
    return ipcMain.handle(ch, async (_e, ...args) => {
      try { return { ok: true, value: await fn(...args) }; } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
    });
  }

  handle('lib:load', () => lib);

  // ---------- Emulators page: find what's on this PC (EmuDeck folders first) ----------
  const allDrives = () => {
    const out = [];
    if (process.platform === 'win32') for (let c = 67; c <= 90; c++) { const d = String.fromCharCode(c) + ':\\'; try { if (fs.existsSync(d)) out.push(d); } catch (_) { /* skip */ } }
    return out;
  };
  function findEmulators() {
    const cat = require('./emucatalog');
    const drives = allDrives();
    const known = Object.values(lib.platforms).map((p) => p && p.exe).filter(Boolean);
    const exes = cat.detect(process.env, drives, known, { dolphin: ['dolphin.exe'], rpcs3: ['rpcs3.exe'], ryujinx: ['ryujinx.exe'] });
    const deck = scanners.detectEmuDeck(app.getPath('home'), process.env, drives);
    const out = {};
    for (const id of Object.keys(scanners.EMULATORS)) {
      const exe = (deck[id] && deck[id].exe) || exes[id] || null;
      const dirs = scanners.EMULATORS[id].catalog ? cat.romDirs(id, drives) : ((deck[id] && deck[id].dirs) || []);
      if (exe || dirs.length) out[id] = { exe, dirs };
    }
    return out;
  }
  // Sets up every emulator that's found and not set up yet; returns their names.
  function setupFound(onlyId) {
    const found = findEmulators();
    const done = [];
    for (const [id, f] of Object.entries(found)) {
      if (onlyId && id !== onlyId) continue;
      const cfg = lib.platforms[id] = lib.platforms[id] || { exe: '', dir: '' };
      if (!cfg.exe && f.exe) { cfg.exe = f.exe; done.push(scanners.EMULATORS[id].name); }
      if (!cfg.dir && f.dirs.length && cfg.exe) cfg.dir = f.dirs.join(';');
    }
    persist();
    return done;
  }
  handle('emu:find', () => findEmulators());
  // Emulator updates
  let emuUpd = null;
  const eu = () => emuUpd || (emuUpd = require('./emuupdate').createEmuUpdates({ tmpDir: path.join(app.getPath('userData'), 'downloads') }));
  handle('emu:checkUpdates', async () => {
    const out = {};
    const ids = Object.keys(scanners.EMULATORS).filter((id) => lib.platforms[id] && lib.platforms[id].exe);
    await Promise.all(ids.map(async (id) => { try { out[id] = await eu().check(id, lib.platforms[id]); } catch (e) { out[id] = { status: 'error', error: e.message }; } }));
    return out;
  });
  handle('emu:update', async (id) => {
    id = String(id || '');
    const cfg = lib.platforms[id];
    if (!cfg || !cfg.exe) throw new Error('Set up this emulator first');
    if (running && running.emu === id) throw new Error('Close the game first');
    const name = scanners.EMULATORS[id] ? scanners.EMULATORS[id].name : id;
    const r = await eu().update(id, cfg, (msg) => send('notice', { title: name + ': ' + msg }));
    cfg.updatedTag = r.tag; cfg.updatedAt = Date.now();
    persist();
    return { tag: r.tag, lib };
  });
  handle('emu:setupFound', async (onlyId) => {
    const done = setupFound(onlyId ? String(onlyId) : null);
    const results = [];
    for (const id of Object.keys(scanners.EMULATORS)) if ((!onlyId || id === onlyId) && lib.platforms[id] && lib.platforms[id].exe) results.push(await scanSource(id));
    persist();
    return { done, lib, results };
  });

  // ---------- Movies & TV (Stremio) ----------
  tvPart = require('./tvmain').setupTv({
    app, safeStorage, shell, clipboard, BrowserWindow, handle, send,
    settings: () => lib.settings, saveSettings: () => persist(),
    targetDisplay, toPx, presentApp, bringBack
  });
  yt = require('./youtube').createYouTube({ BrowserWindow, session, targetDisplay, bringBack, settings: () => lib.settings, saveSettings: () => persist() });
  handle('yt:open', () => yt.open());
  handle('yt:reset', () => yt.reset());

  let xbox = null;
  const xb = () => xbox || (xbox = createXbox(app.getPath('userData'), safeStorage));
  handle('xbox:status', () => xb().connected());
  handle('xbox:connect', (key) => xb().connect(key));
  handle('xbox:disconnect', () => { xb().disconnect(); return true; });
  handle('xbox:profile', () => xb().profile());
  handle('xbox:friends', () => xb().friends());
  handle('link:open', (url) => {
    // Only the Xbox key page can be opened from inside the app.
    if (!['https://xbl.io', 'https://steamcommunity.com/dev/apikey', 'https://www.steamgriddb.com/profile/preferences/api', 'https://discord.com/developers/applications'].includes(url)) throw new Error('Not allowed');
    hideOverlay();
    return shell.openExternal(url).then(() => { placeNextWindow(10000); return true; });
  });
  // Whatever window comes up next (e.g. the web browser for an account page) goes on the
  // chosen display too.
  function placeNextWindow(ms) {
    if (!w32) return;
    const until = Date.now() + ms;
    const tick = () => {
      let fg = null;
      try { fg = w32.foreground(); } catch (_) { fg = null; }
      const ours = fg && (fg.pid === process.pid || (overlay && !overlay.isDestroyed() && fg.hwnd === w32.hwndOf(overlay)));
      if (fg && !ours) { if (!onChosenDisplay(fg.hwnd)) fillChosenDisplay(fg.hwnd); return; }
      if (Date.now() < until) setTimeout(tick, 400);
    };
    setTimeout(tick, 300);
  }
  handle('lib:save', (data) => {
    const next = library.normalize(data);
    // Delete art files that no game uses any more.
    const used = new Set();
    for (const g of next.games) for (const k of Object.keys(g.art || {})) if (g.art[k]) used.add(path.resolve(g.art[k]));
    if (next.settings.avatar) used.add(path.resolve(next.settings.avatar));
    if (next.settings.customBg) used.add(path.resolve(next.settings.customBg));
    lib = next;
    persist();
    try {
      for (const f of fs.readdirSync(artDir())) {
        const full = path.resolve(path.join(artDir(), f));
        if (!used.has(full)) fs.unlinkSync(full);
      }
    } catch (_) { /* no art folder yet */ }
    return true;
  });
  handle('scan', async (source) => {
    // Emulators first, so the Steam scan can tell which EmuDeck shortcuts are duplicates.
    // First time after the Emulators update: set up every emulator on this PC (EmuDeck too).
    if (!source && !lib.settings.emuAutoDone) { lib.settings.emuAutoDone = true; try { setupFound(); } catch (_) { /* by hand in Settings */ } }
    const catalogOn = Object.keys(require('./emucatalog').CATALOG).filter((id) => lib.platforms[id] && lib.platforms[id].exe);
    const sources = source ? [source] : ['dolphin', 'rpcs3', 'ryujinx'].concat(catalogOn, ['steam', 'epic', 'msstore', 'roblox']);
    const results = [];
    for (const s of sources) results.push(await scanSource(s));
    persist();
    return { lib, results };
  });
  handle('launch', async (gameId, opts) => {
    // Emulator games: copy their saves first (only when backups are on and something changed).
    const g = lib.games.find((x) => x.id === gameId);
    if (g && g.launch && g.launch.type === 'emu' && !running) await Promise.race([backupNow(g.launch.emu, 'before'), wait(15000)]).catch(() => null);
    return launchGame(gameId, opts && typeof opts === 'object' ? { resume: !!opts.resume } : {});
  });
  handle('launch:cancel', () => { cancelLaunch(); return true; });
  let updater = null;
  // Updates come from GitHub (downloaded into the app's own folder); zips in Downloads or
  // G:\launcher still work too.
  const UPDATE_REPO = 'c-launch/couch-launcher';
  const updDir = () => path.join(app.getPath('userData'), 'downloads');
  const upd = () => updater || (updater = createUpdater({ userData: app.getPath('userData'), folders: [updDir(), app.getPath('downloads'), 'G:\\launcher'], currentVersion: VERSION, newer: newerThan }));
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
  handle('emu:detect', () => {
    const drives = [];
    if (process.platform === 'win32') for (let c = 67; c <= 90; c++) { const d = String.fromCharCode(c) + ':\\'; try { if (fs.existsSync(d)) drives.push(d); } catch (_) { /* skip */ } }
    return scanners.detectEmuDeck(app.getPath('home'), process.env, drives);
  });
  handle('emu:fromScript', (file) => {
    const exe = scanners.exeFromScript(String(file || ''), process.env);
    if (!exe) throw new Error('Couldn’t find the program that script starts. Pick the emulator’s .exe instead.');
    return exe;
  });
  handle('display:list', () => {
    const cur = targetDisplay();
    const prim = screen.getPrimaryDisplay();
    return screen.getAllDisplays().map((d, i) => ({
      id: String(d.id),
      name: d.label || ('Monitor ' + (i + 1)),
      size: Math.round(d.size.width * d.scaleFactor) + ' × ' + Math.round(d.size.height * d.scaleFactor),
      hz: d.displayFrequency ? Math.round(d.displayFrequency) : null,
      primary: d.id === prim.id,
      current: d.id === cur.id
    }));
  });
  handle('display:set', (id) => {
    lib.settings.displayId = id ? String(id) : null;
    persist();
    placeWindows();
    return true;
  });

  let steam = null;
  const st = () => steam || (steam = createSteam(app.getPath('userData'), safeStorage, scanners.steamRoot));
  handle('steam:status', () => st().connected());
  handle('steam:connect', (key, profile) => st().connect(key, profile));
  handle('steam:disconnect', () => { st().disconnect(); return true; });
  handle('steam:friends', () => st().friends());
  handle('steam:me', () => st().me());

  // ---------- Gaming news (Home) ----------
  let newsMod = null;
  const nw = () => newsMod || (newsMod = createNews(app.getPath('userData')));
  handle('news:get', (force) => nw().get(!!force));
  handle('news:open', async (link) => {
    link = String(link || '');
    if (!nw().has(link)) throw new Error('Not a news link');
    hideOverlay();
    await shell.openExternal(link);
    placeNextWindow(10000);
    return true;
  });
  function startNewsWatch() {
    const tick = async () => { try { send('news', await nw().get(false)); } catch (_) { /* offline: try later */ } };
    setTimeout(tick, 8000);
    setInterval(tick, 20 * 60 * 1000); // fetches only when the news is a couple of hours old
  }

  // ---------- Medal clips ----------
  function clipsFolder() {
    const folders = clipsMod.findMedalFolders(process.env, lib.settings.clipsFolder || null);
    if (lib.settings.clipsFolder && folders[0] === lib.settings.clipsFolder) return folders[0];
    return folders.find((f) => clipsMod.listClips(f, 1).length) || folders[0] || null;
  }
  handle('clips:list', () => {
    const folder = clipsFolder();
    return { folder, clips: folder ? clipsMod.listClips(folder, 400) : [] };
  });
  handle('clips:show', (file) => {
    const folder = clipsFolder();
    const f = path.resolve(String(file || ''));
    if (!folder || !f.toLowerCase().startsWith(path.resolve(folder).toLowerCase() + path.sep) || !fs.existsSync(f)) throw new Error('Clip not found');
    hideOverlay();
    shell.showItemInFolder(f);
    placeNextWindow(8000);
    return true;
  });

  // ---------- Steam downloads: progress on tiles, "ready to play" when done ----------
  let downloads = [], dlSig = '';
  function startDownloadWatch() {
    const check = () => {
      if (!lib.platforms.steam || lib.platforms.steam.enabled === false) return;
      let list = [];
      try { list = scanners.steamDownloads(); } catch (_) { list = []; }
      const sig = JSON.stringify(list);
      if (sig === dlSig) return;
      for (const d of downloads) if (!list.some((x) => x.appid === d.appid) && scanners.steamAppFlags(d.appid) === 4 && lib.settings.notifyDownloads !== false) notify(d.name + ' is ready to play', d.installing ? 'Finished installing.' : 'Update finished.');
      dlSig = sig; downloads = list;
      send('downloads', list);
    };
    check();
    setInterval(check, 15000);
  }
  handle('downloads:get', () => downloads);

  // ---------- Alerts: friends coming online, people joining / leaving your Discord call ----------
  function startAlerts() {
    const seen = { xbox: null, steam: null };
    const friendId = (f) => f.xuid || f.steamid || f.id || f.gamertag;
    async function friendsCheck() {
      const fresh = [];
      for (const [svc, mod] of [['xbox', xb], ['steam', st]]) {
        let list = null;
        try { if (mod().connected()) list = await mod().friends(); } catch (_) { list = null; }
        if (!list) continue;
        const online = new Set(list.filter((f) => f.online).map(friendId));
        // The first check only learns who's online; after that, newcomers get a heads-up.
        if (seen[svc]) for (const f of list) if (f.online && !seen[svc].has(friendId(f))) fresh.push(f);
        seen[svc] = online;
      }
      if (!fresh.length || lib.settings.notifyFriends === false) return;
      const names = fresh.map((f) => f.gamertag);
      const title = names.length === 1 ? names[0] + ' is online' : names.length === 2 ? names[0] + ' and ' + names[1] + ' are online' : names[0] + ' and ' + (names.length - 1) + ' others are online';
      notify(title, fresh.length === 1 && fresh[0].status && fresh[0].status !== 'Online' ? fresh[0].status : 'Say hi from the guide › Friends.');
    }
    let callId = null, callPeople = null;
    async function callCheck() {
      if (!dcRpc && !dr().configured()) return;
      let s;
      try { s = await dr().state([]); } catch (_) { callId = null; callPeople = null; return; }
      if (!s.call) { callId = null; callPeople = null; return; }
      const now = new Map(s.call.people.map((p) => [p.id, p.name]));
      if (callId === s.call.id && callPeople && lib.settings.notifyCalls !== false) {
        const me = s.me && s.me.id;
        for (const [id, name] of now) if (!callPeople.has(id) && id !== me) notify(name + ' joined ' + s.call.name, 'Discord');
        for (const [id, name] of callPeople) if (!now.has(id) && id !== me) notify(name + ' left ' + s.call.name, 'Discord');
      }
      callId = s.call.id; callPeople = now;
    }
    friendsCheck(); callCheck();
    setInterval(friendsCheck, 3 * 60 * 1000);
    setInterval(callCheck, 15000);
  }
  const achCache = new Map(); // appid -> { at, value }
  // RetroAchievements (Settings › Platforms)
  let raPart = null;
  const ra = () => raPart || (raPart = require('./retroach').createRetroAch(app.getPath('userData'), safeStorage));
  handle('ra:status', () => ra().status());
  handle('ra:connect', (user, key) => ra().connect(user, key));
  handle('ra:disconnect', () => ra().disconnect());
  handle('ra:progress', async (gameId) => {
    const g = lib.games.find((x) => x.id === String(gameId || ''));
    if (!g) return null;
    try { return await ra().progress(g); } catch (_) { return null; }
  });
  handle('steam:achievements', async (appid) => {
    const id = String(appid || '');
    const c = achCache.get(id);
    if (c && Date.now() - c.at < 10 * 60 * 1000) return c.value;
    if (!st().connected()) return null;
    const value = await st().achievements(id);
    achCache.set(id, { at: Date.now(), value });
    return value;
  });

  let media = null;
  const md = () => media || (media = createMedia(app.getPath('userData')));
  const MEDIA_CMDS = ['state', 'toggle', 'next', 'prev', 'shuffle', 'volup', 'voldown'];
  handle('media:run', (cmd, prefer) => {
    if (!MEDIA_CMDS.includes(cmd)) throw new Error('Unknown music command');
    const pref = prefer === 'AppleMusic' || prefer === 'Spotify' ? prefer : '';
    return md().run(cmd, pref);
  });
  const MUSIC_EXE = { 'Apple Music': 'AppleMusic.exe', Spotify: 'Spotify.exe' };
  const tasklist = () => new Promise((resolve) => execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 10000 }, (err, out) => resolve(err ? '' : String(out).toLowerCase())));
  handle('media:running', async () => {
    const list = process.platform === 'win32' ? await tasklist() : '';
    return { 'Apple Music': list.includes('"applemusic.exe"'), Spotify: list.includes('"spotify.exe"') };
  });
  // Closes a music app: politely first, then for sure (music apps lose nothing by closing).
  handle('media:close', async (appName) => {
    const exe = MUSIC_EXE[appName];
    if (!exe || process.platform !== 'win32') return false;
    await new Promise((r) => execFile('taskkill', ['/IM', exe, '/T'], { windowsHide: true }, () => r()));
    await new Promise((r) => setTimeout(r, 1500));
    if ((await tasklist()).includes('"' + exe.toLowerCase() + '"')) await new Promise((r) => execFile('taskkill', ['/IM', exe, '/T', '/F'], { windowsHide: true }, () => r()));
    if (media) media.stop(); // its music session is gone; the helper starts fresh
    return true;
  });
  handle('media:launch', (appName) => {
    if (appName !== 'Apple Music' && appName !== 'Spotify') throw new Error('Unknown app');
    if (overlayShown()) hideOverlay();
    if (w32) w32.allowForeground();
    const exes = appName === 'Spotify' ? ['spotify.exe'] : ['applemusic.exe'];
    const find = () => { try { return w32 ? w32.findAppWindow(exes, appName) : null; } catch (_) { return null; } };
    // Already open (even minimized)? Restore it and bring it forward; starting it again won't.
    const open = find();
    if (open) { fillChosenDisplay(open); return true; }
    // Just started: put its window on the chosen display, full size and in front, once it appears.
    return md().launch(appName).then((ok) => { presentApp(exes, appName, 20000); return ok; });
  });

  let artFinder = null;
  const af = () => artFinder || (artFinder = createArtFinder(app.getPath('userData'), safeStorage, artDir()));
  handle('art:status', () => af().connected());
  handle('art:connect', (key) => af().connect(key));
  handle('art:disconnect', () => { af().disconnect(); return true; });
  handle('art:find', (title, gameId, want) => af().find(title, gameId, want));

  // Opens an emulator on its own (no game), for one-time setup like controllers.
  handle('emu:open', (id) => {
    const cfg = lib.platforms[id];
    if (!scanners.EMULATORS[id] || !cfg || !cfg.exe || !fs.existsSync(cfg.exe)) throw new Error('Set the emulator program first');
    const child = spawn(cfg.exe, [], { cwd: path.dirname(cfg.exe), detached: true, stdio: 'ignore' });
    child.unref();
    presentApp([path.basename(cfg.exe).toLowerCase()], scanners.EMULATORS[id].name, 15000);
    return true;
  });
  handle('game:status', () => (running ? { gameId: running.gameId, canClose: canClose(), seen: !!(running.child || running.seen) } : null));
  handle('game:close', (force) => closeRunning(!!force));
  handle('game:resume', () => {
    if (overlayShown()) { hideOverlay(true); return true; }
    if (!win || win.isDestroyed()) return true;
    const r = running;
    pauser.resumeAfterPending().then(() => {
      let h = null;
      if (r && w32) {
        h = [r.gameHwnd, r.backTo].find((x) => x && w32.exists(x)) || null;
        if (!h) { try { h = w32.windowOfPids(r.child ? [r.child.pid] : (r.pids || [])); } catch (_) { h = null; } }
      }
      if (h) {
        r.gameHwnd = h;
        if (w32.isIconic(h)) w32.restore(h); // exclusive full-screen games were minimized for the guide
        w32.placeBelow(w32.hwndOf(win), h);
        w32.forceForeground(h);
      } else win.minimize();
    });
    return true;
  });
  handle('overlay:hide', () => { hideOverlay(true); return true; });
  // Stores, opened the controller-friendly way where there is one (Steam: Big Picture).
  handle('store:open', async (id) => {
    hideOverlay();
    if (w32) w32.allowForeground();
    if (id === 'steam') {
      await shell.openExternal('steam://open/bigpicture');
      setTimeout(() => { shell.openExternal('steam://store').catch(() => {}); }, 2500);
      const entry = { exes: ['steam.exe'], title: 'Steam Big Picture', stop: null };
      openedApps.set('steam-bp', entry);
      setTimeout(() => { if (openedApps.get('steam-bp') === entry) entry.stop = presentApp(['steam.exe'], 'Steam', 20000); }, 1500);
      return true;
    }
    if (id === 'epic') { await shell.openExternal('com.epicgames.launcher://store'); openedApps.set('epic', { exes: ['epicgameslauncher.exe'], title: 'Epic Games', stop: presentApp(['epicgameslauncher.exe'], 'Epic Games', 30000) }); return true; }
    if (id === 'xbox') {
      // The Xbox app (Game Pass): look up its app ID in the Start menu.
      const ps = "(Get-StartApps | Where-Object { $_.Name -eq 'Xbox' } | Select-Object -First 1).AppID";
      const aumid = await new Promise((r) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 }, (e, out) => r(e ? '' : String(out || '').trim())));
      if (!aumid) throw new Error('The Xbox app isn’t installed');
      execFile('explorer.exe', ['shell:AppsFolder\\' + aumid], { windowsHide: true }, () => {});
      openedApps.set('xbox', { exes: ['xboxpcapp.exe'], title: 'Xbox', stop: presentApp(['xboxpcapp.exe'], 'Xbox', 20000) });
      return true;
    }
    if (id === 'msstore') { await shell.openExternal('ms-windows-store://home'); openedApps.set('msstore', { exes: ['winstore.app.exe'], title: 'Microsoft Store', stop: presentApp(['winstore.app.exe'], 'Microsoft Store', 20000) }); return true; }
    throw new Error('Unknown store');
  });

  // ---------- Discord ----------
  // Discord doesn't allow other programs to read or send messages as you, so this only uses
  // what Discord offers everyone: its links (open a channel, server or invite), its keyboard
  // shortcuts (mute / deafen) and pasting into its message box.
  const DISCORD_EXES = ['discord.exe', 'discordptb.exe', 'discordcanary.exe'];
  const discordWindow = () => { try { return w32 ? w32.findAppWindow(DISCORD_EXES, 'Discord') : null; } catch (_) { return null; } };
  function discordLink(url) {
    const u = String(url || '').trim();
    let m = /^https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(@me|\d{5,25})(?:\/(\d{5,25}))?(?:\/(\d{5,25}))?\/?$/i.exec(u);
    if (m) return { app: 'discord://-/channels/' + [m[1], m[2]].filter(Boolean).join('/'), kind: m[2] ? 'channel' : 'server' };
    m = /^https?:\/\/(?:discord\.gg|(?:www\.)?discord(?:app)?\.com\/invite)\/([A-Za-z0-9-]{2,40})\/?$/i.exec(u);
    if (m) return { app: 'discord://-/invite/' + m[1], kind: 'invite' };
    return null;
  }
  // Brings Discord's window forward once it exists (it may still be starting).
  function bringDiscord(tries) {
    const h = discordWindow();
    if (h) { w32.show(h); return Promise.resolve(true); }
    if (!tries) return Promise.resolve(false);
    return new Promise((r) => setTimeout(() => r(bringDiscord(tries - 1)), 500));
  }
  // Discord's own connection (your Discord app): who's in calls, join/leave, mute/deafen.
  let dcRpc = null;
  const dr = () => dcRpc || (dcRpc = createDiscordRpc(app.getPath('userData'), safeStorage));
  const dcIds = (ids) => (Array.isArray(ids) ? ids : []).map(String).filter((x) => /^\d{5,25}$/.test(x)).slice(0, 10);
  handle('dcrpc:status', () => ({ configured: dr().configured(), connected: dr().connected() }));
  handle('dcrpc:connect', async (id, secret) => {
    // Discord shows its "Authorize" box: bring Discord forward so it can be clicked.
    const w = discordWindow();
    if (w && w32) setTimeout(() => fillChosenDisplay(w), 800);
    const r = await dr().connect(id, secret);
    bringBack(false);
    return r;
  });
  handle('dcrpc:disconnect', () => { dr().disconnect(); return true; });
  handle('dcrpc:state', (ids) => dr().state(dcIds(ids)));
  handle('dcrpc:join', (id) => dr().join(String(id)));
  handle('dcrpc:leave', () => dr().leave());
  handle('dcrpc:toggle', (w) => dr().toggle(w === 'deafen' ? 'deafen' : 'mute'));
  app.on('will-quit', () => { if (dcRpc) dcRpc.close(); });

  // Whether you've added the mute/deafen keybinds in Discord (asked once).
  const dcFile = () => path.join(app.getPath('userData'), 'discord.json');
  handle('discord:setup', (set) => {
    if (set === true) { try { fs.writeFileSync(dcFile(), JSON.stringify({ keys: true })); } catch (_) { /* asks again */ } return true; }
    try { return !!JSON.parse(fs.readFileSync(dcFile(), 'utf8')).keys; } catch (_) { return false; }
  });
  handle('discord:status', () => {
    const local = process.env.LOCALAPPDATA || '';
    const installed = ['Discord', 'DiscordPTB', 'DiscordCanary'].some((d) => fs.existsSync(path.join(local, d)));
    return { installed, running: !!discordWindow() };
  });
  handle('discord:check', (url) => { const l = discordLink(url); if (!l) throw new Error('That isn’t a Discord channel, server or invite link'); return l.kind; });
  handle('discord:clipboard', () => String(require('electron').clipboard.readText() || '').trim().slice(0, 300));
  // Discord doesn't let programs join a call for you. For a voice pin, the call screen opens and
  // the pointer is put on its "Join Voice" button, so pressing A (controller as mouse) joins.
  function pointAtJoin(tries) {
    const h = discordWindow();
    if (!h) { if (tries > 0) setTimeout(() => pointAtJoin(tries - 1), 600); return; }
    setTimeout(() => {
      const r = w32.rect(h);
      if (!r) return;
      const scale = w32.dpiScale(h);
      const side = Math.round(312 * scale); // server list + channel list
      w32.pointer(r.x + side + Math.round((r.width - side) / 2), r.y + Math.round(r.height * 0.56));
    }, 1800); // let Discord switch to the call screen
  }
  handle('discord:open', async (url, join) => {
    const l = url ? discordLink(url) : null;
    if (url && !l) throw new Error('That isn’t a Discord link');
    hideOverlay();
    if (w32) w32.allowForeground();
    if (!l && w32 && discordWindow()) { fillChosenDisplay(discordWindow()); return true; }
    if (l && w32 && discordWindow()) fillChosenDisplay(discordWindow());
    await shell.openExternal(l ? l.app : 'discord://-/channels/@me');
    presentApp(DISCORD_EXES, 'Discord', 20000);
    if (join && l && l.kind === 'channel' && w32) pointAtJoin(15);
    return true;
  });
  handle('discord:key', async (which) => {
    if (!w32) throw new Error('Needs Windows');
    if (!discordWindow()) throw new Error('Discord isn’t open');
    // Ctrl+Shift+M (mute) and Ctrl+Shift+D (deafen). Discord reacts to these from anywhere once
    // they're added under Discord › Settings › Keybinds (the guide explains this the first time).
    await w32.keys([0x11, 0x10], which === 'deafen' ? 0x44 : 0x4D);
    return true;
  });
  // Pastes your message into the chat that's open in Discord and sends it.
  handle('discord:type', async (text) => {
    text = String(text || '').slice(0, 2000);
    if (!text.trim()) throw new Error('Nothing to send');
    if (!w32) throw new Error('Needs Windows');
    if (!discordWindow()) throw new Error('Open Discord first');
    const { clipboard } = require('electron');
    const before = clipboard.readText();
    hideOverlay();
    await bringDiscord(6);
    await new Promise((r) => setTimeout(r, 450));
    clipboard.writeText(text);
    await w32.keys([0x11], 0x56);      // Ctrl+V
    await new Promise((r) => setTimeout(r, 250));
    await w32.keys([], 0x0D);          // Enter
    setTimeout(() => { try { clipboard.writeText(before); } catch (_) { /* fine */ } }, 800);
    return true;
  });
  handle('audio:balance', async (b, prefer) => {
    if (b == null) return Object.assign({ balance: audioBalance }, levels(audioBalance));
    audioBalance = Math.max(-100, Math.min(100, Math.round(Number(b) / 10) * 10)) || 0;
    try { fs.writeFileSync(balanceFile(), JSON.stringify({ balance: audioBalance })); } catch (_) { /* not critical */ }
    const lv = levels(audioBalance);
    const pref = prefer === 'AppleMusic' || prefer === 'Spotify' ? prefer : '';
    const [game] = await Promise.all([applyGameVolume(running), md().run('volset:' + lv.music, pref).catch(() => null)]);
    return Object.assign({ balance: audioBalance, gameFound: game != null }, lv);
  });
  // Guide › Home: a way back if a game opened or closed wrong. Drops the boot screen's
  // stay-on-top and brings the launcher forward; the game (if any) keeps running.
  handle('app:home', () => {
    if (running) releaseBoot(running);
    hideOverlay();
    bringBack(false);
    return true;
  });
  // Something in the over-the-game guide needs the full launcher (switch, close, library, settings...).
  handle('overlay:action', (req) => {
    const allowed = ['switch', 'close', 'goto'];
    if (!req || !allowed.includes(req.action)) throw new Error('Unknown action');
    if (req.target === 'home' && running) releaseBoot(running);
    hideOverlay();
    bringBack(false);
    send('remote', { action: req.action, id: req.id ? String(req.id) : null, target: req.target ? String(req.target) : null });
    return true;
  });
  handle('art:import', (src, gameId, kind) => {
    if (!src || !fs.existsSync(src)) throw new Error('Image not found');
    const ext = path.extname(src).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext)) throw new Error('Pick a PNG, JPG, WEBP, GIF or BMP image');
    fs.mkdirSync(artDir(), { recursive: true });
    const safeId = String(gameId).replace(/[^a-z0-9_-]/gi, '');
    const safeKind = String(kind).replace(/[^a-z]/gi, '');
    const dest = path.join(artDir(), safeId + '-' + safeKind + '-' + Date.now() + ext);
    fs.copyFileSync(src, dest);
    return dest;
  });
  handle('fs:list', (dir, exts) => {
    const want = Array.isArray(exts) && exts.length ? new Set(exts.map((e) => e.toLowerCase())) : null;
    if (!dir) {
      // Top level: drives on Windows, plus common folders.
      const home = app.getPath('home');
      const places = [];
      for (const [label, key] of [['Desktop', 'desktop'], ['Downloads', 'downloads'], ['Documents', 'documents'], ['Pictures', 'pictures']]) {
        try { places.push({ name: label, path: app.getPath(key), isDir: true, place: true }); } catch (_) { /* skip */ }
      }
      places.push({ name: 'Home folder', path: home, isDir: true, place: true });
      if (process.platform === 'win32') {
        for (let c = 67; c <= 90; c++) { // C: to Z:
          const d = String.fromCharCode(c) + ':\\';
          try { if (fs.existsSync(d)) places.push({ name: 'Drive ' + d.slice(0, 2), path: d, isDir: true, place: true }); } catch (_) { /* skip */ }
        }
      } else {
        places.push({ name: 'Computer', path: '/', isDir: true, place: true });
      }
      return { path: '', parent: null, entries: places };
    }
    const resolved = path.resolve(dir);
    const ents = fs.readdirSync(resolved, { withFileTypes: true });
    const entries = [];
    for (const e of ents) {
      if (e.name.startsWith('$') || e.name.startsWith('.')) continue;
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) { try { isDir = fs.statSync(path.join(resolved, e.name)).isDirectory(); } catch (_) { continue; } }
      if (!isDir && want && !want.has(path.extname(e.name).toLowerCase())) continue;
      entries.push({ name: e.name, path: path.join(resolved, e.name), isDir });
    }
    entries.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    const parent = path.dirname(resolved);
    return { path: resolved, parent: parent === resolved ? '' : parent, entries };
  });
  // The normal Windows "Open" window.
  handle('fs:pick', async (opts) => {
    opts = opts || {};
    const exts = (opts.exts || []).map((e) => String(e).replace(/^\./, '')).filter(Boolean);
    const r = await dialog.showOpenDialog(win, {
      title: opts.title || 'Choose',
      defaultPath: opts.start || undefined,
      properties: [opts.folder ? 'openDirectory' : 'openFile'],
      filters: opts.folder || !exts.length ? [] : [{ name: opts.filterName || 'Supported files', extensions: exts }, { name: 'All files', extensions: ['*'] }]
    });
    if (win && !win.isDestroyed()) win.focus();
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });
  // Checks a typed or pasted path.
  handle('fs:stat', (p) => {
    const clean = String(p || '').trim().replace(/^"(.*)"$/, '$1');
    if (!clean) return { exists: false, path: '' };
    try {
      const st = fs.statSync(clean);
      return { exists: true, isDir: st.isDirectory(), path: path.resolve(clean) };
    } catch (_) {
      return { exists: false, path: clean };
    }
  });
  handle('app:info', () => ({
    platform: process.platform,
    version: VERSION,
    updateFailed: global.couchUpdateFailed || null,
    windowed: WINDOWED,
    hotkey: controller.available,
    guideButton: controller.available && controller.guide,
    autostart: process.platform === 'win32' ? app.getLoginItemSettings(loginOpts()).openAtLogin : null,
    emulators: Object.fromEntries(Object.entries(scanners.EMULATORS).map(([k, v]) => [k, { name: v.name, system: v.system, exts: v.exts, catalog: !!v.catalog, color: v.color || null, exe: (v.exes || [k + '.exe'])[0], noFolder: k === 'rpcs3' || require('./emuscan').needsNoFolder(k) }]))
  }));
  function loginOpts() {
    // When run from source (npm start), Windows has to start Electron with the app folder.
    return app.isPackaged ? {} : { path: process.execPath, args: [path.resolve(app.getAppPath())] };
  }
  handle('app:autostart', (on) => {
    app.setLoginItemSettings(Object.assign({ openAtLogin: !!on }, loginOpts()));
    return app.getLoginItemSettings(loginOpts()).openAtLogin;
  });
  function doPower(action) {
    if (action === 'exit') { setTimeout(() => app.quit(), 50); return true; }
    if (process.platform !== 'win32') return false;
    if (action === 'restart') execFile('shutdown', ['/r', '/t', '0'], { windowsHide: true }, () => {});
    else if (action === 'shutdown') execFile('shutdown', ['/s', '/t', '0'], { windowsHide: true }, () => {});
    else if (action === 'sleep') execFile('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'], { windowsHide: true }, () => {});
    return true;
  }
  handle('app:power', (action) => doPower(action));

  // ---------- Sleep timer (guide › Profile & system) ----------
  // A minute before: a pop-up. At the end: the game closes the normal way (so it can save; the
  // emulators make their resume state), then the PC sleeps or turns off.
  let sleepT = null;
  const sleepStatus = () => (sleepT ? { at: sleepT.at, action: sleepT.action } : null);
  function setSleep(minutes, action) {
    if (sleepT) clearInterval(sleepT.timer);
    sleepT = null;
    const m = Number(minutes);
    if (!(m > 0)) return null;
    sleepT = { at: Date.now() + Math.min(600, m) * 60e3, action: action === 'sleep' ? 'sleep' : 'shutdown', warned: false };
    sleepT.timer = setInterval(sleepTick, 5000);
    return sleepStatus();
  }
  function sleepTick() {
    const t = sleepT;
    if (!t) return;
    const left = t.at - Date.now();
    if (left <= 60e3 && !t.warned) { t.warned = true; notify('Sleep timer', (t.action === 'sleep' ? 'The PC goes to sleep' : 'The PC turns off') + ' in 1 minute. Open the guide to change it.'); }
    if (left > 0) return;
    clearInterval(t.timer);
    sleepT = null;
    (async () => {
      if (tvPart && tvPart.playing) tvPart.stop('sleep');
      if (running) {
        try { await closeRunning(false); } catch (_) { /* power off anyway */ }
        for (let i = 0; i < 40 && running; i++) await wait(500);
      }
      doPower(t.action);
    })();
  }
  handle('sleep:get', () => sleepStatus());
  handle('sleep:set', (minutes, action) => setSleep(minutes, action));

  // ---------- Save backups (Settings › Saves & backups) ----------
  const bkup = require('./backups');
  function backupRoot() {
    const s = lib && lib.settings;
    if (!s) return null;
    if (s.backupTo === 'folder') return s.backupFolder && fs.existsSync(s.backupFolder) ? s.backupFolder : null;
    if (s.backupTo === 'onedrive' || s.backupTo === 'gdrive') { const d = bkup.destinations(process.env, allDrives()).find((x) => x.id === s.backupTo); return d ? d.path : null; }
    return null;
  }
  const backups = bkup.createBackups({ root: backupRoot, keep: () => Math.max(1, Math.min(50, Number(lib.settings.backupKeep) || 10)) });
  function saveSources(id) {
    const exe = (lib.platforms[id] || {}).exe;
    if (!exe) return [];
    return bkup.saveDirs(id, exe, process.env, { dolphinUser: id === 'dolphin' ? players.dolphinUserDir(exe) : null });
  }
  function backupNow(id, why) { return backups.backup(id, saveSources(id), why); }
  function afterGameBackup(id) { backupNow(id, 'after').catch(() => null); }
  const emuIds = () => Object.keys(scanners.EMULATORS).filter((id) => lib.platforms[id] && lib.platforms[id].exe);
  handle('backup:status', () => ({
    to: lib.settings.backupTo || 'off', folder: lib.settings.backupFolder || '', keep: Number(lib.settings.backupKeep) || 10,
    root: backupRoot(), dests: bkup.destinations(process.env, allDrives()),
    emus: emuIds().map((id) => { const snaps = backups.snapshots(id); return { id, name: scanners.EMULATORS[id].name, sources: saveSources(id), last: snaps[0] ? snaps[0].at : 0, count: snaps.length }; })
  }));
  handle('backup:now', async (id) => {
    if (!backupRoot()) throw new Error('Choose where backups go first');
    const ids = id ? [String(id)] : emuIds();
    let done = 0;
    for (const x of ids) { const r = await backupNow(x, 'manual').catch(() => null); if (r && r.done) done++; }
    return { done, of: ids.length };
  });
  handle('backup:list', (id) => backups.snapshots(String(id || '')).map((s) => ({ id: s.id, at: s.at, why: s.why })));
  handle('backup:restore', async (id, snapId) => {
    id = String(id || '');
    if (running && running.emu === id) throw new Error('Close the game first');
    await backups.restore(id, String(snapId || ''), saveSources(id));
    return true;
  });

  app.on('second-instance', () => bringBack(false));

  app.whenReady().then(() => {
    lib = library.load(libFile());
    // First run: turn on start-with-Windows (only for the installed app).
    if (!fs.existsSync(libFile())) {
      if (app.isPackaged && lib.settings.autostart) {
        try { app.setLoginItemSettings({ openAtLogin: true }); } catch (_) { /* ignore */ }
      }
      persist();
    }
    createWindow();
    setTimeout(() => { try { createOverlay(); } catch (_) { /* made on first use */ } }, 2000);
    // Monitors plugged in or removed: stay on the chosen one, or fall back to the main one.
    screen.on('display-removed', () => placeWindows());
    screen.on('display-added', () => placeWindows());
    screen.on('display-metrics-changed', () => { if (!running) placeWindows(); }); // games: re-placed when they end
    controller.start();
    padMouse.start();
    startPadWatch();
    setTimeout(startAlerts, 15000);
    startDownloadWatch();
    startNewsWatch();
    // Look for an update a few seconds after starting, then every 3 hours (never mid-game).
    let offered = null;
    const autoCheck = async () => {
      if (running) return;
      try {
        const r = await checkAll(true);
        if (r.status === 'ready' && !running && offered !== r.version) { offered = r.version; send('update:found', r); }
      } catch (_) { /* checked again later or from Settings */ }
    };
    setTimeout(autoCheck, 4000);
    setInterval(autoCheck, 3 * 60 * 60 * 1000);
    // Keyboard escape hatch to bring the launcher back from a game.
    try { globalShortcut.register('Control+Alt+Home', () => guidePressed()); } catch (_) { /* taken */ }
  });

  app.on('will-quit', () => { globalShortcut.unregisterAll(); controller.stop(); padMouse.stop(); if (tvPart) tvPart.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { pauser.resumeAll(); if (overlay && !overlay.isDestroyed()) overlay.destroy(); if (media) media.stop(); });
}
