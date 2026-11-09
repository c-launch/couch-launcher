'use strict';
const { app, BrowserWindow, ipcMain, shell, globalShortcut, Menu, safeStorage, dialog, screen, Notification, clipboard, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const scanners = require('./scanners');
const library = require('./library');
const { createControllerWatcher, loadXInput, readPads } = require('./hotkey');
const { asGamepad } = require('./macpads');
const anticheat = require('./anticheat');
const { createPadMouse } = require('./padmouse');
const { createXbox } = require('./xbox');
const { createUpdater } = require('./updater');
const { createDiscordRpc } = require('./discordrpc');
const players = require('./players');
const { createDisplay } = require('./display');
const { createNews } = require('./news');
const clipsMod = require('./clips');
const { createSteam } = require('./steam');
const friendsLib = require('./friends');
const dealsLib = require('./deals');
const { createMedia } = require('./media');
const { createPauser } = require('./pause');
const { createWin32 } = require('./win32');
const { createArtFinder } = require('./artfinder');

const VERSION = global.couchVersion || require('../package.json').version;
const newerThan = global.couchNewer || ((a, b) => String(a) > String(b));

let WINDOWED = process.argv.includes('--windowed'); // also Settings › Display › Full screen: off
const MAC = process.platform === 'darwin';
// A mistake somewhere in the app core must never pop up Electron's error box: over a full-screen
// launcher it hides behind it, takes the focus, and the controller seems to stop working.
// It's written to errors.log (in the launcher's settings folder) instead.
process.on('uncaughtException', (err) => {
  try {
    const f = path.join(app.getPath('userData'), 'errors.log');
    try { if (fs.statSync(f).size > 512 * 1024) fs.renameSync(f, f + '.old'); } catch (_) { /* new file */ }
    fs.appendFileSync(f, new Date().toISOString() + ' ' + String(err && err.stack || err) + '\n');
  } catch (_) { /* nowhere to write */ }
});
// Build check (see COUCH_SELFTEST below): what the screens printed, to spot a screen that broke.
const selftestLog = [];
if (process.env.COUCH_SELFTEST) {
  app.on('web-contents-created', (_e, wc) => wc.on('console-message', (_ev, level, message, line, source) => {
    if (selftestLog.length < 200) selftestLog.push([level, String(message).slice(0, 500), line, String(source || '').split('/').pop()]);
  }));
}

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
    // Where Share is in Windows' Xbox Bluetooth report (found once in Settings › Controllers).
    shareMap: () => (lib && lib.settings && lib.settings.xboxShareMap) || null,
    extraShare: () => !!(rawPads && rawPads.share),
    // Mac: the guide window gets the controller from here (macOS may not give it to a window
    // that just came in front of a game).
    onState: (gp) => { if (MAC) feedPads(gp); },
    // While a movie or episode plays, the controller drives the player.
    // Share button -> Medal (tap: screenshot, hold: clip). Not inside the launcher itself.
    onCapture: (st) => {
      if (!capture || !lib) return;
      // Pressed just now (Share, or View + a bumper)? Written down for the Share test screen.
      const down = !!(st.xShare || st.psShare || (st.xView && (st.xLB || st.xRB)));
      const edge = down && !captureWasDown;
      captureWasDown = down;
      let why = null;
      if (lib.settings.medalShare === false) why = 'off';
      else if (overlayShown()) why = 'guide';
      else if (launcherInFront()) why = 'launcher';
      if (edge) {
        let front = null;
        try { front = w32 && w32.frontInfo ? w32.frontInfo() : null; } catch (_) { front = null; }
        let hid = null;
        try { const x = (controller.shareDebug().xbox || [])[0]; hid = x ? { age: x.lastAt ? Date.now() - x.lastAt : null, reports: x.reports, buttons: x.buttons } : null; } catch (_) { hid = null; }
        lastCapture = { at: Date.now(), what: st.xShare ? 'Share' : st.psShare ? 'Share (PlayStation)' : 'View + ' + (st.xRB ? 'RB' : 'LB'), why, front: front ? { exe: front.exe, elevated: front.elevated, selfElevated: front.selfElevated } : null, sent: null, hid, via: st.xShareRaw ? 'background' : null };
      }
      if (why) return;
      capture.input(st);
    },
    onButtons: (mask, lx, ly) => {
      if (tvPart && tvPart.playing) { if (!overlayShown()) tvPart.input(mask, lx, ly); }
      else if (yt && yt.isFront()) yt.input(mask, lx, ly);
      if (!MAC) feedPads([asGamepad({ mask, lx, ly, rx: 0, ry: 0, lt: 0, rt: 0 })]);
    },
    // B on the boot screen while Steam/Epic has focus (the launcher can't hear it then).
    onBack: () => {
      const r = running;
      if (r && r.boot && win && !win.isDestroyed() && !win.isFocused()) { cancelLaunch(); send('launch:cancelled', { gameId: r.gameId }); }
    }
  });

  // The controller as read here, for a launcher screen that's on top but wasn't given the keyboard
  // focus (macOS and Windows sometimes refuse a window that asks for it, for example after a game
  // or when it starts with the computer). Without focus the screen can't read the controller
  // itself, so everything, the guide included, seemed to stop working.
  // wantFront: the launcher asked to be in front (and hasn't been left for another app since).
  let wantFront = true, lastFocusTry = 0;
  // Anything the launcher opens (a store, a link, a program) is where you're going next.
  for (const k of ['openExternal', 'openPath']) {
    try { const orig = shell[k].bind(shell); shell[k] = (...args) => { wantFront = false; return orig(...args); }; } catch (_) { /* left as is */ }
  }
  // Is the guide really the window in front? Electron can think it has the focus while Windows
  // kept it with the game (a full-screen game, or an anti-cheat game we don't push aside).
  function overlayInFront() {
    if (!overlay || overlay.isDestroyed() || !overlay.isFocused()) return false;
    if (!w32) return true;
    try { const fg = w32.foreground(); return !!fg && fg.hwnd === w32.hwndOf(overlay); } catch (_) { return true; }
  }
  function feedPads(gp) {
    if (overlayShown()) {
      if (MAC || !overlayInFront()) sendOverlay('pad:ext', gp);
      return;
    }
    if (!wantFront || !win || win.isDestroyed() || !win.isVisible() || win.isMinimized() || win.isFocused()) return;
    if ((tvPart && tvPart.playing) || (yt && yt.isShown())) return;
    send('pad:ext', gp);
    // Keep asking for the focus now and then; the keyboard and mouse need it.
    const now = Date.now();
    if (now - lastFocusTry > 3000) { lastFocusTry = now; try { if (w32) w32.forceForeground(w32.hwndOf(win)); if (MAC) app.focus({ steal: true }); win.focus(); } catch (_) { /* next time */ } }
  }

  // Medal: the launcher presses Medal's own hotkeys (Settings › Controllers › Clips with Medal).
  let shotHintAt = 0;
  const capture = require('./capture').createCapture({
    mode: () => (lib && lib.settings.medalXbox) || 'auto',
    fire: (kind) => pressMedal(kind)
  });
  function pressMedal(kind) {
    if (!w32 || !lib) return false;
    if (running && running.protected) {
      // Keys pressed for you look like a macro tool to anti-cheat (BattlEye's "forbidden tool").
      if (!running.medalHinted) { running.medalHinted = true; notify('Share clips are off in this game', 'Its anti-cheat kicks you for keys pressed by another program. Use Medal’s own clip key on the keyboard.'); }
      return false;
    }
    const key = kind === 'clip' ? (lib.settings.medalClipKey || 'F8') : lib.settings.medalShotKey;
    const k = require('./capture').parseKey(key);
    if (!k) {
      if (Date.now() - shotHintAt > 30000) { shotHintAt = Date.now(); notify('Screenshot key not set', 'Hold Share for a clip. For screenshots, set Medal’s screenshot key in Settings › Controllers.'); }
      return false;
    }
    lastMedalPress = { kind, at: Date.now() };
    if (lastCapture && Date.now() - lastCapture.at < 5000) lastCapture.sent = kind;
    w32.keys(k.mods, k.vk).catch(() => {});
    return true;
  }
  let lastMedalPress = null, lastCapture = null, captureWasDown = false;
  // Share during games: Windows only gives the controller's Bluetooth data to the app in front,
  // so a small reader process takes it through Raw Input instead (rawpads.js). It runs while
  // Share is on for Medal and has been found once (Find Share).
  let rawPads = null;
  function rawPadsWanted() {
    if (!w32 || !lib || process.platform !== 'win32') return false;
    const s = lib.settings;
    return s.medalShare !== false && !!s.xboxShareMap && (s.medalXbox || 'auto') !== 'combo' && !(running && running.protected);
  }
  // Anti-cheat games (Fortnite, Valorant, Apex…): spotted by name, by their anti-cheat folders, or
  // by the anti-cheat service that runs with them. Then the launcher keeps its hands off the game.
  function watchProtection(r, g) {
    const mark = (why) => {
      if (running !== r || r.protected) return;
      r.protected = why;
      syncRawPads();
      if (pauser.available) pauser.resumeAll();
    };
    if (anticheat.titleIsProtected(g && g.title)) mark('title');
    const dirs = [r.dir, g && g.launch && g.launch.exe ? path.dirname(g.launch.exe) : null].filter(Boolean);
    setTimeout(() => { for (const d of dirs) if (!r.protected && anticheat.dirIsProtected(d)) mark('folder'); }, 0);
    if (process.platform !== 'win32') return;
    let busy = false, tries = 0;
    r.acTimer = setInterval(() => {
      if (running !== r || r.protected || ++tries > 60) { clearInterval(r.acTimer); return; }
      if (busy) return;
      busy = true;
      execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 8000 }, (err, out) => { busy = false; if (!err && anticheat.processesShowProtection(out)) mark('service'); });
    }, 5000);
  }
  function syncRawPads() {
    const on = rawPadsWanted();
    if (on && !rawPads) {
      let koffiPath = '';
      try { koffiPath = require.resolve('koffi'); } catch (_) { koffiPath = ''; }
      rawPads = require('./rawpads').createRawPads({ platform: process.platform, execPath: process.execPath, koffiPath, shareMap: () => (lib && lib.settings.xboxShareMap) || null });
    }
    if (rawPads) { if (on) rawPads.start(); else rawPads.stop(); }
  }
  // The launcher's own windows in front? (Checked with Windows itself: Electron's own idea of
  // focus can lag behind when a game takes the screen.)
  function launcherInFront() {
    if (w32) {
      try { const fg = w32.foreground(); if (fg) return fg.pid === process.pid; } catch (_) { /* fall back */ }
    }
    return !!(win && !win.isDestroyed() && win.isFocused());
  }
  const pauser = createPauser();
  // Controller as a mouse in Apple Music / Spotify (setting, on by default).
  const padMouse = createPadMouse(loadXInput, () => !(lib && lib.settings && lib.settings.musicMouse === false));
  const w32 = createWin32();
  if (w32) w32.isGentle = () => !!(running && running.protected);

  // Pause the game whenever the guide or the launcher is in front of it (setting, on by default).
  const wantPause = () => {
    const r = running;
    if (!r || !r.started || r.closing || !pauser.available) return false;
    if (r.protected) return false; // anti-cheat games: never paused (their anti-cheat would kick you)
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
      // Mac: a panel is what can float over another app's full-screen space.
      // Its vibrancy frosts the game behind the guide, the way macOS frosts what's under its panels.
      ...(MAC ? { type: 'panel', vibrancy: 'fullscreen-ui', visualEffectState: 'active' } : {}),
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
    });
    overlay.setAlwaysOnTop(true, 'screen-saver');
    if (MAC) { try { overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) { /* older macOS */ } }
    overlay.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { overlay: '1' } });
    overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    overlay.webContents.on('will-navigate', (e) => e.preventDefault());
    overlay.on('closed', () => { overlay = null; });
  }
  // Mac: light or dark glass (menus, the frosted guide) to match the launcher's theme.
  function syncAppearance() {
    if (!MAC || !lib) return;
    try { require('electron').nativeTheme.themeSource = ['macoslight', 'cleanslate'].includes(lib.settings.theme) ? 'light' : 'dark'; } catch (_) { /* older Electron */ }
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
    overlay.webContents.send('overlay:open', { gameId: running ? running.gameId : null, canClose: canClose(), tv: tvPart && tvPart.playing ? tvPart.now() : null, yt: ytGuide });
    // Mac: the launcher steps aside (app.hide) when you go back to a game, and a hidden app's
    // windows don't show, so un-hide it first. macOS may not let it take focus from the game;
    // the guide still floats on top and reads the controller itself (pad:ext), so it works either way.
    if (MAC) { try { if (app.isHidden()) app.show(); } catch (_) { /* older Electron */ } }
    overlay.show();
    overlay.setAlwaysOnTop(true, 'screen-saver');
    if (w32) w32.forceForeground(w32.hwndOf(overlay));
    if (MAC) { try { overlay.moveTop(); } catch (_) { /* fine */ } app.focus({ steal: true }); }
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
      // Mac: stepping the launcher aside hands the screen back to the game (or the player).
      if (MAC && refocus && !ytGuide && ((r && running === r) || (tvPart && tvPart.inGuide))) app.hide();
      // Back to what you were watching.
      if (ytGuide) { ytGuide = false; if (refocus) yt.resumeFromGuide(); }
      if (tvPart && tvPart.inGuide) {
        tvPart.resumeFromGuide();
        if (refocus && w32 && tvBackTo && w32.exists(tvBackTo)) { try { w32.forceForeground(tvBackTo); } catch (_) { /* fine */ } }
      }
      setTimeout(updatePause, 100);
    });
  }
  let tvBackTo = null; // the player's window, to give it focus back after the guide
  let ytGuide = false; // the guide is open over YouTube
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
    // Watching something: it pauses and the guide opens over it; closing the guide carries on.
    if (tvPart && tvPart.playing) {
      if (overlayShown()) { hideOverlay(true); return; }
      try { const fg = w32 && w32.foreground(); tvBackTo = fg && fg.pid !== process.pid ? fg.hwnd : null; } catch (_) { tvBackTo = null; }
      tvPart.pauseForGuide();
      showOverlay();
      return;
    }
    // In YouTube: it pauses and the guide opens over it; closing the guide carries on.
    if (yt && yt.isShown() && (yt.isFront() || (overlayShown() && ytGuide))) {
      if (overlayShown()) { hideOverlay(true); return; }
      ytGuide = true;
      yt.pauseForGuide().then(() => showOverlay());
      return;
    }
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
  // Windows decides who's in front, not Electron: a game can keep the screen while Electron still
  // thinks the guide has the focus (GTA V does, and anti-cheat games, which we don't push aside).
  // Then the guide flickers and can't be controlled, so the game steps aside instead.
  function checkOverlayKept(r) {
    const check = () => {
      if (running !== r || r.exclusive || !overlayShown() || !overlay || overlay.isDestroyed()) return;
      let fg = null;
      try { fg = w32 && w32.foreground(); } catch (_) { fg = null; }
      if (fg && fg.pid !== process.pid) guideInLauncher(r);
    };
    setTimeout(check, 400);
    setTimeout(check, 1000);
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
    wantFront = true;
    if (win.isMinimized()) win.restore();
    if (MAC) { try { if (app.isHidden()) app.show(); } catch (_) { /* older Electron */ } }
    win.show();
    // Windows blocks background programs from taking focus; take it the way overlay tools do.
    win.setAlwaysOnTop(true);
    if (w32) w32.forceForeground(w32.hwndOf(win));
    if (MAC) app.focus({ steal: true });
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
    wantFront = false; // another app (store, music, Discord…) is coming to the front
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
  // Full screen is switched off and on again only when the screen itself changed (another
  // monitor, a new resolution). Hiding the Mac's menu bar for full screen changes the screen's
  // usable area, and reacting to that switched full screen off and on in an endless loop
  // (a black screen that kept flashing). If it ever toggles that often again, it stops.
  let placeTimes = [], placeStorm = false, placeCount = 0;
  function placeWindows() {
    const d = targetDisplay();
    if (win && !win.isDestroyed()) {
      const isFull = () => (MAC ? win.isSimpleFullScreen() : win.isFullScreen());
      const setFull = (on) => (MAC ? win.setSimpleFullScreen(on) : win.setFullScreen(on));
      const b = win.getBounds();
      const there = b.x === d.bounds.x && b.y === d.bounds.y && b.width === d.bounds.width && b.height === d.bounds.height;
      if (!WINDOWED && isFull() && there) { if (overlay && !overlay.isDestroyed()) overlay.setBounds(d.bounds); return; }
      const now = Date.now();
      placeTimes = placeTimes.filter((t) => now - t < 15000).concat(now);
      if (placeTimes.length > 4) placeStorm = true;
      placeCount++;
      if (placeStorm) { if (!WINDOWED && !isFull()) setFull(true); if (overlay && !overlay.isDestroyed()) overlay.setBounds(d.bounds); return; }
      const wasFull = isFull();
      if (wasFull) setFull(false);
      if (WINDOWED) win.setBounds({ x: d.workArea.x + 60, y: d.workArea.y + 60, width: Math.min(1600, d.workArea.width - 120), height: Math.min(900, d.workArea.height - 120) });
      else { win.setBounds(d.bounds); setTimeout(() => { if (win && !win.isDestroyed()) setFull(true); }, wasFull ? 250 : 0); }
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
      // Mac: "simple" full screen (no separate Space), so games and the guide can go over it.
      fullscreen: !WINDOWED && !MAC,
      simpleFullscreen: !WINDOWED && MAC,
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
    // Mac keeps a minimal menu, so Cmd+Q and Cmd+H still work.
    Menu.setApplicationMenu(MAC ? Menu.buildFromTemplate([
      { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' },
        { label: 'Full Screen', type: 'checkbox', checked: !WINDOWED, accelerator: 'Ctrl+Cmd+F', click: () => setWindowed(!WINDOWED) },
        { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' }]) : null);
    if (MAC) { try { app.setAboutPanelOptions({ applicationName: 'Couch Launcher', applicationVersion: VERSION, copyright: 'Made by Jahdiel', credits: 'Your games, on the couch, with a controller.' }); } catch (_) { /* fine */ } }
    win.once('ready-to-show', () => { win.show(); if (MAC && !WINDOWED) win.setSimpleFullScreen(true); win.focus(); });
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

    // Once the game takes over the screen, get out of its way.
    win.on('blur', () => {
      wantFront = false; // you went to another app (or a game took over): leave the controller to it
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
    wantFront = false;
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
      if (!r.monitorWatched) { r.monitorWatched = true; watchGameMonitor(r); }
      w32.placeBelow(w32.hwndOf(win), game.hwnd);
      w32.focus(game.hwnd);
    } else if (MAC) {
      win.hide();
    } else {
      win.minimize();
    }
    r.started = true;
    send('game:started', { gameId: r.gameId });
  }
  // Games open on Windows' main monitor; if a different one is chosen in Settings › Display,
  // move the game's window there (works for windowed and borderless full-screen games).
  function moveGameToChosenMonitor(r) {
    if (!w32 || !r.gameHwnd || !lib.settings.displayId || r.protected) return;
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
  // Did the game end up on the chosen monitor? (Full-screen games that grab Windows' main monitor
  // can't be moved.) If not, the launcher offers to make the chosen one the main monitor for it.
  function watchGameMonitor(r) {
    if (!w32 || MAC || !lib.settings.displayId || r.layoutRestore) return;
    const check = () => {
      if (running !== r || r.layoutRestore) return;
      const d = targetDisplay();
      if (d.id === screen.getPrimaryDisplay().id) { r.wrongMonitor = false; return; }
      let h = r.gameHwnd;
      if (!h || !w32.exists(h)) { const fg = gameWindow(r); h = fg && fg.hwnd; }
      if (!h) return;
      const cur = w32.rect(h);
      if (!cur || cur.width < 200 || cur.height < 150) return;
      const px = toPx(d.bounds), cx = cur.x + cur.width / 2, cy = cur.y + cur.height / 2;
      r.wrongMonitor = !(cx >= px.x && cx < px.x + px.width && cy >= px.y && cy < px.y + px.height);
    };
    setTimeout(check, 9000);
    setTimeout(check, 25000);
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
    if (vpadsGame) stopSteady();
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
    if (g && seconds) { g.playtime = (g.playtime || 0) + seconds; persist(); try { statsPart().record(g.id, g.title, r.startedAt, seconds); } catch (_) { /* fine */ } }
    if (r.emu && g && g.launch && rsm().supported(r.emu) && lib.settings.saveStates !== false) { try { rsm().recordAfter(r.emu, (lib.platforms[r.emu] || {}).exe, r.gameId, g.launch, r.startedAt); } catch (_) { /* fine */ } }
    if (r.emu && typeof afterGameBackup === 'function') afterGameBackup(r.emu);
    bringBack(false);
    // It played on the wrong monitor (and it isn't set to switch the main one): ask about it.
    const wrongMonitor = !!(r.wrongMonitor && seconds >= 20 && g && !mainWhilePlaying(g) && !(g.display && g.display.main === false));
    send('game:exited', Object.assign({ gameId: r.gameId, seconds, wrongMonitor }, extra || {}));
  }

  function startProcess(exe, args, cwd, gameId) {
    if (!exe || !fs.existsSync(exe)) throw new Error('Program not found: ' + (exe || '(not set)'));
    // Mac apps are folders (Name.app): start the program inside, so the launcher knows when it closes.
    if (MAC && /\.app\/?$/i.test(exe)) { const bin = macAppBinary(exe); if (!bin) throw new Error('Couldn’t start ' + path.basename(exe)); cwd = path.dirname(exe); exe = bin; }
    const child = spawn(exe, args, { cwd, detached: false, windowsHide: false, stdio: 'ignore' });
    const r = { gameId, child, pids: [], startedAt: Date.now(), pending: true };
    running = r;
    child.on('error', (err) => endGame(r, { error: String(err.message || err) }));
    child.on('exit', () => endGame(r));
  }

  // The program inside a Mac app (Contents/MacOS/<CFBundleExecutable>).
  function macAppBinary(appPath) {
    const dir = path.join(appPath, 'Contents', 'MacOS');
    let name = null;
    try { name = require('child_process').execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')], { timeout: 5000 }).toString().trim(); } catch (_) { name = null; }
    if (name && fs.existsSync(path.join(dir, name))) return path.join(dir, name);
    try { const f = fs.readdirSync(dir).find((n) => !n.startsWith('.')); return f ? path.join(dir, f) : null; } catch (_) { return null; }
  }
  // Store games (Steam/Epic) start through their launcher, so find the game's own processes
  // by looking for programs running from the game's install folder.
  function pidsIn(dir) {
    return new Promise((resolve) => {
      if (MAC && dir) {
        const d = dir.endsWith('/') ? dir : dir + '/';
        return execFile('/bin/ps', ['-axww', '-o', 'pid=,command='], { timeout: 10000 }, (err, out) => {
          if (err) return resolve(null);
          resolve(String(out).split('\n').map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter((m) => m && m[2].startsWith(d) && !/crash|bugreport|errorreport/i.test(m[2])).map((m) => Number(m[1])).filter((n) => n !== process.pid));
        });
      }
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
      // Joining a friend: Steam's join link starts the game straight into their lobby / server.
      shell.openExternal(opts.joinUrl && /^steam:\/\/(joinlobby|connect)\//.test(opts.joinUrl) ? opts.joinUrl : L.url);
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
    if (L.type !== 'emu') watchProtection(running, g);
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
  handle('capture:status', () => {
    const d = controller.shareDebug();
    return { xboxShareReadable: controller.xboxShareReadable, xboxNeedsFind: (d.xbox || []).some((x) => x.windowsReport && !x.learned) };
  });
  // Settings › Controllers › Test the Share button: what the launcher sees, live.
  handle('capture:learn', () => controller.learnShare(15000));
  handle('capture:debug', () => Object.assign(saveLearnedShare(controller.shareDebug()), {
    clipKey: lib.settings.medalClipKey || 'F8', shotKey: lib.settings.medalShotKey || '', mode: lib.settings.medalXbox || 'auto',
    on: lib.settings.medalShare !== false, lastPress: lastMedalPress, keysOk: !!w32, lastCapture, away: awayStats,
    raw: rawPads ? rawPads.debug() : { off: true, wanted: rawPadsWanted() }
  }));
  // What the Xbox controller's Bluetooth data looked like while another app was in front
  // (for the Share test): Windows can hide a controller from apps that aren't in front.
  let awayStats = null;
  function startAwayWatch() {
    let lastPid = 0, lastExe = '', prev = null;
    setInterval(() => {
      if (!w32 || !lib || lib.settings.medalShare === false) { prev = null; return; }
      let x = null;
      try { x = (controller.shareDebug().xbox || [])[0] || null; } catch (_) { x = null; }
      if (!x) { prev = null; return; }
      const cur = { reports: x.reports || 0, blanks: x.blanks || 0, moves: x.buttons ? x.buttons.at : 0, raw: rawPads ? rawPads.debug().reports : 0 };
      const before = prev; prev = cur;
      let fg = null;
      try { fg = w32.foreground(); } catch (_) { fg = null; }
      if (!before || !fg || fg.pid === process.pid) return;
      if (fg.pid !== lastPid) { lastPid = fg.pid; try { lastExe = (w32.frontInfo() || {}).exe || ''; } catch (_) { lastExe = ''; } }
      if (!lastExe) return;
      if (!awayStats || awayStats.exe !== lastExe) awayStats = { exe: lastExe, since: Date.now(), secs: 0, reports: 0, blanks: 0, buttons: 0, raw: 0 };
      awayStats.raw += Math.max(0, cur.raw - before.raw);
      awayStats.secs += 1;
      awayStats.reports += Math.max(0, cur.reports - before.reports);
      awayStats.blanks += Math.max(0, cur.blanks - before.blanks);
      if (cur.moves && cur.moves !== before.moves) awayStats.buttons += 1;
      awayStats.at = Date.now();
    }, 1000);
  }

  function saveLearnedShare(d) {
    const f = d && d.learn && d.learn.found;
    const cur = lib.settings.xboxShareMap;
    if (f && !(cur && cur.pid === f.pid && cur.size === f.size && cur.byte === f.byte && cur.mask === f.mask)) { lib.settings.xboxShareMap = f; persist(); }
    return d;
  }
  // …and a test clip, to check Medal hears the launcher's key press.
  handle('capture:test', (kind) => pressMedal(kind === 'shot' ? 'shot' : 'clip'));

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
  // Steady players (Settings › Controllers): virtual controllers held for the game's players.
  let vp = null, vpadsGame = null;
  function vpadsPart() {
    if (vp || MAC || process.platform !== 'win32') return vp;
    let koffiPath = '';
    try { koffiPath = require.resolve('koffi'); } catch (_) { koffiPath = ''; }
    vp = require('./vpads').createVPads({ execPath: process.execPath, koffiPath, onState: (st) => { send('vpads', st); sendOverlay('vpads', st); } });
    return vp;
  }
  function stopSteady() { vpadsGame = null; if (vp) vp.stop(); }
  const ryujinxGuids = () => ({ virtualGuid: lib.settings.vpadGuid || null, realGuid: lib.settings.ryujinxRealGuid || null });
  handle('players:set', async (gameId, slots) => {
    if (MAC) throw new Error('On a Mac, set players in the emulator');
    const { emu, exe } = emuOf(gameId);
    const list = (Array.isArray(slots) ? slots : []).map(Number).filter((n) => n >= 0 && n <= 3);
    const connected = readPads().map((p) => p.slot);
    if (emu === 'ryujinx' && lib.settings.steadyPlayers && lib.settings.vpadGuid && list.length && vpadsPart()) {
      const f = players.ryujinxConfigPath(exe);
      const cur = f ? players.ryujinxPlayer1Guid(f) : null;
      if (cur && cur !== lib.settings.vpadGuid && lib.settings.ryujinxRealGuid !== cur) { lib.settings.ryujinxRealGuid = cur; persist(); }
      const r = f ? await vp.start(list) : { error: 'Ryujinx settings not found' };
      if (r && r.ok) {
        const n = players.setRyujinxVirtual(f, list.length, lib.settings.vpadGuid);
        vpadsGame = gameId; playerCount[emu] = n;
        return n;
      }
      send('notice', { title: 'Steady players didn’t start (' + ((r && r.error) || 'unknown') + '). Using your controllers directly.' });
    }
    const n = players.setPlayers(emu, exe, list, connected.length ? connected : list, undefined, ryujinxGuids());
    playerCount[emu] = n;
    return n;
  });
  handle('vpads:status', async () => ({
    installed: await require('./vpads').busInstalled(), on: !!lib.settings.steadyPlayers, learned: !!lib.settings.vpadGuid,
    running: !!(vp && vp.running), players: vp ? vp.players : [], ryujinx: !!((lib.platforms.ryujinx || {}).exe)
  }));
  handle('vpads:install', async () => require('./vpads').installBus());
  // Try them out (Settings): one virtual controller per saved player, until stopped.
  handle('vpads:test', async (slots) => {
    if (running) throw new Error('Close the game first');
    if (!vpadsPart()) throw new Error('Only on Windows');
    const list = (Array.isArray(slots) ? slots : []).map((n) => (Number.isInteger(n) && n >= 0 && n <= 3 ? n : null)).slice(0, 4);
    const r = await vp.start(list.length ? list : [null]);
    if (!r || !r.ok) throw new Error((r && r.error) || 'Didn’t start');
    return r.players;
  });
  handle('vpads:stop', () => { stopSteady(); return true; });

  // Phone remote (Settings › Controllers): a small web page your phone opens on the home network.
  const phoneMod = require('./phoneremote');
  const phone = phoneMod.createPhoneRemote({
    token: () => {
      if (!/^[0-9a-f]{32}$/.test(lib.settings.remoteToken || '')) { lib.settings.remoteToken = phoneMod.newToken(); persist(); }
      return lib.settings.remoteToken;
    },
    state: () => {
      const g = running && lib.games.find((x) => x.id === running.gameId);
      return { playing: running ? (g ? g.title : 'a game') : null, guide: overlayShown() };
    },
    games: () => lib.games.filter((g) => !g.hidden).slice().sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0))
      .map((g) => ({ id: g.id, title: g.title, platform: (g.launch && (g.launch.emu || g.launch.type)) || '', art: (g.art && (g.art.tile || g.art.hero)) || null })),
    onButton: (b) => {
      if (b === 'HOME') { guidePressed(); return { ok: true }; }
      if (overlayShown()) { sendOverlay('phone', { b }); return { ok: true }; }
      if (tvPart && tvPart.playing) return { ok: true, note: 'Press Guide to control what’s playing' };
      if (yt && yt.isShown() && yt.isFront && yt.isFront()) return { ok: true, note: 'Press Guide to control YouTube' };
      if (running && (!win || win.isMinimized() || !win.isFocused())) return { ok: true, note: 'In a game: press Guide to open the guide' };
      if (!win || win.isDestroyed()) return { ok: false, error: 'The launcher isn’t open' };
      if (win.isMinimized()) win.restore();
      send('phone', { b });
      return { ok: true };
    },
    // The PC's sound (the output in use), like the guide's volume.
    volume: async () => { const a = await audio().state(); return { volume: a.volume, muted: a.muted, output: a.current ? a.current.label || a.current.name || '' : '' }; },
    setVolume: async (q) => {
      let a = null;
      if (typeof q.mute === 'boolean') a = await audio().setMute(q.mute);
      if (typeof q.v === 'number' || typeof q.step === 'number') {
        let v = q.v;
        if (typeof v !== 'number') { const cur = await audio().state(); v = Math.max(0, Math.min(100, (cur.volume < 0 ? 50 : cur.volume) + q.step)); }
        a = await audio().setVolume(v);
        if (a.muted && v > 0 && typeof q.mute !== 'boolean') a = await audio().setMute(false);
      }
      return { volume: a ? a.volume : -1, muted: !!(a && a.muted) };
    },
    onText: (t, enter) => {
      const to = overlayShown() ? 'overlay' : 'win';
      if (to === 'overlay') sendOverlay('phone', { text: t, enter }); else send('phone', { text: t, enter });
      return { ok: true };
    },
    onLaunch: (id) => {
      // Apps (Movies & TV, YouTube): opened like from the guide, so they work during a game too.
      if (id === 'app:tv' || id === 'app:youtube') {
        const target = id.slice(4);
        if (tvPart && tvPart.playing && target !== 'tv') tvPart.stop('guide');
        if (ytGuide) { ytGuide = false; if (yt) yt.hide(); }
        hideOverlay();
        bringBack(false);
        send('remote', { action: 'goto', id: null, target, friend: null });
        return { ok: true };
      }
      const g = lib.games.find((x) => x.id === id);
      if (!g) return { ok: false, error: 'That game isn’t in your library' };
      if (running) return { ok: false, error: 'A game is already running. Close it from the guide first.' };
      if (tvPart && tvPart.playing) tvPart.stop('phone');
      if (yt && yt.isShown()) yt.hide();
      hideOverlay();
      bringBack(false);
      send('phone', { launch: id });
      return { ok: true };
    }
  });
  function syncPhone() {
    if (lib.settings.phoneRemote && !phone.running) phone.start().catch((e) => { console.warn('phone remote: ' + (e && e.message)); });
    if (!lib.settings.phoneRemote && phone.running) phone.stop();
  }
  handle('phone:info', async () => {
    if (lib.settings.phoneRemote && !phone.running) { try { await phone.start(); } catch (_) { /* answered below */ } }
    return { on: !!lib.settings.phoneRemote, running: phone.running, url: phone.url(), address: phoneMod.lanAddress() };
  });
  handle('phone:set', async (on) => {
    lib.settings.phoneRemote = !!on; persist();
    if (on) await phone.start(); else phone.stop();
    return { on: !!on, running: phone.running, url: phone.url(), address: phoneMod.lanAddress() };
  });
  handle('phone:newLink', () => {
    lib.settings.remoteToken = phoneMod.newToken(); persist();
    return { on: !!lib.settings.phoneRemote, running: phone.running, url: phone.url(), address: phoneMod.lanAddress() };
  });
  // Teaching the launcher what Ryujinx calls the virtual controllers: while they're plugged in,
  // you pick one as Player 1 in Ryujinx and save; this reads it back.
  handle('vpads:learn', () => {
    const exe = (lib.platforms.ryujinx || {}).exe;
    const f = players.ryujinxConfigPath(exe);
    if (!f) throw new Error('Ryujinx settings not found (start Ryujinx once first)');
    const g = players.ryujinxPlayer1Guid(f);
    if (!g) throw new Error('Player 1 in Ryujinx isn’t a controller yet');
    if (g === lib.settings.ryujinxRealGuid) throw new Error('Player 1 is still your own controller. Pick the new one, save, then try again.');
    lib.settings.vpadGuid = g;
    persist();
    return true;
  });
  // One controller: make sure it's Player 1 (only once you've used "Who's playing?" for that
  // emulator, so settings you never asked the launcher to touch stay as they are).
  handle('players:solo', (gameId) => {
    if (MAC) return false;
    const { emu, exe } = emuOf(gameId);
    const connected = readPads().map((p) => p.slot);
    if (connected.length !== 1) return false;
    const f = emu === 'ryujinx' ? players.ryujinxConfigPath(exe) : emu === 'rpcs3' ? players.rpcs3InputFile(exe)
      : (players.dolphinUserDir(exe) ? path.join(players.dolphinUserDir(exe), 'Config', 'GCPadNew.ini') : null);
    if (!f || !fs.existsSync(f + '.couch-original')) return false;
    try { players.setPlayers(emu, exe, connected, connected, undefined, ryujinxGuids()); playerCount[emu] = 1; return true; } catch (_) { return false; }
  });

  // Windows notification (shows over games too) plus a toast in the launcher.
  function notify(title, body, onClick, extra) {
    try {
      if (Notification.isSupported()) {
        const n = new Notification({ title, body, silent: false });
        if (onClick) n.on('click', () => { try { onClick(); } catch (_) { /* ignore */ } });
        n.show();
      }
    } catch (_) { /* not available */ }
    send('notice', Object.assign({ title, body }, extra || {}));
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
  // A game's TV settings › "Make it the main monitor while playing": games that only open on the
  // main display open on the chosen one, which becomes the main one until the game ends. What to put
  // back is saved in a file first, so a crash or power cut can't leave it switched.
  const layoutFile = () => path.join(app.getPath('userData'), 'display-layout.json');
  // On for this game (its TV settings), or for every game (Settings › Display) unless turned off for it.
  const mainWhilePlaying = (g) => (g && g.display && typeof g.display.main === 'boolean' ? g.display.main : !!(lib && lib.settings.mainWhilePlaying));
  function switchPrimaryFor(r, g) {
    if (!dsp() || !r || !lib.settings.displayId || !mainWhilePlaying(g)) return; // only where it's turned on
    try {
      const dev = displayDevice();
      if (!dev || (dev.x === 0 && dev.y === 0)) return; // already the main display
      const saved = { layout: dsp().layout(), primary: dsp().primaryName() };
      fs.writeFileSync(layoutFile(), JSON.stringify(saved));
      if (dsp().makePrimary(dev.name)) r.layoutRestore = saved;
      else fs.unlinkSync(layoutFile());
    } catch (e) { try { fs.unlinkSync(layoutFile()); } catch (_) { /* none */ } send('notice', { title: 'Couldn’t switch the main display: ' + String(e.message || e) }); }
  }
  function restorePrimary(r) {
    let saved = r && r.layoutRestore;
    if (r) r.layoutRestore = null;
    if (!saved) { try { saved = JSON.parse(fs.readFileSync(layoutFile(), 'utf8')); } catch (_) { return; } }
    try { if (dsp()) dsp().restoreLayout(saved); } catch (_) { /* tried; the file stays for the next start */ return; }
    try { fs.unlinkSync(layoutFile()); } catch (_) { /* gone */ }
  }
  function applyDisplay(r, g) {
    switchPrimaryFor(r, g);
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
    if (x && dsp()) {
      r.dispRestore = null;
      try { if (x.mode) dsp().restoreMode(x.name); } catch (_) { /* fine */ }
      try { if (typeof x.hdr === 'boolean') dsp().setHdr(x.name, x.hdr); } catch (_) { /* fine */ }
    }
    const hadLayout = !!(r && r.layoutRestore);
    if (hadLayout) restorePrimary(r);
    if (x || hadLayout) setTimeout(placeWindows, 800);
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
  const T0 = Date.now();
  const trace = (...x) => { if (process.env.COUCH_SELFTEST && selftestLog.length < 400) selftestLog.push(['main', Date.now() - T0].concat(x)); };
  function handle(ch, fn) {
    return ipcMain.handle(ch, async (_e, ...args) => {
      const t = Date.now();
      try { const value = await fn(...args); if (process.env.COUCH_SELFTEST) trace('ipc', ch, Date.now() - t); return { ok: true, value }; } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
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
    if (MAC) return out; // Mac apps update themselves (or from their own sites)
    const ids = Object.keys(scanners.EMULATORS).filter((id) => lib.platforms[id] && lib.platforms[id].exe);
    await Promise.all(ids.map(async (id) => { try { out[id] = await eu().check(id, lib.platforms[id]); } catch (e) { out[id] = { status: 'error', error: e.message }; } }));
    return out;
  });
  handle('emu:update', async (id) => {
    id = String(id || '');
    const cfg = lib.platforms[id];
    if (!cfg || !cfg.exe) throw new Error('Set up this emulator first');
    if (running && running.emu === id) throw new Error('Close the game first');
    if (MAC) throw new Error('On a Mac, update emulators from their own sites');
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
  handle('xbox:friends', () => friendsOf('xbox'));
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
  // Settings the app core keeps itself (the screens' copy of them can be out of date): kept as
  // they are when the screens save. (Saving used to put an old empty mpv path back, so mpv had to
  // be chosen again after a restart.)
  const CORE_SETTINGS = ['mpvPath', 'ytAgent', 'ytAgent2', 'emuAutoDone', 'xboxShareMap', 'vpadGuid', 'ryujinxRealGuid', 'phoneRemote', 'remoteToken', 'cableSubs'];
  handle('lib:save', (data) => {
    const next = library.normalize(data);
    for (const k of CORE_SETTINGS) if (lib && lib.settings && lib.settings[k] !== undefined) next.settings[k] = lib.settings[k];
    // Delete art files that no game uses any more.
    const used = new Set();
    for (const g of next.games) for (const k of Object.keys(g.art || {})) if (g.art[k]) used.add(path.resolve(g.art[k]));
    if (next.settings.avatar) used.add(path.resolve(next.settings.avatar));
    if (next.settings.customBg) used.add(path.resolve(next.settings.customBg));
    lib = next;
    persist();
    syncAppearance();
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
    const o = opts && typeof opts === 'object' ? { resume: !!opts.resume } : {};
    if (opts && opts.join) {
      // Only a Steam join link for the friend's game, and only when this is that game.
      const f = fr().get(opts.join);
      const url = f && friendsLib.joinUrl(f);
      if (!url || friendsLib.matchGame(f, lib.games) !== gameId) throw new Error('That game can’t be joined any more');
      o.joinUrl = url;
    }
    return launchGame(gameId, o);
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
  handle('steam:friends', () => friendsOf('steam'));
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
  // ---------- Free games and deals (Home) ----------
  let dealsMod = null;
  const dl = () => dealsMod || (dealsMod = dealsLib.createDeals({ userDataDir: app.getPath('userData'), country: (app.getLocaleCountryCode && app.getLocaleCountryCode()) || 'US' }));
  // What's on Home, with the games you already have marked (and taken out of the deals).
  function dealsView() {
    const v = dl().view();
    const apps = new Set(), names = new Set();
    for (const g of lib.games) {
      if (g.hidden) continue;
      const a = friendsLib.steamAppOf(g); if (a) apps.add(a);
      names.add(dealsLib.normTitle(g.title));
    }
    const own = (x) => !!((x.steamAppID && apps.has(x.steamAppID)) || names.has(dealsLib.normTitle(x.title)));
    v.free = v.free.map((x) => Object.assign(x, { owned: own(x) }));
    v.deals = v.deals.filter((x) => !own(x)).slice(0, 16);
    return v;
  }
  const hasEpic = () => { try { return !!(app.getApplicationNameForProtocol && app.getApplicationNameForProtocol('com.epicgames.launcher://')); } catch (_) { return false; } };
  async function openDeal(item) {
    const url = dealsLib.openUrl(item, hasEpic());
    if (!url) throw new Error('No store page for that one');
    hideOverlay();
    if (w32) w32.allowForeground();
    await shell.openExternal(url);
    if (url.startsWith('com.epicgames.launcher:')) openedApps.set('epic', { exes: ['epicgameslauncher.exe'], title: 'Epic Games', stop: presentApp(['epicgameslauncher.exe'], 'Epic Games', 30000) });
    else placeNextWindow(10000);
    return true;
  }
  const watchedItem = (gameID) => { const w = dl().watched().find((x) => x.gameID === String(gameID)); return w ? Object.assign({}, w, w.now || {}, { steamAppID: w.steamAppID }) : null; };
  handle('deals:get', async (force) => {
    try { await dl().get(!!force); } catch (e) { if (!dl().view().at) throw e; }
    return dealsView();
  });
  handle('deals:open', (id) => {
    id = String(id || '');
    const item = id.startsWith('w:') ? watchedItem(id.slice(2)) : dl().find(id);
    if (!item) throw new Error('That deal isn’t there any more');
    return openDeal(item);
  });
  handle('deals:watch', (id) => { const it = dl().find(String(id || '')); if (!it || !it.gameID) throw new Error('That game can’t be watched'); dl().watch(it); return dealsView(); });
  handle('deals:unwatch', (gameID) => { dl().unwatch(String(gameID || '')); return dealsView(); });
  function startDealsWatch() {
    const money = (n) => '$' + Number(n).toFixed(2);
    const tick = async () => {
      if (lib.settings.showDeals === false && lib.settings.notifyFree === false && !dl().watched().length) return;
      try { await dl().get(false); } catch (_) { return; } // offline: next time
      for (const f of dl().newFree()) {
        const owned = dealsView().free.find((x) => x.id === f.id && x.owned);
        if (owned || lib.settings.notifyFree === false) continue;
        notify('Free to keep: ' + f.title, f.store + (f.until ? ' · until ' + new Date(f.until).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : ''), () => { openDeal(f).catch(() => {}); });
      }
      try {
        for (const w of await dl().checkWatch(false)) {
          if (lib.settings.notifyPrice === false) continue;
          notify('Price drop: ' + w.title, money(w.now.price) + ' at ' + w.now.store + ' (was ' + money(w.was) + ')', () => { openDeal(watchedItem(w.gameID)).catch(() => {}); });
        }
      } catch (_) { /* next time */ }
      send('deals', dealsView());
    };
    setTimeout(tick, 15000);
    setInterval(tick, 30 * 60 * 1000); // fetches only every few hours
  }
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
  // A clip or screenshot inside Medal's folder (nothing else is ever shown or deleted).
  function clipFile(file) {
    const folder = clipsFolder();
    const f = path.resolve(String(file || ''));
    if (!folder || !f.toLowerCase().startsWith(path.resolve(folder).toLowerCase() + path.sep) || !/\.(mp4|mkv|webm|mov|png|jpe?g)$/i.test(f) || !fs.existsSync(f)) throw new Error('Clip not found');
    return f;
  }
  // Deleted clips go to the Recycle Bin, so they can still be brought back.
  handle('clips:delete', async (file) => {
    const f = clipFile(file);
    try { await shell.trashItem(f); } catch (e) { throw new Error('Windows couldn’t delete that clip' + (/busy|use|EBUSY|EPERM/i.test(String(e && e.message)) ? ' (Medal or another app has it open)' : '')); }
    return true;
  });
  handle('clips:show', (file) => {
    const f = clipFile(file);
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

  // ---------- Sound output (guide › Profile & system › Sound) ----------
  let audioMod = null;
  const audio = () => audioMod || (audioMod = require('./audio').createAudio(app.getPath('userData')));
  handle('audio:state', () => audio().state());
  handle('audio:output', (id) => audio().setOutput(String(id || '')));
  handle('audio:volume', (v) => audio().setVolume(Number(v)));
  handle('audio:mute', (on) => audio().setMute(!!on));

  // ---------- Playtime stats ----------
  let statsMod = null;
  function statsPart() { return statsMod || (statsMod = require('./stats').createStats({ userDataDir: app.getPath('userData') })); }
  handle('stats:get', () => statsPart().get(lib.games.filter((g) => !g.hidden)));

  // ---------- Friends: join, play the same game, profiles, played with recently ----------
  let friendsPart = null;
  const fr = () => friendsPart || (friendsPart = friendsLib.createFriends({ userDataDir: app.getPath('userData') }));
  const friendsAt = { xbox: 0, steam: 0 };
  async function friendsOf(svc) {
    const mod = svc === 'steam' ? st() : xb();
    const list = friendsLib.decorate(await mod.friends(), lib.games);
    fr().remember(list);
    friendsAt[svc] = Date.now();
    return list;
  }
  const friendIn = (id) => fr().get(id) || null;
  // Steam: "Join". Your copy of their game starts straight into their lobby; when that game is
  // already running (or you don't have it in the launcher) Steam's join link is opened as is.
  function joinDirect(id) {
    const f = friendIn(id);
    const url = f && friendsLib.joinUrl(f);
    if (!url) throw new Error('That game can’t be joined any more');
    hideOverlay();
    return shell.openExternal(url).then(() => true);
  }
  function joinFromAlert(f) {
    const owned = friendsLib.matchGame(f, lib.games);
    if (!owned || (running && running.gameId === owned)) return joinDirect(f.id).catch(() => {});
    bringBack(false);
    send('remote', { action: 'join', id: owned, friend: f.id, target: null });
  }
  handle('friend:join', (id) => joinDirect(String(id || '')));
  handle('friend:store', (id, what) => {
    let url = null;
    if (what && what.appid != null) url = /^\d{1,10}$/.test(String(what.appid)) ? 'steam://store/' + what.appid : null;
    else if (what && what.title) url = 'ms-windows-store://search/?query=' + encodeURIComponent(String(what.title).slice(0, 100));
    else url = friendsLib.storeUrl(friendIn(String(id || '')));
    if (!url) throw new Error('No store page for that game');
    hideOverlay();
    return shell.openExternal(url).then(() => { placeNextWindow(10000); return true; });
  });
  handle('friend:profile', async (id) => {
    id = String(id || '');
    const steamid = friendsLib.steamIdOf({ xuid: id });
    const cur = friendIn(id);
    const p = steamid ? await st().profile(steamid) : await xb().friendProfile(id, cur);
    if (cur && !steamid) { p.online = cur.online; p.status = cur.status; p.game = cur.game; p.favorite = cur.favorite; }
    const svc = steamid ? 'steam' : 'xbox';
    const deco = friendsLib.decorate([Object.assign({}, cur || {}, p, { xuid: steamid ? 'steam-' + steamid : id, service: svc })], lib.games)[0];
    deco.recent = (p.recent || []).map((r) => Object.assign(r, { owned: friendsLib.matchGame({ service: svc, gameid: r.appid, game: r.title }, lib.games) }));
    deco.together = fr().withFriend(id).map((x) => { const g = lib.games.find((y) => y.id === x.gameId); return g ? { gameId: x.gameId, title: g.title, last: x.last, mins: x.mins } : null; }).filter(Boolean).slice(0, 6);
    // Games you both have (theirs matched against your library), the ones they play most first.
    const seenIds = new Set(), common = [], byApp = new Map(), byName = new Map();
    for (const g of lib.games) {
      if (g.hidden) continue;
      const a = friendsLib.steamAppOf(g); if (a && !byApp.has(a)) byApp.set(a, g.id);
      const n = friendsLib.norm(g.title); if (n.length >= 2 && !byName.has(n)) byName.set(n, g.id);
    }
    for (const o of (p.ownedList || []).slice().sort((a, b) => (b.hours || b.last || 0) - (a.hours || a.last || 0))) {
      const gid = (o.appid && byApp.get(o.appid)) || byName.get(friendsLib.norm(o.title));
      if (!gid || seenIds.has(gid)) continue;
      seenIds.add(gid);
      const g = lib.games.find((y) => y.id === gid);
      common.push({ gameId: gid, title: g.title, hours: o.hours != null ? o.hours : null, pct: o.pct != null ? o.pct : null, art: (g.art && (g.art.tile || g.art.hero)) || null });
    }
    deco.commonCount = common.length;
    deco.common = common.slice(0, 12);
    delete deco.ownedList;
    deco.art = (p.art || []).filter((u) => /^https:\/\//.test(u)).slice(0, 2);
    return deco;
  });
  handle('friend:compare', (id, appid) => {
    const steamid = friendsLib.steamIdOf({ xuid: String(id || '') });
    return steamid ? st().compare(steamid, String(appid || '')) : null;
  });
  handle('friend:playedWith', (gameId) => fr().playedWith(String(gameId || '')));
  handle('friend:recent', () => fr().recent(20).map((p) => Object.assign(p, {
    games: p.games.map((x) => { const g = lib.games.find((y) => y.id === x.gameId); return g ? { gameId: x.gameId, title: g.title, last: x.last } : null; }).filter(Boolean)
  })).filter((p) => p.games.length));
  handle('friend:joinable', () => friendsLib.decorate(fr().recentJoinable(), lib.games));
  // Friends in a game right now (Home's "Friends playing" row). Lists are at most a minute old.
  handle('friend:playing', async () => {
    const out = [];
    for (const svc of ['xbox', 'steam']) {
      const mod = svc === 'steam' ? st() : xb();
      if (!mod.connected()) continue;
      let list = null;
      // xbl.io's free plan allows about 150 requests an hour, so Xbox lists are reused longer.
      if (Date.now() - friendsAt[svc] > (svc === 'xbox' ? 150000 : 60000)) { try { list = await friendsOf(svc); } catch (_) { list = null; } }
      if (!list) list = fr().all(svc);
      out.push(...list.filter((f) => f.online && (f.game || f.gameid)));
    }
    return out.sort((a, b) => (b.joinable - a.joinable) || (!!b.owned - !!a.owned) || (b.favorite - a.favorite) || a.gamertag.localeCompare(b.gamertag));
  });

  // ---------- Alerts: friends coming online, people joining / leaving your Discord call ----------
  function startAlerts() {
    const seen = { xbox: null, steam: null };
    const friendId = (f) => f.xuid || f.steamid || f.id || f.gamertag;
    let recordedAt = 0;
    async function friendsCheck() {
      const fresh = [], joinNow = [];
      // While you play: who's in the same game (for "Played with recently").
      const g = running && !running.cancelled && lib.games.find((x) => x.id === running.gameId);
      const mins = g ? Math.min(5, Math.max(1, Math.round((Date.now() - Math.max(recordedAt, running.startedAt || 0)) / 60000))) : 0;
      for (const [svc, mod] of [['xbox', xb], ['steam', st]]) {
        let list = null;
        try { if (mod().connected()) list = await friendsOf(svc); } catch (_) { list = null; }
        if (!list) continue;
        if (g) fr().record(g.id, g, list, mins);
        joinNow.push(...fr().newlyJoinable(svc, list));
        const online = new Set(list.filter((f) => f.online).map(friendId));
        // The first check only learns who's online; after that, newcomers get a heads-up.
        if (seen[svc]) for (const f of list) if (f.online && !seen[svc].has(friendId(f))) fresh.push(f);
        seen[svc] = online;
      }
      if (g) recordedAt = Date.now();
      // Someone started a game you can join (Steam lobbies / servers).
      if (lib.settings.notifyJoin !== false) {
        for (const f of joinNow.slice(0, 2)) {
          const have = friendsLib.matchGame(f, lib.games);
          notify(f.gamertag + ' is in a game you can join', (f.game || 'Steam game') + (have ? ' · Click to join, or open the guide › Friends' : ' · Click to join through Steam'), () => joinFromAlert(f), { join: f.id });
        }
        const shown = new Set(joinNow.map((f) => f.id));
        for (let i = fresh.length - 1; i >= 0; i--) if (shown.has(fresh[i].id)) fresh.splice(i, 1); // one alert per person
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
    setInterval(friendsCheck, 2 * 60 * 1000);
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
  const pgrep = (name) => new Promise((resolve) => execFile('/usr/bin/pgrep', ['-x', name], (err) => resolve(!err)));
  handle('media:running', async () => {
    if (MAC) return { 'Apple Music': await pgrep('Music'), Spotify: await pgrep('Spotify') };
    const list = process.platform === 'win32' ? await tasklist() : '';
    return { 'Apple Music': list.includes('"applemusic.exe"'), Spotify: list.includes('"spotify.exe"') };
  });
  // Closes a music app: politely first, then for sure (music apps lose nothing by closing).
  handle('media:close', async (appName) => {
    const exe = MUSIC_EXE[appName];
    if (MAC && exe) { await new Promise((r) => execFile('/usr/bin/osascript', ['-e', 'tell application "' + (appName === 'Spotify' ? 'Spotify' : 'Music') + '" to quit'], { timeout: 8000 }, () => r())); return true; }
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
    if (MAC) { wantFront = false; execFile('/usr/bin/open', ['-a', cfg.exe], () => {}); return true; }
    const child = spawn(cfg.exe, [], { cwd: path.dirname(cfg.exe), detached: true, stdio: 'ignore' });
    child.unref();
    presentApp([path.basename(cfg.exe).toLowerCase()], scanners.EMULATORS[id].name, 15000);
    return true;
  });
  handle('game:status', () => (running ? { gameId: running.gameId, canClose: canClose(), seen: !!(running.child || running.seen), protected: !!running.protected } : null));
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
  // Guide › Stop watching
  // Guide › Close YouTube (it's kept, so opening it again carries on)
  handle('yt:guideClose', () => { ytGuide = false; hideOverlay(false); if (yt) yt.hide(); bringBack(false); return true; });
  handle('tv:guideStop', () => { if (tvPart && tvPart.playing) tvPart.stop('back'); hideOverlay(false); return true; });
  // Steam Big Picture (made for controllers), then a Steam page in it.
  async function openBigPicture(then) {
    await shell.openExternal('steam://open/bigpicture');
    if (then) setTimeout(() => { shell.openExternal(then).catch(() => {}); }, 2500);
    const entry = { exes: ['steam.exe'], title: 'Steam Big Picture', stop: null };
    openedApps.set('steam-bp', entry);
    setTimeout(() => { if (openedApps.get('steam-bp') === entry) entry.stop = presentApp(['steam.exe'], 'Steam', 20000); }, 1500);
    return true;
  }
  // Steam games you own that aren't on this PC (Library › Not installed). Install opens
  // Steam's own install screen in Big Picture; the game then shows up with its download progress.
  handle('steam:notInstalled', async (force) => {
    if (!st().connected()) return { connected: false, list: [] };
    const owned = await st().owned(!!force);
    const have = new Set(lib.games.map((g) => friendsLib.steamAppOf(g)).filter(Boolean));
    for (const d of downloads) have.add(String(d.appid));
    return { connected: true, list: owned.filter((g) => !have.has(g.appid)) };
  });
  handle('steam:install', async (appid) => {
    appid = String(appid || '');
    if (!/^\d{1,10}$/.test(appid) || !(await st().owned(false)).some((g) => g.appid === appid)) throw new Error('That game isn’t in your Steam library');
    hideOverlay();
    if (w32) w32.allowForeground();
    return openBigPicture('steam://install/' + appid);
  });
  // Stores, opened the controller-friendly way where there is one (Steam: Big Picture).
  handle('store:open', async (id) => {
    hideOverlay();
    if (w32) w32.allowForeground();
    if (id === 'steam') return openBigPicture('steam://store');
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
    if (MAC) {
      const home = process.env.HOME || '';
      const installed = ['Discord', 'Discord PTB', 'Discord Canary'].some((d) => fs.existsSync('/Applications/' + d + '.app') || fs.existsSync(path.join(home, 'Applications', d + '.app')));
      return new Promise((resolve) => execFile('/usr/bin/pgrep', ['-x', 'Discord'], { timeout: 4000 }, (err, out) => resolve({ installed, running: !err && !!String(out || '').trim() })));
    }
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
    if (!w32) throw new Error(MAC ? 'On a Mac, connect Discord (in this card) to mute and deafen from here' : 'Needs Windows');
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
    const allowed = ['switch', 'close', 'goto', 'join'];
    if (!req || !allowed.includes(req.action)) throw new Error('Unknown action');
    if (req.target === 'home' && running) releaseBoot(running);
    if (tvPart && tvPart.playing) tvPart.stop('guide'); // going somewhere in the launcher: stop watching (your spot is saved)
    if (ytGuide) { ytGuide = false; if (yt) yt.hide(); } // and YouTube steps aside (it stays paused)
    hideOverlay();
    bringBack(false);
    send('remote', { action: req.action, id: req.id ? String(req.id) : null, target: req.target ? String(req.target) : null, friend: req.friend ? String(req.friend) : null });
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
      if (MAC) places.unshift({ name: 'Applications', path: '/Applications', isDir: true, place: true });
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
      // Mac apps (Name.app) are folders, but they're the program you pick.
      if (MAC && isDir && /\.app$/i.test(e.name) && want && (want.has('.exe') || want.has('.app'))) isDir = false;
      else if (!isDir && want && !want.has(path.extname(e.name).toLowerCase()) && !(MAC && want.has('.exe') && path.extname(e.name) === '')) continue;
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
  // Settings › Display › Full screen (and the Mac's app menu): restarts the launcher to switch.
  handle('app:setWindowed', (on) => { setWindowed(!!on); return true; });
  function setWindowed(on) {
    lib.settings.windowed = on; persist();
    setTimeout(() => { app.relaunch(); app.quit(); }, 400);
  }
  handle('app:info', () => ({
    platform: process.platform,
    version: VERSION,
    updateFailed: global.couchUpdateFailed || null,
    windowed: WINDOWED,
    hotkey: controller.available,
    guideButton: controller.available && controller.guide,
    guideError: MAC ? (controller.error || (controller.macDebug && controller.macDebug().error) || null) : null,
    autostart: process.platform === 'win32' || MAC ? app.getLoginItemSettings(loginOpts()).openAtLogin : null,
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
    if (MAC) {
      // Sleep needs no permission; restart / shut down ask macOS once (System Events).
      if (action === 'sleep') execFile('/usr/bin/pmset', ['sleepnow'], () => {});
      else if (action === 'restart' || action === 'shutdown') execFile('/usr/bin/osascript', ['-e', 'tell application "System Events" to ' + (action === 'restart' ? 'restart' : 'shut down')], () => {});
      else return false;
      return true;
    }
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
  // What happened last time, per emulator (shown in Settings › Saves).
  const backupLast = {};
  async function backupNow(id, why) {
    let r;
    try { r = await backups.backup(id, saveSources(id), why); } catch (e) { r = { error: String(e && e.message || e) }; }
    backupLast[id] = Object.assign({ at: Date.now(), why }, r);
    return r;
  }
  function afterGameBackup(id) { backupNow(id, 'after').catch(() => null); }
  const emuIds = () => Object.keys(scanners.EMULATORS).filter((id) => lib.platforms[id] && lib.platforms[id].exe);
  handle('backup:status', () => ({
    to: lib.settings.backupTo || 'off', folder: lib.settings.backupFolder || '', keep: Number(lib.settings.backupKeep) || 10,
    root: backupRoot(), dests: bkup.destinations(process.env, allDrives()),
    emus: emuIds().map((id) => { const snaps = backups.snapshots(id); return { id, name: scanners.EMULATORS[id].name, sources: saveSources(id), last: snaps[0] ? snaps[0].at : 0, count: snaps.length, result: backupLast[id] || null }; })
  }));
  handle('backup:now', async (id) => {
    if (!backupRoot()) throw new Error('Choose where backups go first');
    const ids = id ? [String(id)] : emuIds();
    let done = 0;
    const results = [];
    for (const x of ids) { const r = await backupNow(x, 'manual').catch((e) => ({ error: String(e && e.message || e) })); if (r && r.done) done++; results.push({ id: x, name: scanners.EMULATORS[x] ? scanners.EMULATORS[x].name : x, result: r }); }
    return { done, of: ids.length, results };
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
    syncAppearance();
    // First run: turn on start-with-Windows (only for the installed app).
    if (!fs.existsSync(libFile())) {
      if (app.isPackaged && lib.settings.autostart) {
        try { app.setLoginItemSettings({ openAtLogin: true }); } catch (_) { /* ignore */ }
      }
      persist();
    }
    // 1.17: the macOS look (macOS Dark, rounder corners) becomes the look everywhere. Switched once;
    // the earlier themes stay in Settings › Themes.
    if (lib.settings.windowed) WINDOWED = true;
    // A game's main-display switch that never got put back (crash, power cut): put it back now.
    if (fs.existsSync(layoutFile())) restorePrimary(null);
    if (!lib.settings.macLook) { lib.settings.theme = 'macos'; lib.settings.corners = 'squircle'; lib.settings.macLook = true; if (fs.existsSync(libFile())) persist(); }
    createWindow();
    setTimeout(() => { try { createOverlay(); } catch (_) { /* made on first use */ } }, 2000);
    // Monitors plugged in or removed: stay on the chosen one, or fall back to the main one.
    screen.on('display-removed', () => placeWindows());
    screen.on('display-added', () => placeWindows());
    // Only a real change of the screen (size, resolution, scaling, turned). Not its usable area,
    // which changes whenever the menu bar, Dock or taskbar shows or hides.
    screen.on('display-metrics-changed', (_e, _d, changed) => {
      if (Array.isArray(changed) && !changed.some((c) => c === 'bounds' || c === 'scaleFactor' || c === 'rotation')) return;
      // During a game (the chosen monitor may just have become the main one): only the guide moves
      // with it; the launcher is put back in place when the game ends.
      if (running) { setTimeout(() => { if (overlay && !overlay.isDestroyed()) overlay.setBounds(targetDisplay().bounds); }, 300); return; }
      placeWindows();
    });
    controller.start();
    syncPhone();
    padMouse.start();
    startPadWatch();
    setTimeout(startAlerts, 15000);
    startDownloadWatch();
    startAwayWatch();
    syncRawPads(); setInterval(syncRawPads, 5000);
    startNewsWatch();
    startDealsWatch();
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
    // Macs have no Home key: Control+Option+G opens the guide too.
    if (MAC) { try { globalShortcut.register('Control+Alt+G', () => guidePressed()); } catch (_) { /* taken */ } }
    // Build check (COUCH_SELFTEST=<folder>): saves pictures of the launcher and the guide, notes
    // whether the controller reader started, and quits. Used on GitHub's Macs before a release.
    if (process.env.COUCH_SELFTEST) {
      const dir = process.env.COUCH_SELFTEST;
      const snap = (w, name) => (w && !w.isDestroyed() ? w.webContents.capturePage().then((img) => fs.writeFileSync(path.join(dir, name), img.toPNG())).catch((e) => console.log('COUCH_SELFTEST snap ' + name + ': ' + e.message)) : Promise.resolve());
      setTimeout(() => snap(win, 'launcher.png'), 9000);
      // Step aside for whatever is behind (like a game), then open the guide over it.
      setTimeout(() => { if (MAC) { win.hide(); app.hide(); } else if (win) win.minimize(); }, 12000);
      setTimeout(() => showOverlay(), 14000);
      setTimeout(() => snap(overlay, 'guide.png'), 18500);
      const probe = (w) => (w && !w.isDestroyed() ? w.webContents.executeJavaScript("JSON.stringify({ html: document.documentElement.className, top: (document.getElementById('topbar') || {}).innerHTML ? document.getElementById('topbar').innerHTML.length : 0, view: (document.getElementById('view') || {}).innerHTML ? document.getElementById('view').innerHTML.length : 0, layers: document.querySelectorAll('.layer').length, guide: !!document.querySelector('.guide'), font: getComputedStyle(document.body).fontFamily.slice(0, 60), visible: document.visibilityState, stage: window.__stage || null })").catch((e) => 'error: ' + e.message) : Promise.resolve(null));
      let probes = {};
      trace('selftest start');
      // Notes when the app core was too busy to answer (anything over a quarter second).
      let tick = Date.now();
      setInterval(() => { const n = Date.now(); if (n - tick > 250) trace('busy', n - tick); tick = n; }, 50);
      for (const [n, w] of [['launcher', win], ['guide', overlay]]) {
        if (!w || w.isDestroyed()) { trace(n, 'no window'); continue; }
        w.webContents.on('did-finish-load', () => trace(n, 'loaded'));
        w.webContents.on('render-process-gone', (_e, d) => trace(n, 'renderer gone', d && d.reason));
        w.webContents.on('unresponsive', () => trace(n, 'unresponsive'));
        trace(n, 'loading?', w.webContents.isLoading(), 'url', w.webContents.getURL().split('/').slice(-2).join('/'));
      }
      setTimeout(() => { probe(win).then((v) => { probes.launcher = v; }); }, 8500);
      setTimeout(() => { probe(win).then((v) => { probes.launcher2 = v; }); }, 13000);
      setTimeout(() => { probe(overlay).then((v) => { probes.guide = v; }); }, 19000);
      setTimeout(() => {
        let mac = null;
        try { mac = controller.macDebug ? controller.macDebug() : null; } catch (e) { mac = { error: e.message }; }
        try { fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ platform: process.platform, version: VERSION, controller: controller.available, guide: !!controller.guide, error: controller.error || null, mac, overlay: overlayShown(), windows: BrowserWindow.getAllWindows().length, placements: placeCount, probes, console: selftestLog }, null, 1)); } catch (_) { /* reported as missing */ }
        app.quit();
      }, 22000);
    }
  });

  app.on('will-quit', () => { globalShortcut.unregisterAll(); controller.stop(); padMouse.stop(); if (tvPart) tvPart.quit(); if (audioMod) audioMod.stop(); if (rawPads) rawPads.stop(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { pauser.resumeAll(); if (overlay && !overlay.isDestroyed()) overlay.destroy(); if (media) media.stop(); });
}
