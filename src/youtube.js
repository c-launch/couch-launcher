'use strict';
// YouTube as its own app in the launcher: YouTube's TV interface (the one smart TVs and
// consoles use) in a full-screen window on the chosen display.
//  - The window says it's a TV, or youtube.com/tv sends PCs to the normal site. If one way stops
//    working, the next is tried by itself (and the one that works is remembered).
//  - The controller is read by the app core and sent as the TV remote's keys, so it works the
//    same with Xbox and PlayStation pads. The page's own controller reading is switched off so
//    nothing moves twice.
//  - Sign-in and settings stay between sessions (own storage, separate from everything else).
//  - The Xbox / PS button hides it (the video pauses) and brings the launcher back; opening
//    YouTube again picks up right where you were.

const path = require('path');
const TV_URL = 'https://www.youtube.com/tv';
const AGENTS = [
  // A TV running YouTube's own TV app engine
  'Mozilla/5.0 (Linux armeabi-v7a; Android 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Cobalt/25.lts.30.1034943-gold (unlike Gecko) v8/8.8.278.17-jit gles Starboard/15, CouchLauncher_TV_PC_2026/1.0 (CouchLauncher, PC, Wired)',
  // A smart TV browser
  'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 76.0.3809.146/6.0 TV Safari/537.36',
  // A games console
  'Mozilla/5.0 (PS4; Leanback Shell) Gecko/20100101 Firefox/65.0 LeanbackShell/01.00.01.75 Sony PS4/ (PS4, , no, CH)'
];
const BIT = { UP: 0x1, DOWN: 0x2, LEFT: 0x4, RIGHT: 0x8, START: 0x10, BACK: 0x20, LB: 0x100, RB: 0x200, A: 0x1000, B: 0x2000, X: 0x4000, Y: 0x8000 };
const KEYS = { A: 'Enter', B: 'Escape', X: 'MediaPlayPause', START: 'MediaPlayPause' };
const STICK = 16000, FIRST = 380, REPEAT = 120;

// Runs inside YouTube's page: no controller reading of its own, no mouse pointer.
const PAGE_SETUP = `(() => {
  try { Object.defineProperty(Navigator.prototype, 'getGamepads', { value: () => [], configurable: true }); } catch (_) {}
  try { const s = document.createElement('style'); s.textContent = '*{cursor:none!important}'; (document.head || document.documentElement).appendChild(s); } catch (_) {}
})();`;

