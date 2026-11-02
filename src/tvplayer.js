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
function findMpv(env, chosen) {
  env = env || process.env;
  const la = env.LOCALAPPDATA || '', pf = env.ProgramFiles || 'C:\\Program Files', up = env.USERPROFILE || '';
  const c = [];
  if (chosen) c.push(chosen);
  c.push(path.join(la, 'Microsoft', 'WinGet', 'Links', 'mpv.exe'));
  const pk = path.join(la, 'Microsoft', 'WinGet', 'Packages');
  for (const d of listDir(pk)) if (/^shinchiro\.mpv/i.test(d) || /^mpv/i.test(d)) { c.push(path.join(pk, d, 'mpv.exe')); for (const s of listDir(path.join(pk, d))) c.push(path.join(pk, d, s, 'mpv.exe')); }
  c.push(path.join(pf, 'mpv', 'mpv.exe'), path.join(la, 'Programs', 'mpv', 'mpv.exe'), path.join(up, 'scoop', 'apps', 'mpv', 'current', 'mpv.exe'),
    path.join(up, 'scoop', 'shims', 'mpv.exe'), 'C:\\ProgramData\\chocolatey\\bin\\mpv.exe', path.join(up, 'mpv', 'mpv.exe'), 'C:\\mpv\\mpv.exe');
  for (const d of String(env.PATH || env.Path || '').split(';')) if (d) c.push(path.join(d.replace(/"/g, ''), 'mpv.exe'));
  return c.find(exists) || null;
}
// winget's mpv package (a portable build by shinchiro), with no prompts.
function installMpv() {
  return new Promise((resolve, reject) => {
    execFile('winget', ['install', '--id', 'shinchiro.mpv', '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements'],
      { windowsHide: true, timeout: 10 * 60e3 }, (err, stdout) => {
        const found = findMpv();
        if (found) return resolve(found);
        reject(new Error(err && err.code === 'ENOENT' ? 'Windows’ app installer (winget) isn’t on this PC. Get mpv from mpv.io, then choose mpv.exe here.' : 'Couldn’t install mpv' + (stdout ? ': ' + String(stdout).trim().split('\n').pop().slice(0, 160) : '')));
      });
  });
}

// ---------------------------------------------------------------- Stremio's streaming engine
function serverCandidates(env) {
  env = env || process.env;
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
//         'eof', 'exit' {code}.
function startMpv(exe, o) {
  const ev = new EventEmitter();
  const pipe = '\\\\.\\pipe\\couch-mpv-' + process.pid + '-' + Date.now().toString(36);
  const lang = (o.subLang || '').toLowerCase();
  const args = [
    '--input-ipc-server=' + pipe, '--force-window=immediate', '--keep-open=always', '--idle=no',
    '--no-border', '--osc=no', '--osd-bar=no', '--cursor-autohide=always', '--hwdec=auto-safe',
    '--title=Couch Launcher Player', '--force-media-title=' + String(o.title || 'Movies & TV').replace(/[\r\n]/g, ' '),
    '--ytdl=no', '--cache=yes', '--demuxer-max-bytes=400MiB', '--demuxer-readahead-secs=60', '--network-timeout=40',
    '--save-position-on-quit=no', '--sub-auto=fuzzy', '--sub-font-size=46', '--osd-font-size=36', '--volume=100',
    '--alang=' + (o.audioLang || 'en,eng'), '--slang=' + (lang && lang !== 'off' ? lang : 'en,eng')
  ];
  if (lang === 'off') args.push('--sid=no');
  if (o.rect) args.push('--geometry=' + o.rect.width + 'x' + o.rect.height + '+' + o.rect.x + '+' + o.rect.y);
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
    if (m.event !== 'property-change') return;
    switch (m.name) {
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
    load: (url, title, startAt) => {
      eof = false; state.pos = 0; state.dur = 0;
      cmd('set_property', 'force-media-title', String(title || '')).catch(() => {});
      return cmd('loadfile', url, 'replace', startAt > 5 ? 'start=' + Math.floor(startAt) : '').catch(() => cmd('loadfile', url, 'replace'));
    },
    quit: () => {
      if (exited) return;
      write({ command: ['quit'] });
      setTimeout(() => { if (!exited) try { child.kill(); } catch (_) { /* gone */ } }, 2500);
    }
  }) && Object.defineProperty(ev, 'alive', { get: () => !exited });
}

module.exports = { findMpv, installMpv, createEngine, startMpv, serverCandidates, SERVER };
