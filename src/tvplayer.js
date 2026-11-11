'use strict';
// Movies & TV playback.
//  - The picture comes from mpv (free, plays every format: 4K, HDR, Dolby Vision, any audio),
//    in a borderless window that fills the chosen display. The launcher talks to it over mpv's
//    JSON pipe, so the controller and the launcher's own controls drive it.
//  - Torrent streams go through Stremio's own streaming engine (127.0.0.1:11470), the same one
//    the Stremio app uses. If it isn't running, the launcher starts it from your Stremio install.

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');

const SERVER = 'http://127.0.0.1:11470';
const exists = (p) => { try { return !!p && fs.statSync(p).isFile(); } catch (_) { return false; } };
const listDir = (d) => { try { return fs.readdirSync(d); } catch (_) { return []; } };

// ---------------------------------------------------------------- mpv
// The launcher's own copy lives here (in its data folder, so updates never touch it).
const ownDir = (userData) => (userData ? path.join(userData, 'mpv') : null);
function findMpv(env, chosen, userData) {
  env = env || process.env;
  if (process.platform === 'darwin') {
    // Mac: Homebrew's mpv, or the mpv app (mpv.io links to its builds).
    const home = env.HOME || '';
    const m = [chosen && /\.app\/?$/i.test(chosen) ? path.join(chosen, 'Contents', 'MacOS', 'mpv') : chosen,
      '/opt/homebrew/bin/mpv', '/usr/local/bin/mpv', '/Applications/mpv.app/Contents/MacOS/mpv', path.join(home, 'Applications', 'mpv.app', 'Contents', 'MacOS', 'mpv'), '/opt/local/bin/mpv'];
    for (const d of String(env.PATH || '').split(':')) if (d) m.push(path.join(d, 'mpv'));
    return m.filter(Boolean).find(exists) || null;
  }
  const la = env.LOCALAPPDATA || '', pf = env.ProgramFiles || 'C:\\Program Files', up = env.USERPROFILE || '';
  const c = [];
  if (chosen) c.push(chosen);
  if (userData) c.push(path.join(ownDir(userData), 'mpv.exe'));
  c.push(path.join(la, 'Microsoft', 'WinGet', 'Links', 'mpv.exe'));
  const pk = path.join(la, 'Microsoft', 'WinGet', 'Packages');
  for (const d of listDir(pk)) if (/^shinchiro\.mpv/i.test(d) || /^mpv/i.test(d)) { c.push(path.join(pk, d, 'mpv.exe')); for (const s of listDir(path.join(pk, d))) c.push(path.join(pk, d, s, 'mpv.exe')); }
  c.push(path.join(pf, 'mpv', 'mpv.exe'), path.join(la, 'Programs', 'mpv', 'mpv.exe'), path.join(up, 'scoop', 'apps', 'mpv', 'current', 'mpv.exe'),
    path.join(up, 'scoop', 'shims', 'mpv.exe'), 'C:\\ProgramData\\chocolatey\\bin\\mpv.exe', path.join(up, 'mpv', 'mpv.exe'), 'C:\\mpv\\mpv.exe',
    path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'mpv', 'mpv.exe'), path.join(la, 'mpv', 'mpv.exe'));
  // An mpv unpacked in Downloads, on the Desktop or in Documents (mpv-x86_64-…\\mpv.exe).
  for (const base of ['Downloads', 'Desktop', 'Documents'].map((d) => path.join(up, d))) {
    for (const d of listDir(base)) if (/^mpv/i.test(d)) { c.push(path.join(base, d, 'mpv.exe')); for (const s of listDir(path.join(base, d))) c.push(path.join(base, d, s, 'mpv.exe')); }
  }
  for (const d of String(env.PATH || env.Path || '').split(';')) if (d) c.push(path.join(d.replace(/"/g, ''), 'mpv.exe'));
  return c.find(exists) || null;
}
// Installing mpv: the launcher downloads the Windows build (shinchiro's, the one mpv.io links
// to) into its own data folder, where it finds it every time, updates included. If that
// doesn't work, winget's mpv package is the fallback.
const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { windowsHide: true, timeout: 10 * 60e3 }, (err, out) => (err ? reject(err) : resolve(out))));
function pickMpvAsset(assets) {
  const ok = (assets || []).filter((a) => a && /^mpv-x86_64-\d{8}-git-[0-9a-f]+\.7z$/i.test(a.name));
  return ok[0] || (assets || []).find((a) => a && /^mpv-x86_64-(?!v3)[^/]*\.7z$/i.test(a.name) && !/dev|debug|ffmpeg/i.test(a.name)) || null;
}
async function downloadMpv(userData, opts) {
  opts = opts || {};
  const doFetch = opts.fetch || ((...a) => fetch(...a));
  const exec = opts.exec || run;
  const dir = ownDir(userData);
  const res = await doFetch('https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CouchLauncher', ...(opts.token ? { Authorization: 'Bearer ' + opts.token } : {}) }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('GitHub: HTTP ' + res.status);
  const asset = pickMpvAsset((await res.json()).assets);
  if (!asset) throw new Error('No Windows download of mpv found');
  const tmp = path.join(userData, 'mpv-download');
  await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  await fs.promises.mkdir(path.join(tmp, 'files'), { recursive: true });
  try {
    const file = await doFetch(asset.browser_download_url, { headers: { 'User-Agent': 'CouchLauncher' }, signal: AbortSignal.timeout(15 * 60e3) });
    if (!file.ok) throw new Error('Download failed: HTTP ' + file.status);
    const archive = path.join(tmp, asset.name);
    await fs.promises.writeFile(archive, Buffer.from(await file.arrayBuffer()));
    // .7z: Windows' own tar opens it; 7-Zip when it's installed.
    let unpacked = false;
    try { await exec('tar.exe', ['-xf', archive, '-C', path.join(tmp, 'files')]); unpacked = true; } catch (_) { /* try 7-Zip */ }
    if (!unpacked) for (const z of ['C:\\Program Files\\7-Zip\\7z.exe', 'C:\\Program Files (x86)\\7-Zip\\7z.exe']) {
      if (exists(z)) { await exec(z, ['x', '-y', '-o' + path.join(tmp, 'files'), archive]); unpacked = true; break; }
    }
    if (!unpacked) throw new Error('Couldn’t unpack mpv');
    // The folder with mpv.exe in it (sometimes one level down).
    let root = path.join(tmp, 'files');
    if (!exists(path.join(root, 'mpv.exe'))) { const sub = listDir(root).map((d) => path.join(root, d)).find((d) => exists(path.join(d, 'mpv.exe'))); if (sub) root = sub; }
    if (!exists(path.join(root, 'mpv.exe'))) throw new Error('The download didn’t have mpv.exe in it');
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.promises.cp(root, dir, { recursive: true, force: true });
    return path.join(dir, 'mpv.exe');
  } finally {
    fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
function installMpv(userData, opts) {
  if (process.platform === 'darwin') {
    // Mac: Homebrew installs it when it's there; otherwise you get it from mpv.io.
    const brew = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find(exists);
    if (!brew) return Promise.reject(new Error('Get mpv for Mac from mpv.io (or install Homebrew, then choose Install again), then choose it here.'));
    return new Promise((resolve, reject) => execFile(brew, ['install', 'mpv'], { timeout: 20 * 60e3, env: Object.assign({}, process.env, { HOMEBREW_NO_AUTO_UPDATE: '1' }) }, () => {
      const found = findMpv(process.env, null, userData);
      if (found) resolve(found); else reject(new Error('Couldn’t install mpv with Homebrew. Get it from mpv.io, then choose it here.'));
    }));
  }
  return downloadMpv(userData, opts).catch((first) => new Promise((resolve, reject) => {
    execFile('winget', ['install', '--id', 'shinchiro.mpv', '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements'],
      { windowsHide: true, timeout: 10 * 60e3 }, (err, stdout) => {
        const found = findMpv(process.env, null, userData);
        if (found) return resolve(found);
        reject(new Error('Couldn’t install mpv (' + String(first && first.message || first) + '). Get it from mpv.io, then choose mpv.exe here.'));
      });
  }));
}

// ---------------------------------------------------------------- Stremio's streaming engine
function serverCandidates(env) {
  env = env || process.env;
  if (process.platform === 'darwin') {
    // Mac: Stremio Service, or the streaming server inside the Stremio app.
    const out = [];
    for (const app of ['/Applications/Stremio Service.app', '/Applications/StremioService.app', path.join(env.HOME || '', 'Applications', 'Stremio Service.app')]) out.push({ exe: path.join(app, 'Contents', 'MacOS', 'stremio-service'), args: [], cwd: path.join(app, 'Contents', 'MacOS') });
    for (const app of ['/Applications/Stremio.app', path.join(env.HOME || '', 'Applications', 'Stremio.app')]) {
      for (const dir of [path.join(app, 'Contents', 'MacOS'), path.join(app, 'Contents', 'Resources')]) {
        if (exists(path.join(dir, 'server.js'))) for (const rt of ['stremio-runtime', 'node']) out.push({ exe: path.join(app, 'Contents', 'MacOS', rt), args: [path.join(dir, 'server.js')], cwd: dir });
      }
    }
    return out.filter((x) => exists(x.exe));
  }
  const la = env.LOCALAPPDATA || '', pf = env.ProgramFiles || 'C:\\Program Files', pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const out = [];
  for (const base of [path.join(la, 'Programs', 'StremioService'), path.join(pf, 'StremioService'), path.join(pf86, 'StremioService')]) out.push({ exe: path.join(base, 'stremio-service.exe'), args: [], cwd: base });
  for (const base of [path.join(la, 'Programs', 'LNV', 'Stremio-4'), path.join(la, 'Programs', 'LNV', 'Stremio'), path.join(la, 'Programs', 'Stremio'), path.join(pf, 'Stremio'), path.join(pf, 'LNV', 'Stremio-4'), path.join(pf86, 'Stremio')]) {
    if (exists(path.join(base, 'server.js'))) out.push({ exe: path.join(base, 'stremio-runtime.exe'), args: ['server.js'], cwd: base });
  }
  return out.filter((x) => exists(x.exe));
}
function createEngine(opts) {
  opts = opts || {};
  const doFetch = opts.fetch || ((...a) => fetch(...a));
  const server = opts.server || SERVER;
  let child = null;
  async function ping() {
    try { const r = await doFetch(server + '/settings', { signal: AbortSignal.timeout(2000) }); return r.ok; } catch (_) { return false; }
  }
  async function ensure() {
    if (await ping()) return true;
    const cand = serverCandidates(opts.env)[0];
    if (!cand) throw new Error('Torrent streams need Stremio’s streaming engine. Install the Stremio app (or Stremio Service) on this PC, or use a debrid addon.');
    if (!child) {
      try {
        child = spawn(cand.exe, cand.args, { cwd: cand.cwd, detached: true, stdio: 'ignore', windowsHide: true });
        child.on('exit', () => { child = null; });
        child.unref();
      } catch (e) { throw new Error('Couldn’t start Stremio’s streaming engine: ' + e.message); }
    }
    for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 500)); if (await ping()) return true; }
    throw new Error('Stremio’s streaming engine didn’t start');
  }
  // A playable address for a torrent stream; asks the engine which file is the episode when
  // the addon didn't say.
  async function torrentUrl(s, hint) {
    await ensure();
    const ih = String(s.infoHash || '').toLowerCase();
    if (!/^[0-9a-f]{40}$|^[a-z2-7]{32}$/.test(ih)) throw new Error('This stream’s torrent link is broken');
    let idx = Number.isInteger(s.fileIdx) ? s.fileIdx : null;
    try {
      const sources = (s.sources && s.sources.length ? s.sources : []).concat(['dht:' + ih]);
      const r = await doFetch(server + '/' + ih + '/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
        body: JSON.stringify({ torrent: { infoHash: ih }, peerSearch: { sources, min: 40, max: 200 }, guessFileIdx: hint || {} })
      });
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (idx == null && j) {
          if (Number.isInteger(j.guessedFileIdx)) idx = j.guessedFileIdx;
          else if (Array.isArray(j.files) && j.files.length) {
            let best = -1, size = -1;
            j.files.forEach((f, i) => { if (/\.(mkv|mp4|avi|m4v|mov|webm|ts|wmv)$/i.test(f && f.name || '') && Number(f.length) > size) { size = Number(f.length); best = i; } });
            if (best >= 0) idx = best;
          }
        }
      }
    } catch (_) { /* older engines create it on the first request */ }
    return server + '/' + ih + '/' + (idx == null ? 0 : idx);
  }
  return { ping, ensure, torrentUrl, server, available: () => serverCandidates(opts.env).length > 0 };
}

