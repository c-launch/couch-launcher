'use strict';
// Reads the Xbox controller's Share button while a game is in front, through the small reader
// process in rawpads-child.js (Windows' Raw Input, which keeps coming to apps in the background).
// The Share bit is the one learned with Find Share (Settings › Controllers › Test the Share button).

const path = require('path');
const { spawn } = require('child_process');

function createRawPads(opts) {
  const spawnFn = opts.spawn || spawn;
  const now = opts.now || Date.now;
  const shareMap = opts.shareMap || (() => null);
  let proc = null, buf = '', want = false, restarts = 0, restartTimer = null;
  const st = { running: false, ready: false, error: null, reports: 0, lastAt: 0, startedAt: 0, pads: new Map() };

  function shareOf(pad) {
    const m = shareMap();
    if (!m || !pad || m.pid !== pad.pid || m.size !== pad.size || !pad.bytes || m.byte >= pad.bytes.length) return false;
    return !!((pad.bytes[m.byte] | 0) & m.mask);
  }
  function line(text) {
    let o;
    try { o = JSON.parse(text); } catch (_) { return; }
    if (!o || typeof o !== 'object') return;
    if (o.error) { st.error = String(o.error).slice(0, 200); return; }
    if (o.ready) { st.ready = true; st.error = null; restarts = 0; return; }
    if (typeof o.n === 'number') { st.reports = o.n; st.lastAt = now(); return; }
    if (Number.isInteger(o.d) && typeof o.b === 'string' && /^[0-9a-f]{2,256}$/.test(o.b)) {
      const bytes = Buffer.from(o.b, 'hex');
      st.pads.set(o.d, { pid: Number(o.pid) | 0, size: Number(o.size) | 0, bytes, at: now() });
      st.lastAt = now();
    }
  }
  function start() {
    want = true;
    if (proc || opts.platform !== 'win32') return;
    clearTimeout(restartTimer); restartTimer = null;
    st.ready = false; st.error = null; st.startedAt = now(); st.pads.clear();
    try {
      proc = spawnFn(opts.execPath, [opts.script || path.join(__dirname, 'rawpads-child.js')], {
        env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1', COUCH_KOFFI: opts.koffiPath || '' }),
        stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true
      });
    } catch (e) { proc = null; st.error = String(e.message || e); return; }
    st.running = true;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 1e6) buf = '';
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) line(l); }
    });
    proc.on('error', (e) => { st.error = String(e.message || e); });
    proc.on('exit', () => {
      proc = null; buf = ''; st.running = false; st.ready = false; st.pads.clear();
      // Comes back by itself a few times (then waits for the next start()).
      if (want && restarts < 5) { restarts++; restartTimer = setTimeout(() => { restartTimer = null; if (want) start(); }, 3000 * restarts); }
    });
  }
  function stop() {
    want = false;
    clearTimeout(restartTimer); restartTimer = null;
    if (proc) { try { proc.kill(); } catch (_) { /* gone */ } }
    proc = null; st.running = false; st.ready = false; st.pads.clear();
  }
  return {
    start, stop,
    // Share held on any Xbox controller the reader sees (and the data is fresh).
    get share() { for (const p of st.pads.values()) if (now() - p.at < 30 * 60e3 && shareOf(p)) return true; return false; },
    debug() {
      const first = [...st.pads.values()][0] || null;
      return { running: st.running, ready: st.ready, error: st.error, reports: st.reports, lastAt: st.lastAt, startedAt: st.startedAt, share: this.share,
        pad: first ? { pid: first.pid, size: first.size, at: first.at, bytes: Array.from(first.bytes) } : null };
    }
  };
}

module.exports = { createRawPads };
