'use strict';
// Steady players (Settings › Controllers): the launcher holds one virtual controller per player
// while an emulator game runs (vpads-child.js does the work), so a controller dying mid-game
// doesn't shuffle the players. Needs the free ViGEmBus driver (installed once from here).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

function createVPads(opts) {
  const spawnFn = opts.spawn || spawn;
  let proc = null, buf = '', waiters = [], state = [], lastError = null, count = 0;

  function line(text) {
    let o;
    try { o = JSON.parse(text); } catch (_) { return; }
    if (!o || typeof o !== 'object') return;
    if (o.error) { lastError = { error: String(o.error), code: o.code || 'error' }; flush(lastError); return; }
    if (o.ready) { count = o.players | 0; lastError = null; flush({ ok: true, players: count }); return; }
    if (Array.isArray(o.state)) { state = o.state; if (opts.onState) { try { opts.onState(state); } catch (_) { /* ignore */ } } }
  }
  function flush(r) { const w = waiters; waiters = []; for (const f of w) f(r); }

  // slots: the real Xbox-style slot for each player, in player order.
  function start(slots) {
    if (process.platform !== 'win32') return Promise.resolve({ error: 'Only on Windows', code: 'platform' });
    const list = (slots || []).slice(0, 4).map((s) => (Number.isInteger(s) ? s : null));
    if (!list.length) return Promise.resolve({ error: 'No players', code: 'empty' });
    if (!proc) {
      buf = ''; state = []; lastError = null;
      try {
        proc = spawnFn(opts.execPath, [path.join(__dirname, 'vpads-child.js')], {
          env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1', COUCH_KOFFI: opts.koffiPath || '' }),
          stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true
        });
      } catch (e) { proc = null; return Promise.resolve({ error: String(e.message || e), code: 'spawn' }); }
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        buf += chunk;
        if (buf.length > 1e6) buf = '';
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) line(l); }
      });
      proc.on('error', (e) => { lastError = { error: String(e.message || e), code: 'spawn' }; flush(lastError); });
      proc.on('exit', () => { proc = null; count = 0; state = []; flush(lastError || { error: 'The virtual controllers stopped', code: 'exit' }); if (opts.onState) { try { opts.onState([]); } catch (_) { /* ignore */ } } });
    }
    const p = new Promise((resolve) => {
      const t = setTimeout(() => resolve({ error: 'The virtual controllers didn’t start', code: 'timeout' }), 10000);
      waiters.push((r) => { clearTimeout(t); resolve(r); });
    });
    try { proc.stdin.write(JSON.stringify({ players: list }) + '\n'); } catch (_) { /* exit handler answers */ }
    return p.then((r) => { if (r && r.error) stop(); return r; });
  }
  function stop() {
    if (!proc) return;
    const p = proc;
    try { p.stdin.write('{"stop":true}\n'); p.stdin.end(); } catch (_) { /* gone */ }
    // Closing the driver unplugs them anyway; make sure it goes.
    setTimeout(() => { try { p.kill(); } catch (_) { /* gone */ } }, 1500);
  }
  return {
    start, stop,
    get running() { return !!proc && count > 0; },
    get players() { return state; },
    get error() { return lastError; }
  };
}

// Is the ViGEmBus driver there? (Its service is registered once it's installed.)
function busInstalled() {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\ViGEmBus'], { windowsHide: true, timeout: 8000 }, (err) => resolve(!err));
  });
}

// Downloads the ViGEmBus setup from its GitHub page and runs it (Windows asks for permission:
// it installs a driver). Resolves when the setup closes.
async function installBus(log) {
  const say = (t) => { if (log) { try { log(t); } catch (_) { /* ignore */ } } };
  say('Finding ViGEmBus…');
  const res = await fetch('https://api.github.com/repos/nefarius/ViGEmBus/releases/latest', { headers: { 'User-Agent': 'CouchLauncher', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('Couldn’t reach GitHub (' + res.status + ')');
  const rel = await res.json();
  const asset = (rel.assets || []).find((a) => /^ViGEmBus.*\.exe$/i.test(a.name || '')) || (rel.assets || []).find((a) => /\.exe$/i.test(a.name || ''));
  if (!asset) throw new Error('The ViGEmBus download wasn’t found');
  if (!/^https:\/\/github\.com\/nefarius\/ViGEmBus\/releases\/download\//.test(asset.browser_download_url || '')) throw new Error('Unexpected download address');
  say('Downloading ' + asset.name + '…');
  const dl = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'CouchLauncher' }, signal: AbortSignal.timeout(300000) });
  if (!dl.ok) throw new Error('Download failed (' + dl.status + ')');
  const data = Buffer.from(await dl.arrayBuffer());
  if (asset.size && data.length !== asset.size) throw new Error('The download was incomplete');
  const file = path.join(os.tmpdir(), asset.name.replace(/[^\w.\-]/g, '_'));
  fs.writeFileSync(file, data);
  say('Windows will ask for permission. Say Yes, then follow the setup.');
  await new Promise((resolve, reject) => {
    const ps = "Start-Process -FilePath '" + file.replace(/'/g, "''") + "' -Verb RunAs -Wait";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15 * 60e3 }, (err) => {
      if (err && /canceled|cancelled|1223/i.test(String(err.message) + String(err.stderr || ''))) reject(new Error('Windows permission was declined'));
      else resolve();
    });
  });
  try { fs.rmSync(file, { force: true }); } catch (_) { /* in use */ }
  return busInstalled();
}

// Fail-safe: should virtual controllers that are plugged in right now be removed? They are only
// meant to exist while the emulator game they were made for is running, or while the test in
// Settings is open. s: { forGame (the game they were made for), runningGame (what runs now),
// testing, testFor (ms the test has been on), unusedFor (ms since that game was last running) }
const TEST_MAX = 30 * 60e3, UNUSED_MAX = 20e3;
function shouldRemove(s) {
  if (s.forGame && s.runningGame === s.forGame) return false;         // their game is running
  if (s.testing) return !!s.runningGame || s.testFor > TEST_MAX;        // the test: until a game starts, or left on for half an hour
  return s.unusedFor > UNUSED_MAX;                                      // their game never started, or is over
}

module.exports = { shouldRemove, createVPads, busInstalled, installBus };
