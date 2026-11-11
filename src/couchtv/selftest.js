'use strict';
// Build check for Couch TV (COUCH_TV_SELFTEST=<folder>): the real app is started on GitHub's
// Windows machine, looked at, and what it found is written to <folder>/result.json.
const fs = require('fs');
const path = require('path');

function run({ app, win, storeOpts, SHARED, embedApi, hwnd, tvPart }) {
  const dir = process.env.COUCH_TV_SELFTEST;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const res = { platform: process.platform, version: global.couchVersion, userData: app.getPath('userData'), shared: SHARED, console: [] };
  const step = async (name, fn) => { try { res[name] = await fn(); } catch (e) { res[name] = false; res[name + 'Error'] = String((e && e.message) || e).slice(0, 300); } };
  const w = win();
  w.webContents.on('console-message', (_e, level, message, line, source) => { if (res.console.length < 80) res.console.push([level, String(message).slice(0, 300), line, String(source || '').split('/').pop()]); });
  const look = () => w.webContents.executeJavaScript(`(() => {
    const q = (s) => document.querySelector(s);
    const r = (s) => { const e = q(s); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]; };
    return { stage: window.__stage, tvapp: document.documentElement.classList.contains('tvapp'), layer: !!q('.tv-layer'), page: (q('.tv-scroll') || {}).className || null,
      topbar: q('#topbar') ? getComputedStyle(q('#topbar')).display : null, nav: r('.tv-nav'), gear: r('.tv-me'), w: innerWidth, h: innerHeight, sw: document.documentElement.scrollWidth,
      rows: document.querySelectorAll('.tv-rowwrap > .tv-row').length, arrows: document.querySelectorAll('.tv-rowwrap > .tv-arrow').length, posters: document.querySelectorAll('.tv-poster').length,
      rem: parseFloat(getComputedStyle(document.documentElement).fontSize) };
  })()`, true);
  setTimeout(async () => {
    await step('shown', () => w.isVisible() && !w.isFullScreen() && w.isResizable() && !w.isMinimized());
    await step('bounds', () => w.getBounds());
    await step('title', () => w.getTitle());
    await step('screen', look);
    await step('snap', async () => { fs.writeFileSync(path.join(dir, 'couchtv.png'), (await w.webContents.capturePage()).toPNG()); return true; });
    // Sized like any window, and its pages still fit.
    await step('resized', async () => { w.setSize(900, 600); await wait(900); const b = w.getBounds(); const v = await look(); return { size: [b.width, b.height], nav: v.nav, gear: v.gear, sw: v.sw, w: v.w, rem: v.rem }; });
    await step('fullscreen', async () => { w.setFullScreen(true); await wait(1500); const on = w.isFullScreen(); w.setFullScreen(false); await wait(1500); return on && !w.isFullScreen(); });
    // The launcher's sign-in key, and something the launcher itself saved on this machine.
    await step('sharedKey', () => (storeOpts.other ? storeOpts.other.how : false));
    await step('sharedRead', () => {
      const f = path.join(SHARED, 'selftest-shared.json');
      if (!fs.existsSync(f)) return 'the launcher left no sample';
      if (!storeOpts.other) return false;
      return storeOpts.other.decrypt(Buffer.from(JSON.parse(fs.readFileSync(f, 'utf8')).enc, 'base64')) === 'couch-shared-check';
    });
    await step('status', async () => {
      const r = await w.webContents.executeJavaScript('window.launcher.tvStatus().then((s) => ({ signedIn: s.signedIn, mpv: !!s.mpv }), (e) => ({ error: String(e.message || e) }))', true);
      return r;
    });
    // A real video, played by the real player inside this window, with the controls over it.
    await step('embed', () => embedCheck({ app, w, SHARED, embedApi, hwnd, tvPart, dir, res, wait }));
    await step('files', () => ({ ownSettings: fs.existsSync(path.join(app.getPath('userData'), 'settings.json')), ownTv: fs.existsSync(path.join(app.getPath('userData'), 'tv.json')) }));
    await step('errors', () => { try { return fs.readFileSync(path.join(app.getPath('userData'), 'errors.log'), 'utf8').slice(-1500); } catch (_) { return ''; } });
    res.done = true;
    try { fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(res, null, 1)); } catch (_) { /* reported as missing */ }
    app.quit();
  }, 9000);
}

