'use strict';
// Build check for Couch TV (COUCH_TV_SELFTEST=<folder>): the real app is started on GitHub's
// Windows machine, looked at, and what it found is written to <folder>/result.json.
const fs = require('fs');
const path = require('path');

function run({ app, win, storeOpts, SHARED }) {
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
    await step('files', () => ({ ownSettings: fs.existsSync(path.join(app.getPath('userData'), 'settings.json')), ownTv: fs.existsSync(path.join(app.getPath('userData'), 'tv.json')) }));
    await step('errors', () => { try { return fs.readFileSync(path.join(app.getPath('userData'), 'errors.log'), 'utf8').slice(-1500); } catch (_) { return ''; } });
    res.done = true;
    try { fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(res, null, 1)); } catch (_) { /* reported as missing */ }
    app.quit();
  }, 9000);
}

module.exports = { run };
