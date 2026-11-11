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
  // (Couch TV keeps all of this in the launcher's folder, so both have the same addons, list,
  // history, channels and player: ctx.dataDir. ctx.storeOpts: how it shares the sign-in.)
  const dataDir = ctx.dataDir || app.getPath('userData');
  const playerTitle = ctx.playerTitle || 'Couch Launcher Player';
  const tv = () => store || (store = createStremio(dataDir, safeStorage, ctx.storeOpts || undefined));
  const engine = tvp.createEngine();
  let session = null;
  let hud = null;

  // The one you chose, else the launcher's own copy, else any mpv on this PC. Whatever is found
  // is remembered, so it's there straight away next time.
  const mpvPath = () => {
    const exe = tvp.findMpv(process.env, settings().mpvPath || null, dataDir);
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
    const exe = await tvp.installMpv(dataDir);
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
  const ytdlp = () => ytdlpObj || (ytdlpObj = createYtdlp(path.join(dataDir, 'bin')));
  const cable = () => cableObj || (cableObj = createCable({
    tv: tv(), file: path.join(dataDir, 'cable.json'),
    ytdlp: { search: (q, n) => ytdlp().search(q, n) },
    ads: () => settings().cableAds !== false
  }));
  // Looks up the channels' shows the first time (a minute or so), telling the screen how far it got.
  handle('tv:cableSetup', async () => {
    // yt-dlp for the commercials, fetched alongside (no waiting on it).
    if (settings().cableAds !== false) ytdlp().install().then(() => ytdlp().runtime()).catch(() => {});
    const r = await cable().ensure((done, total) => send('tv:cableProgress', { done, total }));
    return Object.assign({ ready: cable().ready() }, r);
  });
  handle('tv:cableGuide', (from, to) => {
    const f = Number(from) || Date.now();
    const t = Math.min(f + 12 * 3600e3, Number(to) || f + 3 * 3600e3);
    const ready = cable().ready();
    // Week-old shows are looked up again quietly (new episodes, air dates).
    if (ready && !cable().resolving && cable().stale()) cable().ensure().catch(() => {});
    return { era: cable().era(), ready, busy: cable().resolving, channels: ready ? cable().guide(f, t) : [], now: Date.now() };
  });
  // The eras (2000s, 2010s, 2020s): which are set up, and picking one (it's set up when picked).
  handle('tv:cableEras', () => cable().eras());
  handle('tv:cableSetEras', (ids) => {
    if (session && session.cable) throw new Error('Stop watching first');
    return cable().setEras((Array.isArray(ids) ? ids : [ids]).map(String).slice(0, 3));
  });
  handle('tv:cableTune', (id) => tune(String(id || '')));
  // (era: whose line-up, when eras are merged.)
  const eraArg = (e) => (e ? String(e) : null);
  handle('tv:cableLineup', (era) => ({ mix: cable().mix(), channels: cable().lineup(eraArg(era)) }));
  handle('tv:cableAdd', (ch, meta, era) => cable().addShow(String(ch || ''), { id: String((meta && meta.id) || ''), name: String((meta && meta.name) || '').slice(0, 200) }, eraArg(era)));
  handle('tv:cableRemove', (ch, i, era) => cable().removeShow(String(ch || ''), Number(i) | 0, eraArg(era)));
  handle('tv:cableReset', (ch, era) => cable().resetChannel(String(ch || ''), eraArg(era)));

  function cleanMeta(m) {
    m = m || {};
    const videos = Array.isArray(m.videos) ? m.videos.slice(0, 2000).map((v) => ({ id: String(v.id), season: Number(v.season) || 0, episode: Number(v.episode) || 0, title: String(v.title || '').slice(0, 120) })) : [];
    return { id: String(m.id || ''), type: String(m.type || 'movie'), name: String(m.name || '').slice(0, 200), poster: typeof m.poster === 'string' ? m.poster : null, videos };
  }

  // ---------- playback
  // Couch TV (Windows): the picture is drawn inside its window instead of over the whole
  // screen. ctx.embed says how: wid() is that window's handle (null: full screen, as in the
  // launcher), bounds() where its inside is on the screen, parent() the window itself,
  // fullscreen() switches it to full screen and back. The controls are then a see-through
  // window that belongs to it, lies exactly over its inside, and takes the mouse.
  const emb = () => { try { return ctx.embed && ctx.embed.wid() ? ctx.embed : null; } catch (_) { return null; } };
  function hudWindow(e) {
    if (hud && !hud.isDestroyed() && hud.inWindow === !!e) return hud;
    if (hud && !hud.isDestroyed()) hud.destroy();
    const b = e ? e.bounds() : targetDisplay().bounds;
    hud = new BrowserWindow(Object.assign({
      x: b.x, y: b.y, width: b.width, height: b.height, transparent: true, frame: false, show: false, focusable: false,
      skipTaskbar: true, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      hasShadow: false, backgroundColor: '#00000000',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
    }, e ? { parent: e.parent() } : {}));
    hud.inWindow = !!e;
    // The controls never take the mouse themselves (on a PC with a graphics card a see-through
    // window can't be relied on to: clicks went straight through it). Inside Couch TV's window
    // the mouse reaches what is under them instead: the player's picture, or Couch TV's page
    // where there is no picture yet, and each passes it on (hudMouse below).
    hud.setIgnoreMouseEvents(true);
    if (!e) hud.setAlwaysOnTop(true, 'screen-saver');
    hud.loadFile(path.join(__dirname, 'renderer', 'hud.html'), e ? { query: { mouse: '1' } } : undefined);
    hud.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    hud.webContents.on('will-navigate', (e) => e.preventDefault());
    { const h = hud; h.on('closed', () => { if (hud === h) hud = null; }); }
    // A crashed controls page is thrown away (made again the next time it's needed).
    { const h = hud; h.webContents.on('render-process-gone', () => { try { if (!h.isDestroyed()) h.destroy(); } catch (_) { /* gone */ } }); }
    return hud;
  }
  const hudSend = (v) => { if (hud && !hud.isDestroyed()) hud.webContents.send('hud', v); };
  // The controls, shown where this session's picture is.
  function showHud(s) {
    const e = s.embed || null, h = hudWindow(e);
    h.setBounds(e ? e.bounds() : targetDisplay().bounds);
    h.showInactive();
    if (!e) h.setAlwaysOnTop(true, 'screen-saver');
  }
  // The player's window: put over the screen (the launcher), or left where it is drawn (Couch TV).
  const place = (s) => (s.embed ? () => {} : presentApp(['mpv.exe'], playerTitle, 15000));
  // A click or the mouse moving over the controls (Couch TV).
  // Where the pointer is / was clicked, as parts of the picture's width and height.
  let lastMove = 0;
  function hudMouse(s, t, x, y) {
    if (!s || s !== session || !s.embed || !hud || hud.isDestroyed() || !hud.inWindow) return false;
    if (!['move', 'click', 'leave', 'back'].includes(t) || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (t === 'move') { const n = Date.now(); if (n - lastMove < 30) return true; lastMove = n; }
    if (t === 'back') { if (s.controls && typeof s.controls.key === 'function') s.controls.key('B', false, 0); return true; }
    mouseSeen.push(t[0]); if (mouseSeen.length > 40) mouseSeen.shift();
    hud.webContents.send('hud:mouse', { t, x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) });
    return true;
  }
  const mouseSeen = [];
  handle('hud:mouse', (t, x, y) => hudMouse(session, String(t || ''), Number(x), Number(y)));
  const hudActs = []; // the last few, for the player report (Couch TV › Settings › About)
  handle('hud:act', (a, x) => {
    hudActs.push([Date.now(), String(a || '').slice(0, 12)]); if (hudActs.length > 24) hudActs.shift();
    const s = session;
    if (!s || !s.embed || !s.controls) return false;
    a = String(a || '');
    if (a === 'fullscreen') { s.embed.fullscreen(); return true; }
    if (a === 'front') { s.embed.front(); return true; }
    if (typeof s.controls.mouse === 'function') s.controls.mouse(a, typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' ? x.slice(0, 8) : null);
    return true;
  });

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
    await tvp.extrasOk(exe); // (which optional switches this mpv accepts)
    if (session) end('switch');
    const startAt = req.startAt != null ? Number(req.startAt) : tv().resumeAt(meta.id, videoId);
    const rect = toPx(targetDisplay().bounds);
    const embed = emb();
    const mpv = tvp.startMpv(exe, {
      wid: embed ? embed.wid() : null,
      url, title: meta.name + (video ? ' · ' + epLabel(video) : ''), startAt, rect,
      subLang: SUBLANG[settings().tvSubLang || 'en'] || 'en,eng', headers: stream.headers || null
    });
    const s = session = { mpv, meta, video, videoId, stream, pos: startAt || 0, dur: 0, savedAt: Date.now(), subPicked: false, ended: false, embed };
    s.controls = createTvControls({ act: (a, x) => onAct(s, a, x), render: hudSend });
    s.controls.setInfo(infoFor(meta, video));
    showHud(s);
    s.stopPlace = place(s);
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
    if (settings().cableAds !== false) ytdlp().install().then(() => ytdlp().runtime()).catch(() => {});
    let s = session && session.cable ? session : null;
    if (!s) {
      if (session) end('switch');
      s = session = { cable: { channelId, token: 0, partTok: 0, segI: -1 }, mpv: null, meta: null, video: null, videoId: null, pos: 0, dur: 0, ended: false, exe, embed: emb() };
      s.controls = createCableControls({ act: (a, x) => onCableAct(s, a, x), render: hudSend });
      showHud(s);
      s.timer = setInterval(() => cableTick(s), 250);
    }
    cableLoad(s, channelId);
    return { ok: true };
  }
  const clock = (t) => { const d = new Date(t); let h = d.getHours(); const m = d.getMinutes(); const pm = h >= 12; h = h % 12 || 12; return h + ':' + String(m).padStart(2, '0') + (pm ? ' PM' : ' AM'); };
  const where = (c) => locate(c.plan, (Date.now() - c.prog.start) / 1000);
  const within = (ms, p) => new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('That took too long')), ms); p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); }); });
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
    // If it can't be found, another one goes on in its place: more of the same show, then the
    // channel's other shows.
    c.ep = (async () => {
      const find = (video) => within(30000, (async () => {
        const r = await tv().streams('series', video.id);
        let list = [].concat(...r.groups.map((g) => g.streams));
        // The best stream, or the next ones when that turns out to be a debrid notice
        // ("file was removed…", "download failed…") instead of the episode.
        for (let n = 0; n < 3; n++) {
          const stream = bestStream(list, quality());
          if (!stream) break;
          list = list.filter((x) => x !== stream);
          let url;
          try { url = await streamUrl(stream, video); } catch (e) { if (n === 0 && !list.some((x) => x.playable)) throw e; continue; }
          if (stream.url && await isNotice(url, stream.headers)) continue;
          return { stream, url };
        }
        throw new Error('No stream found for this episode');
      })());
      let err = null;
      if (!cable().isBad(prog.video.id)) {
        try { return await find(prog.video); } catch (e) { err = e; cable().markBad(prog.video.id); }
      }
      for (const alt of cable().alternates(channelId, prog, 6)) {
        if (session !== s || token !== c.token) break;
        let got;
        try { got = await find(alt.video); } catch (_) { cable().markBad(alt.video.id); continue; }
        if (session !== s || token !== c.token) break;
        const np = cable().substitute(channelId, prog, alt);
        if (np) {
          Object.assign(prog, np);
          s.meta = { id: prog.showId, type: 'series', name: prog.show, poster: prog.poster || null, videos: [] };
          s.video = prog.video; s.videoId = prog.video.id;
          c.plan = cable().plan(prog);
        }
        return got;
      }
      throw err || new Error('No stream found for this episode');
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
          s.controls.part('filler', backAt, settings().cableAds === false ? '' : adWhy);
          return;
        }
        c.ad = ad;
        await loadInto(s, ad.url, chName + ' · Commercials', ad.start, partTok, ad);
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
  // ad: a commercial (see prepareAd): its picture and sound may be two links. Played that way
  // when the player is already open and takes it; otherwise from its one-file link.
  async function loadInto(s, url, title, at, partTok, ad) {
    const two = !!(ad && ad.audio);
    if (two && noSeparateAudio && ad.plain) { url = ad.plain; ad.audio = null; }
    else if (two && (!s.mpv || !s.mpv.alive)) { if (!ad.plain) throw new Error('This commercial needs the player open'); url = ad.plain; ad.audio = null; }
    if (!s.mpv || !s.mpv.alive) {
      await tvp.extrasOk(s.exe); // (which optional switches this mpv accepts)
      s.mpv = tvp.startMpv(s.exe, { wid: s.embed ? s.embed.wid() : null, url, title, startAt: at, rect: toPx(targetDisplay().bounds), subLang: SUBLANG[settings().tvSubLang || 'en'] || 'en,eng', headers: (s.stream && s.stream.headers) || null, idle: true });
      if (s.stopPlace) s.stopPlace();
      s.stopPlace = place(s);
      wire(s);
    } else {
      s.loading = { at: Date.now(), expect: at > 5 ? at : 0 };
      try { await s.mpv.load(url, title, at, ad && ad.audio ? { audio: ad.audio } : null); }
      catch (e) {
        // This mpv won't take picture and sound apart: the one-file link, from now on.
        if (!(e && e.code === 'NO_SEPARATE_AUDIO') || !ad || !ad.plain) throw e;
        noSeparateAudio = true; ad.audio = null;
        await s.mpv.load(ad.plain, title, at);
      }
      s.mpv.pause(false);
      // Fail-safe: picture running but no sound came with it (its link didn't open): the same
      // commercial from its one-file link, from where it is.
      if (ad && ad.audio && ad.plain) {
        s.audioTracks = -1;
        setTimeout(() => {
          if (session !== s || !s.cable || s.cable.ad !== ad || s.cable.lastKind !== 'ad' || !ad.audio || !s.mpv || !s.mpv.alive) return;
          if (s.audioTracks !== 0 || !(s.pos > 0)) return;
          ad.audio = null;
          s.loading = { at: Date.now(), expect: s.pos > 5 ? s.pos : 0 };
          s.mpv.load(ad.plain, title, s.pos).then(() => s.mpv.pause(false)).catch(() => {});
        }, 6000);
      }
    }
    // Black until the picture actually moves.
    const c = s.cable, show = c.lastKind === 'show', prog = c.prog;
    c.waitPlay = partTok;
    setTimeout(() => {
      if (session !== s || c.waitPlay !== partTok) return;
      c.waitPlay = null;
      // An episode that never started (a dead stream): another one goes on instead, twice at most
      // per time slot.
      if (show && prog && c.prog === prog && !s.inGuide && !(s.pos > 0) && cableSwap(s, prog)) return;
      s.controls.playing();
    }, show ? 30000 : 20000);
  }
  // Debrid addons answer a link they can't serve by sending the player to a ready-made notice
  // video ("file was removed from debrid service", "download failed", "failed to…"). Seen from
  // where the link leads: a file with such a name. (If that can't be checked, the link is used.)
  const NOTICE = /(fail|remov|error|block|limit|downloading|infring|unavailable|not[_-]?found|expired|denied|no[_-]?video)[^/]*\.(mp4|mkv|webm)$/i;
  async function isNotice(url, headers) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    try {
      let at = url;
      for (let hop = 0; hop < 4; hop++) {
        const res = await fetch(at, { method: 'GET', redirect: 'manual', headers: Object.assign({ Range: 'bytes=0-0' }, headers || {}), signal: ctl.signal });
        const to = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
        if (!to) return false;
        const next = new URL(to, at);
        if (!/^https?:$/.test(next.protocol)) return false;
        if (NOTICE.test(next.pathname)) return true;
        at = next.href;
      }
      return false;
    } catch (_) { return false; } finally { clearTimeout(timer); ctl.abort(); }
  }
  // The episode on now turned out unplayable: it's remembered as bad and another one goes on in
  // its place (three times at most per time slot, so it can't go round in circles).
  function cableSwap(s, prog) {
    const c = s.cable;
    if (c.failSlot !== prog.start) { c.failSlot = prog.start; c.fails = 0; }
    if (c.fails >= 3) return false;
    c.fails++;
    cable().markBad(prog.video.id);
    cableLoad(s, c.channelId);
    return true;
  }
  // A commercial break: a random stretch of an old commercial-break recording from YouTube.
  let adWhy = ''; // why the last commercial couldn't be had (said on the break card)
  let noSeparateAudio = false; // this mpv was seen not to play picture and sound from two links
  // Widescreen HD recordings (16:9 or wider, 720p or more) go first. What a recording's picture
  // is only shows when it is opened, so that is remembered (cable().adNote) and the ones not
  // opened yet are tried a few at a time. When a channel has none (TV was 4:3 and low
  // resolution for most of these years), the best of the others plays, as it is.
  async function prepareAd(channelId, need, quick) {
    const list = await cable().adsFor(channelId);
    if (!list.length) { adWhy = cable().adWhy || 'none were found on YouTube'; return null; }
    const long = list.filter((v) => v.duration >= need + 20);
    const pool = (long.length ? long : list).slice();
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const order = adOrder(pool, (v) => cable().adInfo(v.id), quick);
    let best = null;
    for (const v of order.slice(0, quick ? 2 : 4)) {
      const room = v.duration - need - 10;
      const start = room > 10 ? 10 + Math.floor(Math.random() * room) : 0;
      try {
        const m = await ytdlp().media(v.id);
        cable().adNote(v.id, m.width, m.height);
        adWhy = '';
        const ad = { channelId, id: v.id, url: m.url, audio: m.audio || null, plain: m.plain || null, start, h: m.height || 0 };
        if (wideHd({ w: m.width, h: m.height })) return ad;
        if (!best || ad.h > best.h) best = ad;
      } catch (e) { adWhy = String(e.message || e); /* try another */ }
    }
    return best;
  }
  async function pickAd(s, need) {
    const c = s.cable;
    const ready = c.nextAd && c.nextAd.channelId === c.channelId ? c.nextAd : null;
    c.nextAd = null;
    if (ready) return ready;
    try { return await prepareAd(c.channelId, need, true); } catch (e) { adWhy = String(e.message || e); return null; } // (not looked up ahead: quickly)
  }
  function onCableAct(s, a, x) {
    if (session !== s) return;
    if (a === 'chan') return cableLoad(s, cable().neighbor(s.cable.channelId, x > 0 ? 1 : -1));
    if (a === 'exit') return end('back');
    if (a === 'sub') {
      // Captions picked from the list: kept for every channel and episode from now on.
      const t = x == null ? null : ((s.subsNow || []).find((k) => k.id === x) || null);
      settings().cableSubs = t ? { lang: String(t.lang || '').toLowerCase().slice(0, 12), label: String(t.label || '').slice(0, 80) } : 'off';
      saveSettings();
      if (s.mpv && s.mpv.alive) s.mpv.setSub(t ? t.id : null);
    }
    return null;
  }
  // Cable TV's captions: your pick from the list (a language, or off), else the Subtitles
  // setting. A track in another language is never shown just because the file marks it as default.
  function cableSubs(s, t) {
    s.subsNow = t.subs;
    const pick = settings().cableSubs;
    const sel = t.subs.find((x) => x.selected) || null;
    let want = null;
    if (s.cable.lastKind === 'show' && pick !== 'off') {
      const lang = pick && pick.lang ? pick.lang : pick ? '' : (settings().tvSubLang || 'en');
      if (lang && lang !== 'off') {
        const codes = (Object.values(SUBLANG).find((v) => v.split(',').includes(lang)) || SUBLANG[lang] || lang).split(',');
        const same = t.subs.filter((x) => codes.includes(String(x.lang).toLowerCase()));
        want = (pick && same.find((x) => x.label === pick.label)) || (sel && same.includes(sel) ? sel : same[0]) || null;
      } else if (pick && pick.label) want = t.subs.find((x) => x.label === pick.label) || null;
    }
    if (want ? !want.selected : !!sel) s.mpv.setSub(want ? want.id : null);
  }
  function wire(s) {
    const { mpv } = s;
    mpv.on('mouse', (m) => hudMouse(s, m.t, m.x, m.y));
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
        // Far too short to be the episode: it's the short notice a debrid service plays when it
        // couldn't get the video ("failed to…"). Another episode goes on instead.
        const cp = s.cable.prog;
        if (s.cable.lastKind === 'show' && dur > 0 && cp && !s.cable.learned && !s.cable.busy && dur < Math.min(300, cp.runtimeMin * 60 * 0.4)) {
          if (cableSwap(s, cp)) return;
          s.cable.learned = true;
        }
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
      if (s.cable) { s.audioTracks = t.audio.length; cableSubs(s, t); return; }
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
    // Cable TV: a file that couldn't be opened (a dead link). The player stays open; another
    // episode goes on, or another commercial (then the plain break card).
    mpv.on('failed', () => {
      if (session !== s || !s.cable) return;
      const c = s.cable, prog = c.prog;
      if (!prog) return;
      c.waitPlay = null;
      if (c.lastKind === 'show') {
        if (cableSwap(s, prog)) return;
        s.controls.tuning(c.info);
        const n = c.info && c.info.next && c.info.next[0];
        s.controls.status('This episode couldn’t be played' + (n ? '. Next: ' + n.show + ' at ' + clock(n.start) : ''));
      } else if (c.lastKind === 'ad') {
        const key = prog.start + ':' + c.segI;
        if (c.adFailKey !== key) { c.adFailKey = key; c.adFails = 0; }
        if (c.adFails++ < 2) { c.nextAd = null; c.segI = -1; return; }
        const loc = where(c);
        c.lastKind = 'filler';
        s.controls.part('filler', loc && !loc.part.end ? Date.now() + loc.left * 1000 : 0, 'the commercial couldn’t be played');
      }
    });
    // The player closed. You closing it (or Cable TV being left) ends the session. A player
    // that crashed while Cable TV was on is started again where the schedule is now (twice in
    // five minutes at most), instead of dropping you back to the guide.
    mpv.on('exit', (info) => {
      if (session !== s) return;
      const c = s.cable, t = Date.now();
      if (c && s.mpv === mpv && info && info.code !== 0 && c.prog) {
        c.crashes = (c.crashes || []).filter((x) => t - x < 5 * 60e3);
        if (c.crashes.length < 2) {
          c.crashes.push(t);
          s.mpv = null; c.waitPlay = null; c.nextAd = null; c.segI = -1;
          s.controls.tuning(c.info);
          return;
        }
      }
      end('closed');
    });
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
      // (Couch TV, inside its window: the window is where it was; it isn't pushed in front of
      // whatever else you are doing when an episode ends.)
      if (!s.embed) bringBack(false);
      else if (typeof s.embed.release === 'function') { try { s.embed.release(); } catch (_) { /* closing */ } }
      send('tv:ended', { id: s.meta ? s.meta.id : null, videoId: s.videoId, reason, error: error || null, cable: s.cable ? s.cable.channelId : null });
    }
  }

  return {
    get playing() { return !!session; },
    input(mask, lx, ly) { if (session && session.controls) session.controls.input(mask, lx, ly); },
    // Couch TV: a key pressed while something plays in its window; and its window moved or
    // changed size (the controls go with it).
    key(name, repeat, heldMs) { if (session && session.controls && typeof session.controls.key === 'function') session.controls.key(String(name || ''), !!repeat, Number(heldMs) || 0); },
    follow() { const s = session; if (s && s.embed && hud && !hud.isDestroyed() && hud.inWindow) { try { hud.setBounds(s.embed.bounds()); } catch (_) { /* closing */ } } },
    get inWindow() { return !!(session && session.embed); },
    // (The controls window's handle, so the picture can be kept just under it; whether what plays is paused.)
    hudHwnd() { if (!hud || hud.isDestroyed() || !hud.inWindow || !hud.isVisible()) return 0; const b = hud.getNativeWindowHandle(); return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0); },
    get paused() { const c = session && session.controls; return !!(c && c.state && c.state.paused); },
    // For the player report: what reached the controls from the mouse, and where the controls are.
    hudActs: () => hudActs.slice(),
    mouseSeen: () => mouseSeen.join(''),
    async hudInfo() {
      if (!hud || hud.isDestroyed()) return null;
      const b = hud.getBounds();
      let page = null;
      try { page = await hud.webContents.executeJavaScript("(() => { const e = document.getElementById('m-toggle'), r = e ? e.getBoundingClientRect() : null; return { w: innerWidth, h: innerHeight, mouse: document.body.classList.contains('mouse'), idle: document.body.classList.contains('idle'), toggle: r ? [r.left + r.width / 2, r.top + r.height / 2, r.width] : null, cable: !document.getElementById('cable').hidden }; })()", true); } catch (e) { page = { error: String(e.message || e).slice(0, 120) }; }
      return { bounds: b, visible: hud.isVisible(), inWindow: !!hud.inWindow, focusable: hud.isFocusable(), page };
    },
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
      showHud(s);
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

// Which commercial recordings to open, in order (pool: already shuffled; info(v): what is known
// of one's picture, { w, h }, or nothing when it hasn't been opened yet).
// Enough good ones known: one of those. Otherwise a few not opened yet first; except in a
// hurry (the break is starting now and nothing was got ready: only two are opened), when a
// good one already known goes first, so a boxy one never plays in place of it.
const wideHd = (i) => !!i && i.h >= 720 && i.w / i.h >= 1.6;
function adOrder(pool, info, quick) {
  const good = pool.filter((v) => wideHd(info(v))), fresh = pool.filter((v) => !info(v));
  const rest = pool.filter((v) => info(v) && !wideHd(info(v))).sort((a, b) => info(b).h - info(a).h);
  return Array.from(new Set((good.length >= 4 ? good.slice(0, 2) : quick ? good.slice(0, 1) : []).concat(fresh.slice(0, 3), good, rest, fresh.slice(3))));
}

module.exports = { setupTv, SUBLANG, adOrder, wideHd };