// ---------------------------------------------------------------- one mpv session
// Events: 'time' {pos, dur}, 'pause' bool, 'tracks' {subs, audio}, 'buffering' bool,
//         'eof', 'exit' {code}, 'failed' (a file couldn't be opened; only heard of with o.idle,
//         where the player stays open instead of closing).
// Fail-safe for the optional switches: asked once per mpv whether it accepts them (it exits
// with an error when it doesn't know one). Until that has been asked, and when the answer is no,
// the player starts without them.
const extras = new Map(); // exe -> true / false
function extrasOk(exe) {
  if (extras.has(exe)) return Promise.resolve(extras.get(exe));
  return new Promise((resolve) => {
    execFile(exe, ['--no-config', '--window-dragging=no', '--input-cursor=no', '--version'], { windowsHide: true, timeout: 15000 }, (err) => { extras.set(exe, !err); resolve(!err); });
  });
}

function startMpv(exe, o) {
  const ev = new EventEmitter();
  // Windows: a named pipe. Mac / Linux: a socket file in the temp folder.
  const pipe = process.platform === 'win32' ? '\\\\.\\pipe\\couch-mpv-' + process.pid + '-' + Date.now().toString(36) : path.join(require('os').tmpdir(), 'couch-mpv-' + process.pid + '-' + Date.now().toString(36) + '.sock');
  const lang = (o.subLang || '').toLowerCase();
  const args = [
    '--input-ipc-server=' + pipe, '--force-window=immediate', '--keep-open=always', '--idle=' + (o.idle ? 'yes' : 'no'),
    '--no-border', '--osc=no', '--osd-bar=no', '--cursor-autohide=always', '--hwdec=auto-safe',
    // The mouse does nothing to the picture: no dragging the window around, and none of mpv's own
    // mouse actions (wheel = seek, right click = pause, double click = leave full screen).
    // Only when this mpv was seen to accept them (extrasOk below): an mpv that doesn't know an
    // option refuses to start at all.
    ...(extras.get(exe) === true ? ['--window-dragging=no', '--input-cursor=no'] : []),
    '--title=Couch Launcher Player', '--force-media-title=' + String(o.title || 'Movies & TV').replace(/[\r\n]/g, ' '),
    '--ytdl=no', '--cache=yes', '--demuxer-max-bytes=400MiB', '--demuxer-readahead-secs=60', '--network-timeout=40',
    '--save-position-on-quit=no', '--sub-auto=fuzzy', '--sub-font-size=46', '--osd-font-size=36', '--volume=100',
    '--alang=' + (o.audioLang || 'en,eng'), '--slang=' + (lang && lang !== 'off' ? lang : 'en,eng')
  ];
  if (lang === 'off') args.push('--sid=no');
  // Couch TV (Windows): the picture is drawn inside its window (o.wid: that window's handle),
  // filling it and following its size. The keyboard stays with Couch TV, which works the
  // controls itself; nothing here is full screen.
  // The mouse over the picture is the player's (its picture is a real window): it has no
  // actions of its own here, it only tells Couch TV where the pointer is and when it is
  // clicked (see "mouse" below), and Couch TV works the controls drawn over the picture.
  if (o.wid) {
    for (const drop of ['--input-cursor=no', '--cursor-autohide=always']) { const i = args.indexOf(drop); if (i >= 0) args.splice(i, 1); }
    args.push('--wid=' + String(o.wid), '--input-vo-keyboard=no', '--input-default-bindings=no', '--input-cursor=yes', '--cursor-autohide=3000');
  }
  else {
    if (o.rect) args.push('--geometry=' + o.rect.width + 'x' + o.rect.height + '+' + o.rect.x + '+' + o.rect.y);
    // Mac: full screen over the menu bar and Dock, without a separate Space (so the guide and the
    // controls can sit on top).
    if (process.platform === 'darwin') args.push('--fs', '--native-fs=no');
  }
  if (o.startAt > 5) args.push('--start=' + Math.floor(o.startAt));
  if (o.headers) {
    const h = Object.entries(o.headers).filter(([k, v]) => /^[\w-]+$/.test(k) && !/[,\r\n]/.test(String(v))).map(([k, v]) => k + ': ' + v);
    if (h.length) args.push('--http-header-fields=' + h.join(','));
  }
  args.push('--', o.url);
  const child = spawn(exe, args, { stdio: 'ignore', windowsHide: false });
  let sock = null, buf = '', reqId = 0, exited = false, eof = false;
  let queuedSubs = (o.subs || []).slice(0, 25); // added once the pipe is open
  const pending = new Map();
  const state = { pos: 0, dur: 0, paused: false, tracks: [] };
  const mouse = { x: 0, y: 0, w: 0, h: 0 };
  child.on('exit', (code) => { exited = true; try { if (sock) sock.destroy(); } catch (_) { /* gone */ } ev.emit('exit', { code }); });
  child.on('error', (e) => { exited = true; ev.emit('exit', { code: -1, error: e.message }); });

  function connect(tries) {
    if (exited) return;
    const s = net.connect(pipe);
    s.on('connect', () => {
      sock = s;
      const obs = ['time-pos', 'duration', 'pause', 'track-list', 'eof-reached', 'paused-for-cache', 'sid', 'aid'];
      obs.forEach((p, i) => write({ command: ['observe_property', i + 1, p] }));
      for (const sub of queuedSubs) write({ command: ['sub-add', sub.url, 'auto', sub.lang || 'sub', sub.lang || ''] });
      queuedSubs = [];
      if (o.wid) {
        ['mouse-pos', 'osd-width', 'osd-height'].forEach((p, i) => write({ command: ['observe_property', 40 + i, p] }));
        write({ command: ['keybind', 'MBTN_LEFT', 'script-message couch-mouse click'] });
        write({ command: ['keybind', 'MBTN_BACK', 'script-message couch-mouse back'] });
        for (const k of ['MBTN_LEFT_DBL', 'MBTN_RIGHT', 'MBTN_MID', 'WHEEL_UP', 'WHEEL_DOWN', 'WHEEL_LEFT', 'WHEEL_RIGHT']) write({ command: ['keybind', k, 'ignore'] });
      }
      ev.emit('ready');
    });
    s.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) onMsg(line); }
    });
    s.on('error', () => { if (!sock && tries < 75) setTimeout(() => connect(tries + 1), 200); });
    s.on('close', () => { if (sock === s) sock = null; });
  }
  function onMsg(line) {
    let m; try { m = JSON.parse(line); } catch (_) { return; }
    if (m.request_id && pending.has(m.request_id)) { const p = pending.get(m.request_id); pending.delete(m.request_id); if (m.error && m.error !== 'success') p.reject(new Error(m.error)); else p.resolve(m.data); return; }
    if (m.event === 'end-file' && m.reason === 'error') { ev.emit('failed', String(m.file_error || '')); return; }
    // The mouse over the picture, as parts of its width and height (0 to 1).
    if (m.event === 'client-message' && Array.isArray(m.args) && m.args[0] === 'couch-mouse') {
      if (mouse.w > 0 && mouse.h > 0) ev.emit('mouse', { t: m.args[1] === 'back' ? 'back' : 'click', x: mouse.x / mouse.w, y: mouse.y / mouse.h });
      return;
    }
    if (m.event !== 'property-change') return;
    switch (m.name) {
      case 'osd-width': if (typeof m.data === 'number') mouse.w = m.data; break;
      case 'osd-height': if (typeof m.data === 'number') mouse.h = m.data; break;
      case 'mouse-pos':
        if (m.data && typeof m.data.x === 'number') {
          mouse.x = m.data.x; mouse.y = m.data.y;
          if (mouse.w > 0 && mouse.h > 0) ev.emit('mouse', { t: m.data.hover === false ? 'leave' : 'move', x: mouse.x / mouse.w, y: mouse.y / mouse.h });
        }
        break;
      case 'time-pos': if (typeof m.data === 'number') { state.pos = m.data; ev.emit('time', { pos: state.pos, dur: state.dur }); } break;
      case 'duration': if (typeof m.data === 'number') { state.dur = m.data; ev.emit('time', { pos: state.pos, dur: state.dur }); } break;
      case 'pause': state.paused = !!m.data; ev.emit('pause', state.paused); break;
      case 'paused-for-cache': ev.emit('buffering', !!m.data); break;
      case 'eof-reached': if (m.data === true && !eof) { eof = true; ev.emit('eof'); } else if (m.data === false) eof = false; break;
      case 'track-list': case 'sid': case 'aid':
        if (m.name === 'track-list' && Array.isArray(m.data)) state.tracks = m.data;
        ev.emit('tracks', tracks());
        break;
      default: break;
    }
  }
  function write(obj) { if (sock && !exited) { try { sock.write(JSON.stringify(obj) + '\n'); return true; } catch (_) { return false; } } return false; }
  function cmd(...c) {
    return new Promise((resolve, reject) => {
      const id = ++reqId;
      pending.set(id, { resolve, reject });
      if (!write({ command: c, request_id: id })) { pending.delete(id); reject(new Error('Player not ready')); }
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('Player didn’t answer')); } }, 5000);
    });
  }
  const name = (t) => [t.title, t.lang && t.lang.toUpperCase(), t.codec && t.type === 'audio' ? t.codec.toUpperCase() : null, t['demux-channel-count'] ? (t['demux-channel-count'] > 5 ? (t['demux-channel-count'] - 1) + '.1' : t['demux-channel-count'] === 2 ? 'Stereo' : '') : null, t.external ? 'Addon' : null].filter(Boolean).join(' · ') || (t.type === 'sub' ? 'Subtitles ' : 'Audio ') + t.id;
  function tracks() {
    const list = state.tracks || [];
    return {
      subs: list.filter((t) => t.type === 'sub').map((t) => ({ id: t.id, label: name(t), lang: t.lang || '', selected: !!t.selected })),
      audio: list.filter((t) => t.type === 'audio').map((t) => ({ id: t.id, label: name(t), lang: t.lang || '', selected: !!t.selected }))
    };
  }
  setTimeout(() => connect(0), 150);
  return Object.assign(ev, {
    child, state, tracks,
    pause: (on) => cmd('set_property', 'pause', !!on).catch(() => {}),
    togglePause: () => cmd('cycle', 'pause').catch(() => {}),
    seek: (sec, how) => cmd('seek', sec, how || 'relative').catch(() => {}),
    setSub: (id) => cmd('set_property', 'sid', id == null ? 'no' : id).catch(() => {}),
    setAudio: (id) => cmd('set_property', 'aid', id).catch(() => {}),
    addSubs: (subs) => {
      subs = (subs || []).slice(0, 25);
      if (!sock) { queuedSubs = queuedSubs.concat(subs).slice(0, 25); return; }
      for (const s of subs) cmd('sub-add', s.url, 'auto', s.lang || 'sub', s.lang || '').catch(() => {});
    },
    // extra.audio: the sound's own link (YouTube keeps picture and sound apart above 360p).
    // Rejects with code NO_SEPARATE_AUDIO when this mpv won't take one: load the plain link then.
    load: (url, title, startAt, extra) => {
      eof = false; state.pos = 0; state.dur = 0;
      cmd('set_property', 'force-media-title', String(title || '')).catch(() => {});
      // Where this file starts, set every time: otherwise mpv keeps the start it was opened with,
      // so after resuming an episode, the next one began at that same point. Set as mpv's
      // "start" option (the way to pass it with loadfile changed in mpv 0.38).
      const start = startAt > 5 ? String(Math.floor(startAt)) : 'none';
      return cmd('set_property', 'options/start', start)
        .catch(() => cmd('set_property', 'options/start', startAt > 5 ? start : '0'))
        .catch(() => null)
        // Set every time as well: an episode loaded after a commercial must not get its sound.
        .then(() => cmd('set_property', 'options/audio-files', extra && extra.audio ? [String(extra.audio)] : []).then(() => true, () => false))
        .then((took) => {
          if (extra && extra.audio && !took) throw Object.assign(new Error('This mpv can’t play picture and sound from two links'), { code: 'NO_SEPARATE_AUDIO' });
          return cmd('loadfile', url, 'replace');
        });
    },
    quit: () => {
      if (exited) return;
      write({ command: ['quit'] });
      setTimeout(() => { if (!exited) try { child.kill(); } catch (_) { /* gone */ } }, 2500);
    }
  }) && Object.defineProperty(ev, 'alive', { get: () => !exited });
}

module.exports = { extrasOk, findMpv, installMpv, downloadMpv, pickMpvAsset, createEngine, startMpv, serverCandidates, SERVER };