function createYouTube({ BrowserWindow, session, targetDisplay, bringBack, settings, saveSettings, now }) {
  now = now || Date.now;
  let win = null;
  let madeWithAds = null, replacing = false;
  const blockAds = () => settings().ytAdblock !== false;
  let agent = null; // read from settings when YouTube first opens (they aren't loaded yet at startup)
  let triedAll = false;
  let prev = 0, held = null;

  const alive = () => !!(win && !win.isDestroyed());
  function create() {
    if (agent == null) agent = Math.max(0, Math.min(AGENTS.length - 1, Number(settings().ytAgent) || 0));
    const b = targetDisplay().bounds;
    win = new BrowserWindow({
      x: b.x, y: b.y, width: b.width, height: b.height, show: false, frame: false, fullscreen: true, backgroundColor: '#000000',
      autoHideMenuBar: true, title: 'YouTube',
      webPreferences: {
        partition: 'persist:youtube', contextIsolation: true, nodeIntegration: false, sandbox: true,
        // Ad blocker (adapted from VacuumTube, MIT License), put into the page before YouTube runs.
        preload: path.join(__dirname, 'ytpreload.js'), additionalArguments: [blockAds() ? '--couch-adblock=1' : '--couch-adblock=0'],
        backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required'
      }
    });
    madeWithAds = blockAds();
    const wc = win.webContents;
    wc.setUserAgent(AGENTS[agent]);
    // Stay on YouTube; anything else (help pages etc.) is refused.
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e, url) => { if (!/^https:\/\/([a-z0-9-]+\.)*(youtube\.com|google\.com|googleusercontent\.com|gstatic\.com)\//i.test(url)) e.preventDefault(); });
    wc.on('dom-ready', () => { wc.executeJavaScript(PAGE_SETUP, true).catch(() => {}); });
    // Sent to the normal site? That way of saying "TV" doesn't work any more: try the next.
    wc.on('did-navigate', (_e, url) => {
      if (/^https:\/\/(www\.|m\.)?youtube\.com\//i.test(url) && !/^https:\/\/www\.youtube\.com\/tv/i.test(url)) {
        if (agent < AGENTS.length - 1) { agent++; wc.setUserAgent(AGENTS[agent]); wc.loadURL(TV_URL); }
        else if (!triedAll) { triedAll = true; agent = 0; wc.setUserAgent(AGENTS[agent]); }
      } else if (/youtube\.com\/tv/i.test(url) && Number(settings().ytAgent || 0) !== agent) { settings().ytAgent = agent; saveSettings(); }
    });
    win.once('ready-to-show', () => { if (alive()) { win.show(); win.focus(); } });
    // YouTube's own "Exit" (B on its home screen) closes the window: back to the launcher.
    win.on('closed', () => { win = null; if (!replacing) bringBack(false); });
    win.loadURL(TV_URL);
  }
  function open() {
    // The ad blocker setting changed since this window was made: start it fresh.
    if (alive() && madeWithAds !== blockAds()) { replacing = true; win.destroy(); replacing = false; }
    if (!alive()) { create(); return true; }
    const b = targetDisplay().bounds;
    if (win.isFullScreen()) win.setFullScreen(false);
    win.setBounds(b);
    win.setFullScreen(true);
    win.show(); win.focus();
    return true;
  }
  // Back to the launcher: pause whatever plays and step aside (kept for next time).
  function hide() {
    if (!alive()) return;
    win.webContents.executeJavaScript('document.querySelectorAll("video").forEach((v) => v.pause())', true).catch(() => {});
    win.hide();
  }
  const isFront = () => alive() && win.isVisible() && win.isFocused();

  function key(code) {
    if (!alive()) return;
    const wc = win.webContents;
    wc.sendInputEvent({ type: 'keyDown', keyCode: code });
    wc.sendInputEvent({ type: 'keyUp', keyCode: code });
  }
  // The controller, every poll (XInput bits; PlayStation pads arrive the same way).
  function input(mask, lx, ly) {
    const t = now();
    let dir = null;
    if (mask & BIT.UP || ly > STICK) dir = 'Up';
    else if (mask & BIT.DOWN || ly < -STICK) dir = 'Down';
    else if (mask & BIT.LEFT || lx < -STICK) dir = 'Left';
    else if (mask & BIT.RIGHT || lx > STICK) dir = 'Right';
    for (const [name, code] of Object.entries(KEYS)) {
      const bit = BIT[name];
      if ((mask & bit) && !(prev & bit)) key(code);
    }
    // LB / RB: jump back / forward in a video (several presses of left / right).
    for (const [name, code] of [['LB', 'Left'], ['RB', 'Right']]) {
      const bit = BIT[name];
      if ((mask & bit) && !(prev & bit)) { key(code); key(code); key(code); }
    }
    prev = mask;
    if (dir) {
      if (!held || held.dir !== dir) { held = { dir, next: t + FIRST }; key(dir); }
      else if (t >= held.next) { held.next = t + REPEAT; key(dir); }
    } else held = null;
  }
  // Sign out / start over: forget YouTube's storage.
  async function reset() {
    if (alive()) win.destroy();
    win = null;
    try { await session.fromPartition('persist:youtube').clearStorageData(); } catch (_) { /* nothing stored */ }
    return true;
  }
  return { open, hide, isFront, input, reset, isOpen: alive };
}

module.exports = { createYouTube, AGENTS, PAGE_SETUP, KEYS };