// Plays a plain magenta clip (served from this machine) the way anything is played, and
// looks at the screen: the picture must be a child of this window filling its inside, show
// through the see-through controls, follow the window when it is resized and made full screen,
// leave the keyboard with Couch TV, and be gone when it ends.
async function embedCheck({ app, w, SHARED, embedApi, hwnd, tvPart, dir, res, wait }) {
  const { BrowserWindow, screen, desktopCapturer, nativeImage } = require('electron');
  const http = require('http');
  const { execFileSync } = require('child_process');
  const tvp = require('../tvplayer');
  const out = {};
  res.embedInfo = out;
  if (!embedApi) return 'the window calls could not be loaded';
  const until = async (fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { let v = null; try { v = await fn(); } catch (_) { v = null; } if (v) return v; await wait(200); } return null; };
  let exe = tvp.findMpv(process.env, null, SHARED);
  if (!exe) exe = await tvp.downloadMpv(SHARED, process.env.COUCH_SELFTEST_TOKEN ? { token: process.env.COUCH_SELFTEST_TOKEN } : {});
  out.mpv = !!exe;
  if (!exe) return 'no player on this machine';
  const clip = fs.readFileSync(path.join(__dirname, '..', 'selftest', 'embed.mp4'));
  const server = http.createServer((req, rsp) => { rsp.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': clip.length }); rsp.end(clip); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port + '/embed.mp4';
  // The screen, as it really looks (the player's picture is not part of the page).
  const shot = async () => {
    const d = screen.getDisplayMatching(w.getBounds());
    const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
    let img = null;
    try { const src = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size }); const one = src.find((x) => String(x.display_id) === String(d.id)) || src[0]; if (one && !one.thumbnail.isEmpty()) { img = one.thumbnail; out.shotBy = 'capturer'; } } catch (e) { out.capturerError = String(e.message || e).slice(0, 120); }
    if (!img) {
      const f = path.join(dir, 'screen.png');
      const ps = "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save($env:CTV_SHOT)";
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: Object.assign({}, process.env, { CTV_SHOT: f }), windowsHide: true, timeout: 30000 });
      img = nativeImage.createFromPath(f); out.shotBy = 'powershell';
    }
    const full = img.getSize();
    const c = w.getContentBounds();
    const k = full.width / d.bounds.width; // picture pixels per screen unit
    const box = { x: Math.max(0, Math.round((c.x - d.bounds.x) * k)), y: Math.max(0, Math.round((c.y - d.bounds.y) * k)), width: Math.round(c.width * k), height: Math.round(c.height * k) };
    box.width = Math.min(box.width, full.width - box.x); box.height = Math.min(box.height, full.height - box.y);
    const part = img.crop(box), bmp = part.toBitmap(), ps = part.getSize();
    const at = (fx, fy) => { const x = Math.min(ps.width - 1, Math.round(ps.width * fx)), y = Math.min(ps.height - 1, Math.round(ps.height * fy)), i = (y * ps.width + x) * 4; return [bmp[i + 2], bmp[i + 1], bmp[i]]; }; // (stored blue, green, red)
    return { at, part };
  };
  const magenta = (p) => p[0] > 170 && p[2] > 170 && p[1] < 100;
  const thumb = (part) => part.resize({ width: 720, quality: 'good' }).toJPEG(62).toString('base64');
  const sameSize = () => { const c = embedApi.child(hwnd()), a = c ? embedApi.inside(c) : null, b = embedApi.inside(hwnd()); return !!a && !!b && Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1 ? a : null; };
  const hudWin = () => BrowserWindow.getAllWindows().find((x) => x !== w && !x.isDestroyed() && x.isVisible());
  const hudOver = () => { const h = hudWin(); if (!h) return false; const a = h.getBounds(), b = w.getContentBounds(); return Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1; };
  const js = (code) => w.webContents.executeJavaScript(code, true);
  try {
    w.setSize(960, 620); w.show(); w.focus(); await wait(700);
    out.before = (await shot()).at(0.22, 0.45);
    out.started = await js("window.launcher.tvPlay({ meta: { id: 'selftest', type: 'movie', name: 'Couch TV self-test' }, stream: { url: " + JSON.stringify(url) + " } }).then(() => true, (e) => String(e.message || e))");
    if (out.started !== true) return 'it would not play: ' + out.started;
    out.child = !!(await until(() => embedApi.child(hwnd()), 20000));
    if (!out.child) return 'the player’s picture never appeared inside the window';
    out.isChild = embedApi.parentOf(embedApi.child(hwnd())) === hwnd();
    out.fills = await until(sameSize, 6000);
    out.controlsOver = !!(await until(hudOver, 4000));
    out.playing = !!(await until(async () => { const st = await js('window.launcher.tvStatus()'); return st && st.playing; }, 5000));
    // the picture shows through the controls
    out.pixel = await until(async () => { const p = (await shot()).at(0.22, 0.45); return magenta(p) ? p : null; }, 15000);
    if (!out.pixel) { const s0 = await shot(); out.pixelSeen = s0.at(0.22, 0.45); res.thumb = thumb(s0.part); return 'the picture is not visible in the window (saw ' + out.pixelSeen + ')'; }
    // paused with a click on the controls: they stay up, with the play button in the middle
    await js("window.launcher.hudAct('toggle', null)"); await wait(1200);
    let s1 = await shot();
    out.pixelPaused = s1.at(0.22, 0.45);
    res.thumb = thumb(s1.part);
    // (the white play mark in the middle of its button, where the plain picture has no green at all: looked for where the controls say it is)
    const spot = await hudWin().webContents.executeJavaScript("(() => { const r = document.getElementById('m-toggle').getBoundingClientRect(); return [(r.left + r.width * 0.5) / innerWidth, (r.top + r.height / 2) / innerHeight, Math.round(r.width)]; })()", true);
    out.button = spot; out.buttonPixel = s1.at(spot[0], spot[1]);
    out.controlsDrawn = spot[2] >= 30 && out.buttonPixel[1] > 150;
    out.keyboardOurs = w.isFocused() ? embedApi.focusPid() === process.pid : 'not in front';
    // resized: the picture and the controls go with the window
    w.setSize(840, 560); await wait(1500);
    out.fillsResized = await until(sameSize, 5000); out.controlsResized = !!(await until(hudOver, 3000));
    out.pixelResized = (await shot()).at(0.22, 0.45);
    // full screen and back
    w.setFullScreen(true); await wait(2200);
    out.fillsFull = await until(sameSize, 5000); out.controlsFull = !!(await until(hudOver, 3000));
    const s2 = await shot(); out.pixelFull = s2.at(0.22, 0.45); res.thumbFull = thumb(s2.part);
    w.setFullScreen(false); await wait(2200);
    out.fillsBack = await until(sameSize, 5000);
    // Back: the picture goes, the page is there again
    await js("window.launcher.hudAct('exit', null)");
    out.gone = !!(await until(() => !embedApi.child(hwnd()), 8000));
    out.controlsGone = !!(await until(() => !hudWin(), 4000));
    out.after = (await shot()).at(0.22, 0.45);
    const ok = out.isChild && out.fills && out.controlsOver && out.playing && magenta(out.pixelPaused) && out.controlsDrawn && out.keyboardOurs !== false &&
      out.fillsResized && out.controlsResized && magenta(out.pixelResized) && out.fillsFull && out.controlsFull && magenta(out.pixelFull) && out.fillsBack && out.gone && out.controlsGone && !magenta(out.after) && !magenta(out.before);
    return ok ? true : 'see embedInfo';
  } finally { try { server.close(); } catch (_) { /* closed */ } }
}

module.exports = { run };
