'use strict';
// Movies & TV in the app core: the screens' requests, and playback (mpv + controls on top).

const path = require('path');
const { createStremio, bestStream } = require('./stremio');
const tvp = require('./tvplayer');
const { createTvControls } = require('./tvcontrols');
const { createCable, locate } = require('./cable');
const { createYtdlp } = require('./ytdlp');
const { createCableControls } = require('./cablecontrols');

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

  // ---------- Cable TV
  let cableObj = null, ytdlpObj = null;
  const ytdlp = () => ytdlpObj || (ytdlpObj = createYtdlp(path.join(app.getPath('userData'), 'bin')));
  const cable = () => cableObj || (cableObj = createCable({
    tv: tv(), file: path.join(app.getPath('userData'), 'cable.json'),
    ytdlp: { search: (q, n) => ytdlp().search(q, n) },
    ads: () => settings().cableAds !== false
  }));
  // Looks up the channels' shows the first time (a minute or so), telling the screen how far it got.
  handle('tv:cableSetup', async () => {
    // yt-dlp for the commercials, fetched alongside (no waiting on it).
    if (settings().cableAds !== false) ytdlp().install().catch(() => {});
    const r = await cable().ensure((done, total) => send('tv:cableProgress', { done, total }));
    return Object.assign({ ready: cable().ready() }, r);
  });
  handle('tv:cableGuide', (from, to) => {
    const f = Number(from) || Date.now();
    const t = Math.min(f + 12 * 3600e3, Number(to) || f + 3 * 3600e3);
    return { ready: cable().ready(), busy: cable().resolving, channels: cable().guide(f, t), now: Date.now() };
  });
  handle('tv:cableTune', (id) => tune(String(id || '')));
  handle('tv:cableLineup', () => cable().lineup());
  handle('tv:cableAdd', (ch, meta) => cable().addShow(String(ch || ''), { id: String((meta && meta.id) || ''), name: String((meta && meta.name) || '').slice(0, 200) }));
  handle('tv:cableRemove', (ch, i) => cable().removeShow(String(ch || ''), Number(i) | 0));
  handle('tv:cableReset', (ch) => cable().resetChannel(String(ch || '')));

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
  // Tune to a channel: the screen goes black with the channel number, then whatever is airing
  // right now plays from where the schedule is: the show (in acts) or a commercial break.
  async function tune(channelId) {
    if (!cable().channel(channelId)) throw new Error('No such channel');
    const exe = mpvPath();
    if (!exe) throw new Error('NO_MPV');
    let s = session && session.cable ? session : null;
    if (!s) {
      if (session) end('switch');
      s = session = { cable: { channelId, token: 0, partTok: 0, segI: -1 }, mpv: null, meta: null, video: null, videoId: null, pos: 0, dur: 0, ended: false, exe };
      s.controls = createCableControls({ act: (a, x) => onCableAct(s, a, x), render: hudSend });
      const h = hudWindow();
      h.setBounds(targetDisplay().bounds);
      h.showInactive();
      h.setAlwaysOnTop(true, 'screen-saver');
      s.timer = setInterval(() => cableTick(s), 250);
    }
    cableLoad(s, channelId);
    return { ok: true };
  }
  const clock = (t) => { const d = new Date(t); let h = d.getHours(); const m = d.getMinutes(); const pm = h >= 12; h = h % 12 || 12; return h + ':' + String(m).padStart(2, '0') + (pm ? ' PM' : ' AM'); };
  const where = (c) => locate(c.plan, (Date.now() - c.prog.start) / 1000);
  // Every quarter second: on to the next part (act / break) or program when it's time, and get
  // the next break's commercial and the next program's episode ready ahead of time.
  function cableTick(s) {
    if (session !== s) return;
    s.controls.tick();
    const c = s.cable;
    if (s.inGuide || c.busy) return;
    const t = Date.now();
    if (!c.prog || t >= c.prog.end) { if (c.prog || t - (c.triedAt || 0) > 60e3) cableLoad(s, c.channelId); return; }
    const loc = where(c);
    if (!loc) return;
    if (loc.i !== c.segI) { playPart(s, loc); return; }
    const next = c.plan[loc.i + 1];
    if (next && next.kind === 'ad' && loc.left < 45 && !c.nextAd && !c.adPrep) {
      c.adPrep = true;
      prepareAd(c.channelId, next.len).then((ad) => { if (ad) c.nextAd = ad; }).catch(() => {}).finally(() => { c.adPrep = false; });
    }
    if (c.prog.end - t < 60e3 && !c.prefetched) {
      c.prefetched = true;
      const n = c.info && c.info.next && c.info.next[0];
      if (n) tv().streams('series', n.video.id).catch(() => {});
    }
  }
  // A new program: a channel was picked, or the last one's time slot ended.
  function cableLoad(s, channelId) {
    const c = s.cable;
    const token = ++c.token;
    c.channelId = channelId;
    c.triedAt = Date.now();
    c.segI = -1; c.nextAd = null; c.prefetched = false; c.learned = false; c.lastKind = null;
    const info = cable().at(channelId);
    c.info = info;
    c.prog = info && info.now;
    c.plan = c.prog ? cable().plan(c.prog) : null;
    s.controls.tuning(info);
    if (s.mpv && s.mpv.alive) s.mpv.pause(true);
    if (!c.prog) {
      s.controls.status(info && info.channel.found ? 'Nothing on right now' : 'This channel’s shows haven’t been found yet');
      return;
    }
    const prog = c.prog;
    s.meta = { id: prog.showId, type: 'series', name: prog.show, poster: prog.poster || null, videos: [] };
    s.video = prog.video; s.videoId = prog.video.id; s.pos = 0; s.dur = 0; s.subPicked = false;
    // The episode, found in the background (a commercial break can play meanwhile).
    c.ep = (async () => {
      const r = await tv().streams('series', prog.video.id);
      const stream = bestStream([].concat(...r.groups.map((g) => g.streams)), quality());
      if (!stream) throw new Error('No stream found for this episode');
      return { stream, url: await streamUrl(stream, prog.video) };
    })();
    c.ep.catch(() => {});
    playPart(s, where(c), token);
    // The neighbors' episodes, looked up ahead so flipping is quicker.
    for (const d of [1, -1]) { const n = cable().at(cable().neighbor(channelId, d)); if (n && n.now) tv().streams('series', n.now.video.id).catch(() => {}); }
  }
  // Plays one part of the program: an act of the show, or a commercial break.
  async function playPart(s, loc) {
    const c = s.cable;
    if (!loc) return;
    const token = c.token, partTok = ++c.partTok;
    const stale = () => session !== s || token !== c.token || partTok !== c.partTok;
    const part = loc.part, prog = c.prog, chName = c.info.channel.name;
    const from = c.lastKind;
    c.segI = loc.i; c.lastKind = part.kind; c.busy = true;
    try {
      if (part.kind === 'show') {
        // Coming back from commercials: a straight cut (a moment of black, like real TV).
        if (from === 'ad' || from === 'filler') s.controls.cut();
        else s.controls.status('Finding ' + prog.show + '…');
        const ep = await c.ep;
        if (stale()) return;
        const l2 = where(c);
        if (!l2 || l2.i !== loc.i) return; // that act is over already: the tick moves on
        s.stream = ep.stream;
        await loadInto(s, ep.url, chName + ' · ' + prog.show, l2.part.from + l2.into, partTok);
        if (stale()) return;
        s.controls.part('show');
        loadSubs(s);
      } else {
        const backAt = part.end ? 0 : Date.now() + loc.left * 1000;
        // Into the break: a straight cut, like real TV.
        if (from === 'show') s.controls.cut();
        const ad = settings().cableAds === false ? null : await pickAd(s, loc.left);
        if (stale()) return;
        const l2 = where(c);
        if (!l2 || l2.i !== loc.i) return; // the break ended while it was found: the tick moves on
        if (!ad) {
          // No commercials (off, or none found): a card until the break is over.
          if (s.mpv && s.mpv.alive) s.mpv.pause(true);
          c.lastKind = 'filler';
          s.controls.part('filler', backAt);
          return;
        }
        await loadInto(s, ad.url, chName + ' · Commercials', ad.start, partTok);
        if (stale()) return;
        s.controls.part('ad', backAt);
      }
    } catch (e) {
      if (stale()) return;
      if (s.mpv && s.mpv.alive) s.mpv.pause(true);
      s.controls.tuning(c.info);
      const n = c.info && c.info.next && c.info.next[0];
      s.controls.status(e.message + (n ? '. Next: ' + n.show + ' at ' + clock(n.start) : ''));
    } finally {
      if (partTok === c.partTok) c.busy = false;
    }
  }
  // Opens a file in the player at a spot (starting the player the first time).
  async function loadInto(s, url, title, at, partTok) {
    if (!s.mpv || !s.mpv.alive) {
      s.mpv = tvp.startMpv(s.exe, { url, title, startAt: at, rect: toPx(targetDisplay().bounds), subLang: SUBLANG[settings().tvSubLang || 'en'] || 'en,eng', headers: (s.stream && s.stream.headers) || null });
      if (s.stopPlace) s.stopPlace();
      s.stopPlace = presentApp(['mpv.exe'], 'Couch Launcher Player', 15000);
      wire(s);
    } else {
      s.loading = { at: Date.now(), expect: at > 5 ? at : 0 };
      await s.mpv.load(url, title, at);
      s.mpv.pause(false);
    }
    // Black until the picture actually moves.
    s.cable.waitPlay = partTok;
    setTimeout(() => { if (session === s && s.cable.waitPlay === partTok) { s.cable.waitPlay = null; s.controls.playing(); } }, 20000);
  }
  // A commercial break: a random stretch of an old commercial-break recording from YouTube.
  async function prepareAd(channelId, need) {
    const list = await cable().adsFor(channelId);
    if (!list.length) return null;
    const long = list.filter((v) => v.duration >= need + 20);
    const pool = long.length ? long : list;
    for (let tries = 0; tries < 3; tries++) {
      const v = pool[Math.floor(Math.random() * pool.length)];
      const room = v.duration - need - 10;
      const start = room > 10 ? 10 + Math.floor(Math.random() * room) : 0;
      try { return { channelId, id: v.id, url: await ytdlp().directUrl(v.id), start }; } catch (_) { /* try another */ }
    }
    return null;
  }
  async function pickAd(s, need) {
    const c = s.cable;
    const ready = c.nextAd && c.nextAd.channelId === c.channelId ? c.nextAd : null;
    c.nextAd = null;
    if (ready) return ready;
    try { return await prepareAd(c.channelId, need); } catch (_) { return null; }
  }
  function onCableAct(s, a, x) {
    if (session !== s) return;
    if (a === 'chan') return cableLoad(s, cable().neighbor(s.cable.channelId, x > 0 ? 1 : -1));
    if (a === 'exit') return end('back');
    return null;
  }
  function wire(s) {
    const { mpv } = s;
    mpv.on('time', ({ pos, dur }) => {
      if (session !== s) return;
      // Switching episodes: the old one's last positions can still arrive. Skip them until the
      // new one is near where it should start, so its spot isn't saved as the old one's.
      if (s.loading) { if (Math.abs(pos - s.loading.expect) < 20 || Date.now() - s.loading.at > 8000) s.loading = null; else return; }
      s.pos = pos; if (dur > 0) s.dur = dur; s.controls.setTime(pos, dur);
      if (s.cable) {
        // The picture is moving, so the black screen can go.
        if (s.cable.waitPlay && pos > 0) { s.cable.waitPlay = null; s.controls.playing(); }
        // The episode's real length: the breaks are placed by it (and it's kept for next time).
        if (s.cable.lastKind === 'show' && dur > 60 && !s.cable.learned && s.cable.prog) {
          s.cable.learned = true;
          if (cable().learnDuration(s.cable.prog.video.id, dur)) s.cable.plan = cable().plan(s.cable.prog);
        }
      }
    });
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
    mpv.on('eof', () => {
      if (!s.cable) return onEof(s);
      if (session !== s || s.cable.busy) return;
      const c = s.cable;
      // A commercial recording ran out: another one for the rest of the break.
      if (c.lastKind === 'ad') { c.segI = -1; return; }
      // The episode ended earlier than planned: its real length places the breaks from now on,
      // and the rest of the slot goes to commercials.
      if (c.lastKind === 'show' && c.prog) {
        if (s.dur > 60) cable().learnDuration(c.prog.video.id, s.dur);
        c.plan = cable().plan(c.prog);
        const loc = where(c);
        if (loc && loc.part.kind === 'show') {
          // Still "show time" by the plan: fill it with a break that ends with the slot's.
          c.plan = c.plan.slice(0, loc.i).concat([{ kind: 'show', from: loc.part.from, to: loc.part.from + loc.into }, { kind: 'ad', len: Math.max(1, Math.round((c.prog.end - Date.now()) / 1000)), end: true }]);
        }
        c.segI = -1;
      }
    });
    mpv.on('exit', () => { if (session === s) end('closed'); });
  }
  async function loadSubs(s) {
    try {
      const subs = await tv().subtitles(s.meta.type, s.videoId);
      if (session === s && subs.length) s.mpv.addSubs(subs);
    } catch (_) { /* no subtitles is fine */ }
  }
  function saveProgress(s) {
    if (s.cable) return; // live TV doesn't go in Continue Watching
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
      const startAt = tv().resumeAt(s.meta.id, videoId);
      Object.assign(s, { video, videoId, stream, pos: startAt > 5 ? startAt : 0, dur: 0, subPicked: false, loading: { at: Date.now(), expect: startAt > 5 ? startAt : 0 } });
      tv().rememberStream(s.meta.id, videoId, stream);
      await s.mpv.load(url, s.meta.name + ' · ' + epLabel(video), startAt);
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
    if (s.mpv) s.mpv.quit();
    if (hud && !hud.isDestroyed()) { hudSend({ visible: false }); hud.hide(); }
    tv().flush();
    if (reason !== 'switch') {
      bringBack(false);
      send('tv:ended', { id: s.meta ? s.meta.id : null, videoId: s.videoId, reason, error: error || null, cable: s.cable ? s.cable.channelId : null });
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
      if (s.mpv && s.mpv.alive) s.mpv.pause(true);
      if (hud && !hud.isDestroyed()) { hudSend({ visible: false }); hud.hide(); }
    },
    resumeFromGuide() {
      const s = session;
      if (!s || !s.inGuide) return;
      s.inGuide = false;
      // Cable keeps "airing" while the guide is open: tune back in to where it is now.
      if (s.cable) cableLoad(s, s.cable.channelId);
      else if (s.resumeAfterGuide) s.mpv.pause(false);
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
      if (s.cable) {
        const c = cable().channel(s.cable.channelId), p = s.cable.prog;
        return { title: (c ? c.name : 'Cable TV') + (p ? ' · ' + p.show : ''), subtitle: s.video ? epLabel(s.video) : '', poster: p ? p.poster : null, pos: p ? Math.round((Date.now() - p.start) / 1000) : 0, dur: p ? Math.round((p.end - p.start) / 1000) : 0, paused: false, live: true };
      }
      if (!s.meta) return null;
      return { title: s.meta.name, subtitle: s.video ? epLabel(s.video) : '', poster: s.meta.poster || null, pos: Math.round(s.pos || 0), dur: Math.round(s.dur || 0), paused: !s.resumeAfterGuide };
    },
    quit() { if (session) end('quit'); if (store) store.flush(); if (cableObj) cableObj.flush(); if (hud && !hud.isDestroyed()) hud.destroy(); }
  };
}

module.exports = { setupTv, SUBLANG };
