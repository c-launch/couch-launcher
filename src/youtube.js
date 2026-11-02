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
// How the window introduces itself, adapted from VacuumTube (MIT License, Copyright (c) 2025-2026
// shy): YouTube's TV interface decides its look by the device it thinks it's on. Presented as
// a current desktop build of YouTube's TV app engine (Cobalt 27, the same format Cobalt writes),
// it gets the full interface: smooth animations and proper fades behind text. An old TV-box
// identity got the cut-down one (no animations, black boxes behind titles).
const COBALT = '27.lts.3.1040976-gold', V8 = '13.8.258.54', STARBOARD = 18;
const MODERN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Cobalt/' + COBALT + ' (unlike Gecko) v8/' + V8 + '-jit gles Starboard/' + STARBOARD +
  ', CouchLauncher_DESKTOP_x8664_' + new Date().getFullYear() + '/1.0 (CouchLauncher, Windows) com.couchlauncher.tv/1.0';
const COBALT_SHORT = COBALT.split('-')[0].split('.').slice(0, 3).join('.');
const HINTS = {
  brands: [{ brand: 'CouchLauncher', version: '27' }], fullVersionList: [{ brand: 'CouchLauncher', version: COBALT_SHORT }], fullVersion: COBALT_SHORT,
  platform: 'Starboard', platformVersion: '', architecture: 'x86', model: '', mobile: false, bitness: '64', wow64: false
};
const HINT_HEADERS = {
  'sec-ch-ua': '"CouchLauncher";v="27"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Starboard"',
  'sec-ch-ua-full-version-list': '"CouchLauncher";v="' + COBALT_SHORT + '"', 'sec-ch-ua-full-version': '"' + COBALT_SHORT + '"',
  'sec-ch-ua-platform-version': '""', 'sec-ch-ua-arch': '"x86"', 'sec-ch-ua-bitness': '"64"', 'sec-ch-ua-model': '""', 'sec-ch-ua-wow64': '?0'
};
const GOOGLE = /(^|\.)(youtube\.com|googlevideo\.com|ytimg\.com|ggpht\.com|google\.com|googleapis\.com|gstatic\.com|googleusercontent\.com|youtube-nocookie\.com)$/i;
const AGENTS = [
  MODERN_UA,
  // An older TV box running YouTube's TV app engine
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
    // (ytAgent2: everyone starts again on the newest identity.)
    if (agent == null) agent = Math.max(0, Math.min(AGENTS.length - 1, Number(settings().ytAgent2) || 0));
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
        if (agent < AGENTS.length - 1) { agent++; identify(wc).then(() => wc.loadURL(TV_URL)); }
        else if (!triedAll) { triedAll = true; agent = 0; identify(wc); }
      } else if (/youtube\.com\/tv/i.test(url) && Number(settings().ytAgent2 || 0) !== agent) { settings().ytAgent2 = agent; saveSettings(); }
    });
    win.once('ready-to-show', () => { if (alive()) { win.show(); win.focus(); } });
    // YouTube's own "Exit" (B on its home screen) closes the window: back to the launcher.
    win.on('closed', () => { win = null; if (!replacing) bringBack(false); });
    // The identity (with its client hints) can only be set once there's a page.
    win.loadURL('about:blank').then(() => identify(wc)).then(() => { if (alive()) win.loadURL(TV_URL); }, () => { if (alive()) win.loadURL(TV_URL); });
  }
  // Sets the user agent, and for the newest one the matching client hints (in the page and in
  // requests to Google), so everything YouTube sees agrees.
  let hooked = false;
  async function identify(wc) {
    const ua = AGENTS[agent], hints = agent === 0 ? HINTS : undefined;
    wc.setUserAgent(ua);
    if (!hooked && session) {
      hooked = true;
      const ses = session.fromPartition('persist:youtube');
      ses.setUserAgent(MODERN_UA);
      ses.webRequest.onBeforeSendHeaders((d, cb) => {
        const h = d.requestHeaders;
        let host = '';
        try { host = new URL(d.url).hostname; } catch (_) { host = ''; }
        if (agent === 0) {
          for (const k of Object.keys(h)) if (/^sec-ch-ua/i.test(k)) delete h[k];
          if (GOOGLE.test(host)) Object.assign(h, HINT_HEADERS);
        }
        for (const k of Object.keys(h)) if (k.toLowerCase() === 'user-agent') delete h[k];
        h['User-Agent'] = AGENTS[agent];
        cb({ requestHeaders: h });
      });
    }
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      await wc.debugger.sendCommand('Emulation.setUserAgentOverride', hints ? { userAgent: ua, userAgentMetadata: hints } : { userAgent: ua });
    } catch (_) { /* the plain user agent above still applies */ }
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
  // The guide over YouTube: pause (remembering whether it was playing), then carry on.
  let wasPlaying = false;
  async function pauseForGuide() {
    if (!alive()) return;
    try { wasPlaying = !!(await win.webContents.executeJavaScript('(() => { let p = false; document.querySelectorAll("video").forEach((v) => { if (!v.paused) { p = true; v.pause(); } }); return p; })()', true)); } catch (_) { wasPlaying = false; }
  }
  function resumeFromGuide() {
    if (!alive() || !win.isVisible()) return;
    if (wasPlaying) win.webContents.executeJavaScript('document.querySelectorAll("video").forEach((v) => { if (v.paused && v.readyState > 1) v.play().catch(() => {}); })', true).catch(() => {});
    wasPlaying = false;
    win.focus();
  }
  const isShown = () => alive() && win.isVisible();

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
  return { open, hide, isFront, isShown, input, reset, isOpen: alive, pauseForGuide, resumeFromGuide };
}

module.exports = { createYouTube, AGENTS, PAGE_SETUP, KEYS };
