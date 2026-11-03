'use strict';
// Movies & TV in the app core: the screens' requests, and playback (mpv + controls on top).

const path = require('path');
const { createStremio, bestStream } = require('./stremio');
const tvp = require('./tvplayer');
const { createTvControls } = require('./tvcontrols');

const SUBLANG = { en: 'en,eng', es: 'es,spa', fr: 'fr,fre,fra', de: 'de,ger,deu', pt: 'pt,por,pob', it: 'it,ita', off: 'off' };
const epLabel = (v) => (v && v.season ? 'S' + v.season + ':E' + v.episode + (v.title ? ' · ' + v.title : '') : '');

function setupTv(ctx) {
  const { app, safeStorage, shell, clipboard, BrowserWindow, handle, send, settings, targetDisplay, toPx, presentApp, bringBack, saveSettings } = ctx;
  let store = null;
  const tv = () => store || (store = createStremio(app.getPath('userData'), safeStorage));
  const engine = tvp.createEngine();
  let session = null;
  let hud = null;

  // The one you chose, else the launcher's own copy, else any mpv on this PC. Whatever is found
  // is remembered, so it's there straight away next time.
  const mpvPath = () => {
    const exe = tvp.findMpv(process.env, settings().mpvPath || null, app.getPath('userData'));
    if (exe && exe !== settings().mpvPath) { settings().mpvPath = exe; saveSettings(); }
    return exe;
  };
  const quality = () => settings().tvQuality || '1080p';

  // ---------- requests from the screens
  handle('tv:status', async () => {
    const s = tv().status();
    const exe = mpvPath();
    return Object.assign(s, { mpv: !!exe, mpvPath: exe, engine: engine.available(), playing: !!session });
  });
  handle('tv:linkCreate', () => tv().linkCreate());
  handle('tv:linkPoll', (code) => tv().linkPoll(code));
  handle('tv:login', (email, pw) => tv().login(email, pw));
  handle('tv:logout', () => tv().logout());
  handle('tv:addons', (force) => tv().addons(!!force).then(() => tv().addonList()));
  handle('tv:addonInstall', (url) => tv().addonInstall(url));
  handle('tv:addonClipboard', () => {
    const text = String(clipboard.readText() || '').trim();
    const m = /(stremio|https?):\/\/[^\s"'<>]+/i.exec(text);
    if (!m) throw new Error('Copy an addon link first (it ends in manifest.json), then press this again');
    return tv().addonInstall(m[0]);
  });
  handle('tv:addonRemove', (url) => tv().addonRemove(String(url || '')));
  handle('tv:addonMove', (url, dir) => tv().addonMove(String(url || ''), Number(dir) < 0 ? -1 : 1));
  handle('tv:addonConfigure', (url) => {
    const a = tv().addonByUrl(String(url || ''));
    if (!a) throw new Error('That addon isn’t installed');
    const page = String(a.transportUrl).replace(/\/manifest\.json(\?.*)?$/i, '') + '/configure';
    if (!/^https:\/\//i.test(page)) throw new Error('This addon can’t be set up from here');
    shell.openExternal(page);
    return true;
  });
  handle('tv:discover', () => { shell.openExternal('https://stremio-addons.net'); return true; });
  handle('tv:catalogs', () => tv().catalogs());
  handle('tv:catalog', (addon, type, id, extra) => tv().catalog(String(addon || ''), String(type || ''), String(id || ''), extra || {}));
  handle('tv:search', (q) => tv().search(String(q || '')));
  handle('tv:meta', (type, id) => tv().meta(String(type || ''), String(id || '')));
  handle('tv:streams', async (type, videoId) => {
    const r = await tv().streams(String(type || ''), String(videoId || ''));
    const flat = [].concat(...r.groups.map((g) => g.streams));
    const best = bestStream(flat, quality());
    r.best = best ? { addon: best.addon, label: best.label } : null;
    return r;
  });
  handle('tv:library', (force) => tv().library(!!force));
  handle('tv:libSet', (meta, on) => tv().setInLibrary(cleanMeta(meta), !!on));
  handle('tv:watched', (ids) => tv().watched(Array.isArray(ids) ? ids.map(String).slice(0, 500) : []));
  handle('tv:setWatched', (id, on) => tv().setWatched(String(id || ''), !!on));
  handle('tv:resumeAt', (id, videoId) => tv().resumeAt(String(id || ''), videoId ? String(videoId) : null));
  handle('tv:installMpv', async () => {
    const exe = await tvp.installMpv(app.getPath('userData'));
    settings().mpvPath = exe; saveSettings();
    return exe;
  });
  handle('tv:setMpv', (p) => {
    if (p && !(process.platform === 'darwin' ? /(\/mpv|mpv\.app\/?)$/i : /mpv(net)?\.exe$/i).test(String(p))) throw new Error(process.platform === 'darwin' ? 'Choose mpv (or mpv.app)' : 'Choose mpv.exe');
    settings().mpvPath = p ? String(p) : ''; saveSettings();
    return mpvPath();
  });
  handle('tv:play', (req) => play(req));

  function cleanMeta(m) {
    m = m || {};
    const videos = Array.isArray(m.videos) ? m.videos.slice(0, 2000).map((v) => ({ id: String(v.id), season: Number(v.season) || 0, episode: Number(v.episode) || 0, title: String(v.title || '').slice(0, 120) })) : [];
    return { id: String(m.id || ''), type: String(m.type || 'movie'), name: String(m.name || '').slice(0, 200), poster: typeof m.poster === 'string' ? m.poster : null, videos };
  }

  // ---------- playback
  function hudWindow() {
    if (hud && !hud.isDestroyed()) return hud;
    const b = targetDisplay().bounds;
    hud = new BrowserWindow({
      x: b.x, y: b.y, width: b.width, height: b.height, transparent: true, frame: false, show: false, focusable: false,
      skipTaskbar: true, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      hasShadow: false, backgroundColor: '#00000000',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
    });
    hud.setIgnoreMouseEvents(true);
    hud.setAlwaysOnTop(true, 'screen-saver');
    hud.loadFile(path.join(__dirname, 'renderer', 'hud.html'));
    hud.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    hud.webContents.on('will-navigate', (e) => e.preventDefault());
    hud.on('closed', () => { hud = null; });
    return hud;
  }
  const hudSend = (v) => { if (hud && !hud.isDestroyed()) hud.webContents.send('hud', v); };

  async function streamUrl(stream, video) {
    if (stream.url) {
      if (!/^https?:\/\/[^\s]+$/i.test(String(stream.url))) throw new Error('This stream’s link can’t be played');
      return String(stream.url);
    }
    if (stream.infoHash) return engine.torrentUrl(stream, video && video.season ? { season: video.season, episode: video.episode } : {});
    throw new Error('This stream can’t be played here');
  }
  function seasonList(meta, video) {
    if (!video || !meta.videos.length) return [];
    return meta.videos.filter((v) => v.season === video.season).map((v) => ({ id: v.id, label: 'E' + v.episode + (v.title ? ' · ' + v.title : ''), current: v.id === video.id }));
  }
  function nextVideo(meta, videoId) {
    const list = meta.videos.filter((v) => v.season > 0);
    const i = list.findIndex((v) => v.id === videoId);
    return i >= 0 && i + 1 < list.length ? list[i + 1] : null;
  }
  function infoFor(meta, video) {
    return { title: meta.name, subtitle: video ? epLabel(video) : '', isSeries: meta.type === 'series' && !!video, episodes: seasonList(meta, video) };
  }

  async function play(req) {
    req = req || {};
    const meta = cleanMeta(req.meta);
    if (!meta.id) throw new Error('Nothing to play');
    const exe = mpvPath();
    if (!exe) throw new Error('NO_MPV');
    const videoId = String(req.videoId || meta.id);
    const video = meta.videos.find((v) => v.id === videoId) || null;
    let stream = req.stream || (req.mode === 'resume' ? tv().lastStream(meta.id, videoId) : null);
    if (!stream) {
      const r = await tv().streams(meta.type, videoId);
      stream = bestStream([].concat(...r.groups.map((g) => g.streams)), quality());
      if (!stream) throw new Error('No playable streams for this. Check your addons.');
    }
    const url = await streamUrl(stream, video);
    tv().rememberStream(meta.id, videoId, stream);
    if (session) end('switch');
    const startAt = req.startAt != null ? Number(req.startAt) : tv().resumeAt(meta.id, videoId);
    const rect = toPx(targetDisplay().bounds);
    const mpv = tvp.startMpv(exe, {
      url, title: meta.name + (video ? ' · ' + epLabel(video) : ''), startAt, rect,
      subLang: SUBLANG[settings().tvSubLang || 'en'] || 'en,eng', headers: stream.headers || null
    });
    const s = session = { mpv, meta, video, videoId, stream, pos: startAt || 0, dur: 0, savedAt: Date.now(), subPicked: false, ended: false };
    s.controls = createTvControls({ act: (a, x) => onAct(s, a, x), render: hudSend });
    s.controls.setInfo(infoFor(meta, video));
    const h = hudWindow();
    h.setBounds(targetDisplay().bounds);
    h.showInactive();
    h.setAlwaysOnTop(true, 'screen-saver');
    s.stopPlace = presentApp(['mpv.exe'], 'Couch Launcher Player', 15000);
    s.timer = setInterval(() => {
      if (session !== s) return;
      s.controls.tick();
      const v = s.controls.view();
      if (v.visible || s.wasVisible) hudSend(v);
      s.wasVisible = v.visible;
      if (Date.now() - s.savedAt > 10000 && s.dur > 0 && s.pos > 5) { s.savedAt = Date.now(); tv().progress(meta, s.videoId, s.pos, s.dur); }
    }, 250);
    wire(s);
    loadSubs(s);
    return { ok: true };
  }
  function wire(s) {
    const { mpv } = s;
    mpv.on('time', ({ pos, dur }) => { if (session !== s) return; s.pos = pos; if (dur > 0) s.dur = dur; s.controls.setTime(pos, dur); });
    mpv.on('pause', (p) => { if (session === s) { s.paused = !!p; s.controls.setPaused(p); } });
    mpv.on('buffering', (b) => { if (session === s) s.controls.setBuffering(b); });
    mpv.on('tracks', (t) => {
      if (session !== s) return;
      s.controls.setTracks(t);
      // Subtitles from addons arrive after the video starts: turn on your language if nothing is on.
      const pref = settings().tvSubLang || 'en';
      if (!s.subPicked && pref !== 'off' && t.subs.length && !t.subs.some((x) => x.selected)) {
        const codes = (SUBLANG[pref] || pref).split(',');
        const m = t.subs.find((x) => codes.includes(String(x.lang).toLowerCase()));
        if (m) { s.subPicked = true; mpv.setSub(m.id); }
      }
    });
    mpv.on('eof', () => onEof(s));
    mpv.on('exit', () => { if (session === s) end('closed'); });
  }
  async function loadSubs(s) {
    try {
      const subs = await tv().subtitles(s.meta.type, s.videoId);
      if (session === s && subs.length) s.mpv.addSubs(subs);
    } catch (_) { /* no subtitles is fine */ }
  }
  function saveProgress(s) {
    if (s.dur > 0 && s.pos > 5) tv().progress(s.meta, s.videoId, s.pos, s.dur);
  }
  function onEof(s) {
    if (session !== s) return;
    tv().progress(s.meta, s.videoId, s.dur || s.pos, s.dur || s.pos);
    const n = s.meta.type === 'series' ? nextVideo(s.meta, s.videoId) : null;
    if (n) s.controls.showUpNext(epLabel(n), 10);
    else end('finished');
  }
  async function playVideo(s, videoId) {
    const video = s.meta.videos.find((v) => v.id === videoId);
    if (!video) return;
    saveProgress(s);
    try {
      const r = await tv().streams(s.meta.type, videoId);
      const stream = bestStream([].concat(...r.groups.map((g) => g.streams)), quality(), s.stream.bingeGroup);
      if (!stream) throw new Error('No stream found for ' + epLabel(video));
      const url = await streamUrl(stream, video);
      if (session !== s) return;
      Object.assign(s, { video, videoId, stream, pos: 0, dur: 0, subPicked: false });
      tv().rememberStream(s.meta.id, videoId, stream);
      await s.mpv.load(url, s.meta.name + ' · ' + epLabel(video), tv().resumeAt(s.meta.id, videoId));
      s.mpv.pause(false);
      s.controls.setInfo(infoFor(s.meta, video));
      loadSubs(s);
    } catch (e) {
      if (session === s) { hudSend(Object.assign(s.controls.view(), { visible: true, error: e.message })); setTimeout(() => { if (session === s) end('error', e.message); }, 3500); }
    }
  }
  function onAct(s, a, x) {
    if (session !== s) return;
    const m = s.mpv;
    switch (a) {
      case 'toggle': return m.togglePause();
      case 'seekTo': return m.seek(x, 'absolute');
      case 'seekBy': return m.seek(x, 'relative');
      case 'sub': s.subPicked = true; return m.setSub(x);
      case 'audio': return m.setAudio(x);
      case 'episode': return playVideo(s, x);
      case 'next': { const n = nextVideo(s.meta, s.videoId); return n ? playVideo(s, n.id) : end('finished'); }
      case 'exit': return end('back');
      default: return null;
    }
  }
  function end(reason, error) {
    const s = session;
    if (!s || s.ended) return;
    s.ended = true;
    session = null;
    saveProgress(s);
    clearInterval(s.timer);
    if (s.stopPlace) s.stopPlace();
    s.mpv.quit();
    if (hud && !hud.isDestroyed()) { hudSend({ visible: false }); hud.hide(); }
    tv().flush();
    if (reason !== 'switch') {
      bringBack(false);
      send('tv:ended', { id: s.meta.id, videoId: s.videoId, reason, error: error || null });
    }
  }

  return {
    get playing() { return !!session; },
    input(mask, lx, ly) { if (session && session.controls) session.controls.input(mask, lx, ly); },
    stop: (reason) => end(reason || 'back'),
    // The guide over what you're watching: pause (and hide the player controls) while it's open,
    // carry on when it closes. Something you'd already paused stays paused.
    pauseForGuide() {
      const s = session;
      if (!s) return;
      if (!s.inGuide) s.resumeAfterGuide = !s.paused;
      s.inGuide = true;
      s.mpv.pause(true);
      if (hud && !hud.isDestroyed()) { hudSend({ visible: false }); hud.hide(); }
    },
    resumeFromGuide() {
      const s = session;
      if (!s || !s.inGuide) return;
      s.inGuide = false;
      if (s.resumeAfterGuide) s.mpv.pause(false);
      s.resumeAfterGuide = false;
      const h = hudWindow();
      h.setBounds(targetDisplay().bounds);
      h.showInactive();
      h.setAlwaysOnTop(true, 'screen-saver');
    },
    get inGuide() { return !!(session && session.inGuide); },
    now() {
      const s = session;
      if (!s) return null;
      return { title: s.meta.name, subtitle: s.video ? epLabel(s.video) : '', poster: s.meta.poster || null, pos: Math.round(s.pos || 0), dur: Math.round(s.dur || 0), paused: !s.resumeAfterGuide };
    },
    quit() { if (session) end('quit'); if (store) store.flush(); if (hud && !hud.isDestroyed()) hud.destroy(); }
  };
}

module.exports = { setupTv, SUBLANG };
