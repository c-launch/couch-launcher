'use strict';
// Movies & TV: talks to Stremio the way the Stremio app does.
//  - Your Stremio account (sign in with a code on your phone, or email + password): your
//    addons, library and Continue Watching stay in sync with the Stremio app.
//  - Without an account: Cinemeta (catalogs + info) and OpenSubtitles, plus addons you add.
//  - Addons speak the public Stremio addon protocol: <base>/<resource>/<type>/<id>[/<extra>].json
// Everything is fetched here in the app core; the screens only get plain data back.

const fs = require('fs');
const { readJson, writeJson } = require('./safefile');
const path = require('path');

const API = 'https://api.strem.io/api/';
const LINK = ['https://link.stremio.com/api/v2/', 'https://link.stremio.com/api/'];
const DEFAULT_ADDONS = [
  'https://v3-cinemeta.strem.io/manifest.json',
  'https://opensubtitles-v3.strem.io/manifest.json'
];
const TTL = { catalog: 30 * 60e3, meta: 6 * 3600e3, stream: 2 * 60e3, subtitles: 10 * 60e3, addons: 5 * 60e3, library: 60e3 };

const httpUrl = (u) => typeof u === 'string' && /^https?:\/\/[^\s"<>]+$/i.test(u.trim());
const baseOf = (transportUrl) => String(transportUrl).replace(/\/manifest\.json(\?.*)?$/i, '');
// stremio://host/manifest.json links (from addon sites) are the same as https://host/manifest.json
function normalizeAddonUrl(u) {
  u = String(u || '').trim();
  if (/^stremio:\/\//i.test(u)) u = 'https://' + u.slice('stremio://'.length);
  if (!/^https?:\/\//i.test(u)) return null;
  if (!/manifest\.json(\?|$)/i.test(u)) u = u.replace(/\/+$/, '') + '/manifest.json';
  return httpUrl(u) ? u : null;
}

// Does an addon offer <resource> for this type and id?
function supports(addon, resource, type, id) {
  const m = addon && addon.manifest;
  if (!m || !Array.isArray(m.resources)) return false;
  const r = m.resources.find((x) => (typeof x === 'string' ? x : x && x.name) === resource);
  if (!r) return false;
  const types = (typeof r === 'object' && r.types) || m.types || [];
  if (type && types.length && !types.includes(type)) return false;
  const prefixes = (typeof r === 'object' && r.idPrefixes) || m.idPrefixes;
  if (id && Array.isArray(prefixes) && prefixes.length && !prefixes.some((p) => String(id).startsWith(p))) return false;
  return true;
}
function resourceUrl(addon, resource, type, id, extra) {
  const ex = extra && Object.keys(extra).length
    ? '/' + Object.entries(extra).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&')
    : '';
  return baseOf(addon.transportUrl) + '/' + resource + '/' + encodeURIComponent(type) + '/' + encodeURIComponent(id) + ex + '.json';
}

// ---------------------------------------------------------------- streams
function quality(text) {
  if (/\b(2160p|4k|uhd)\b/i.test(text)) return '4K';
  if (/\b1080p\b/i.test(text)) return '1080p';
  if (/\b720p\b/i.test(text)) return '720p';
  if (/\b(480p|576p|sd|dvdrip)\b/i.test(text)) return '480p';
  return '';
}
const QORDER = ['4K', '1080p', '720p', '480p', ''];
function describeStream(s, addonName) {
  const name = String(s.name || '').trim(), title = String(s.title || s.description || '').trim();
  const text = name + '\n' + title;
  const lines = title.split('\n').map((l) => l.trim()).filter(Boolean);
  const size = (/💾\s*([\d.,]+\s*[KMGT]i?B)/i.exec(text) || /\b([\d.]+\s?[MG]B)\b/i.exec(text) || [])[1] || '';
  const seeds = (/👤\s*(\d+)/.exec(text) || /\bseeds?:?\s*(\d+)/i.exec(text) || [])[1];
  const hdr = /\b(DV|DoVi|dolby[ .-]?vision)\b/i.test(text) ? 'Dolby Vision' : /\bHDR10\+/i.test(text) ? 'HDR10+' : /\bHDR(10)?\b/i.test(text) ? 'HDR' : '';
  const cached = /\[(RD|AD|PM|DL|TB|ED|OC|DLS|EN)\+\]|⚡|\binstant\b/i.test(text);
  const audio = (/\b(Atmos|TrueHD|DTS-HD|DTS|DD\+|DDP|EAC3|AC3|AAC)\b(\s*[57]\.1)?/i.exec(text) || [])[0] || '';
  const kind = s.url && httpUrl(s.url) ? 'url' : s.infoHash ? 'torrent' : s.ytId ? 'youtube' : s.externalUrl ? 'external' : null;
  return {
    addon: addonName,
    label: (lines[0] || name || 'Stream').slice(0, 160),
    detail: lines.slice(1).join(' · ').replace(/\s+/g, ' ').slice(0, 200),
    name: name.replace(/\s+/g, ' ').slice(0, 80),
    quality: quality(text), size, seeds: seeds ? Number(seeds) : null, hdr, audio, cached,
    kind,
    url: kind === 'url' ? s.url : null,
    infoHash: s.infoHash ? String(s.infoHash).toLowerCase() : null,
    fileIdx: Number.isInteger(s.fileIdx) ? s.fileIdx : null,
    sources: Array.isArray(s.sources) ? s.sources.filter((x) => typeof x === 'string').slice(0, 40) : [],
    bingeGroup: s.behaviorHints && typeof s.behaviorHints.bingeGroup === 'string' ? s.behaviorHints.bingeGroup : null,
    headers: s.behaviorHints && s.behaviorHints.proxyHeaders && s.behaviorHints.proxyHeaders.request || null,
    playable: kind === 'url' || kind === 'torrent'
  };
}
// The stream to play when you don't pick one: same release as last episode (bingeGroup), then
// instant (debrid) links, then your quality (or the closest below it, then above), addon order.
function bestStream(list, pref, bingeGroup) {
  const ok = (list || []).filter((s) => s.playable);
  if (!ok.length) return null;
  if (bingeGroup) { const same = ok.find((s) => s.bingeGroup === bingeGroup); if (same) return same; }
  const want = QORDER.indexOf(pref || '1080p');
  const dist = (q) => { const i = QORDER.indexOf(q || ''); if (i === QORDER.length - 1) return 50; return i >= want ? (i - want) : (want - i) + 10; };
  let best = null, score = Infinity;
  ok.forEach((s, i) => {
    const sc = dist(s.quality) * 1000 + (s.cached ? 0 : 500) + i;
    if (sc < score) { score = sc; best = s; }
  });
  return best;
}

// ---------------------------------------------------------------- library (Stremio's format)
const iso = (ms) => new Date(ms).toISOString();
function inContinueWatching(it) {
  return it && it.type !== 'other' && (!it.removed || it.temp) && it.state && Number(it.state.timeOffset) > 0;
}
function inLibrary(it) { return it && !it.removed && !it.temp; }
function newItem(meta, now) {
  return {
    _id: meta.id, name: meta.name || '', type: meta.type || 'movie', poster: meta.poster || null, posterShape: 'poster',
    removed: true, temp: true, _ctime: iso(now), _mtime: iso(now),
    state: { lastWatched: iso(now), timeWatched: 0, timeOffset: 0, overallTimeWatched: 0, timesWatched: 0, flaggedWatched: 0, duration: 0, video_id: null, watched: null, noNotif: false },
    behaviorHints: { defaultVideoId: null, featuredVideoId: null, hasScheduledVideos: false }
  };
}

// ---------------------------------------------------------------- the store
function createStremio(userDataDir, safeStorage, opts) {
  opts = opts || {};
  const doFetch = opts.fetch || ((...a) => fetch(...a));
  const now = opts.now || Date.now;
  const file = path.join(userDataDir, 'tv.json');
  let data = { auth: null, user: null, addons: null, addonsAt: 0, library: {}, libraryAt: 0, watched: {}, dirty: {}, last: {} };
  // (Read with its backup, saved in one step: addons, your list and what you've watched must
  // not be lost to a crash in the middle of a save.)
  { const saved = readJson(file); if (saved && typeof saved === 'object' && !Array.isArray(saved)) data = Object.assign(data, saved); }
  const cache = new Map();
  let saveTimer = null;
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
    if (saveTimer.unref) saveTimer.unref();
  }
  function saveNow() {
    clearTimeout(saveTimer);
    try { writeJson(file, data); } catch (_) { /* tried again with the next change */ }
  }

  // The account key is kept encrypted with Windows' own protection (like the other accounts).
  function authKey() {
    if (!data.auth) return null;
    try {
      if (data.auth.enc && safeStorage && safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(Buffer.from(data.auth.enc, 'base64'));
      return data.auth.plain || null;
    } catch (_) { return null; }
  }
  function setAuthKey(k) {
    if (!k) { data.auth = null; return; }
    if (safeStorage && safeStorage.isEncryptionAvailable()) data.auth = { enc: safeStorage.encryptString(k).toString('base64') };
    else data.auth = { plain: k };
  }

  async function getJson(url, ms) {
    const res = await doFetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'CouchLauncher' }, signal: AbortSignal.timeout(ms || 15000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }
  async function api(method, body) {
    const res = await doFetch(API + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000)
    });
    let j = null;
    try { j = await res.json(); } catch (_) { j = null; }
    if (j && j.error) throw new Error(j.error.message || 'Stremio said no');
    if (!res.ok || !j) throw new Error('Couldn’t reach Stremio (HTTP ' + res.status + ')');
    return j.result;
  }
  async function cached(key, ttl, fn) {
    const c = cache.get(key);
    if (c && now() - c.at < ttl) return c.value;
    if (c && c.pending) return c.pending;
    const pending = fn().then((value) => { cache.set(key, { at: now(), value }); return value; }, (e) => { cache.delete(key); throw e; });
    cache.set(key, { at: -Infinity, pending, value: c && c.value });
    return pending;
  }

  // ---------- account
  function status() {
    return { signedIn: !!authKey(), email: data.user && data.user.email || null, addons: (data.addons || []).length };
  }
  async function signedIn(key) {
    setAuthKey(key);
    try { const u = await api('getUser', { type: 'GetUser', authKey: key }); data.user = { email: u && u.email || null }; } catch (_) { data.user = data.user || null; }
    data.addonsAt = 0; data.libraryAt = 0; cache.clear();
    await pushDirty().catch(() => {});
    await addons(true).catch(() => {});
    saveNow();
    return status();
  }
  async function login(email, password) {
    email = String(email || '').trim(); password = String(password || '');
    if (!email || !password) throw new Error('Enter your Stremio email and password');
    const r = await api('login', { type: 'Login', email, password, facebook: false });
    if (!r || !r.authKey) throw new Error('Stremio didn’t sign you in');
    data.user = { email: (r.user && r.user.email) || email };
    return signedIn(r.authKey);
  }
  // Sign in on your phone: a short code + link (link.stremio.com), then this waits for it.
  async function linkCreate() {
    let last = null;
    for (const base of LINK) {
      try {
        const j = await getJson(base + 'create?type=Create', 12000);
        const r = j && (j.result || j);
        if (r && r.code) return { code: String(r.code), link: httpUrl(r.link) ? r.link : 'https://link.stremio.com', qrcode: typeof r.qrcode === 'string' && /^data:image\/(png|svg\+xml|jpeg);base64,/.test(r.qrcode) ? r.qrcode : null };
      } catch (e) { last = e; }
    }
    throw new Error('Couldn’t get a sign-in code from Stremio' + (last ? ' (' + last.message + ')' : ''));
  }
  async function linkPoll(code) {
    code = String(code || '').replace(/[^A-Za-z0-9]/g, '');
    if (!code) throw new Error('No code');
    for (const base of LINK) {
      try {
        const j = await getJson(base + 'read?type=Read&code=' + encodeURIComponent(code), 12000);
        const r = j && (j.result || j);
        if (r && r.authKey) { await signedIn(r.authKey); return { done: true }; }
        if (j && j.error) return { done: false };
      } catch (_) { /* try the other address */ }
    }
    return { done: false };
  }
  async function logout() {
    const k = authKey();
    if (k) api('logout', { type: 'Logout', authKey: k }).catch(() => {});
    setAuthKey(null); data.user = null; data.addons = null; data.addonsAt = 0; data.library = {}; data.libraryAt = 0; data.dirty = {};
    cache.clear(); saveNow();
    return status();
  }

  // ---------- addons
  async function fetchManifest(url) {
    const m = await getJson(url, 15000);
    if (!m || typeof m.id !== 'string' || !Array.isArray(m.resources)) throw new Error('That link isn’t a Stremio addon');
    return m;
  }
  async function defaultAddons() {
    const out = [];
    for (const u of DEFAULT_ADDONS) {
      try { out.push({ transportUrl: u, manifest: await fetchManifest(u), flags: { official: true, protected: u.includes('cinemeta') } }); } catch (_) { /* offline */ }
    }
    return out;
  }
  async function addons(force) {
    const key = authKey();
    if (!force && data.addons && now() - data.addonsAt < TTL.addons) return data.addons;
    try {
      if (key) {
        const r = await api('addonCollectionGet', { type: 'AddonCollectionGet', authKey: key, update: true });
        data.addons = (r && Array.isArray(r.addons) ? r.addons : []).filter((a) => a && a.manifest && httpUrl(a.transportUrl));
      } else if (!data.addons || !data.addons.length) {
        data.addons = await defaultAddons();
      }
      data.addonsAt = now();
      saveSoon();
    } catch (e) {
      if (!data.addons) throw e;
    }
    return data.addons;
  }
  async function pushAddons() {
    const key = authKey();
    if (key) await api('addonCollectionSet', { type: 'AddonCollectionSet', authKey: key, addons: data.addons });
    data.addonsAt = now();
    cache.clear(); saveNow();
  }
  function addonView(a, i) {
    const m = a.manifest || {};
    const res = (m.resources || []).map((r) => (typeof r === 'string' ? r : r && r.name)).filter(Boolean);
    return {
      url: a.transportUrl, index: i, id: m.id, name: m.name || m.id, version: m.version || '', description: String(m.description || '').slice(0, 300),
      logo: httpUrl(m.logo) ? m.logo : null, types: m.types || [], resources: res,
      configurable: !!(m.behaviorHints && (m.behaviorHints.configurable || m.behaviorHints.configurationRequired)),
      protected: !!(a.flags && a.flags.protected), official: !!(a.flags && a.flags.official)
    };
  }
  async function addonList() { return (await addons()).map(addonView); }
  async function addonInstall(url) {
    const u = normalizeAddonUrl(url);
    if (!u) throw new Error('That isn’t an addon link');
    const m = await fetchManifest(u);
    const list = (await addons()).slice();
    const i = list.findIndex((a) => a.transportUrl === u || (a.manifest && a.manifest.id === m.id));
    const entry = { transportUrl: u, manifest: m, flags: { official: false, protected: false } };
    if (i >= 0) list[i] = entry; else list.push(entry);
    data.addons = list;
    await pushAddons();
    return addonView(entry, i >= 0 ? i : list.length - 1);
  }
  async function addonRemove(url) {
    const list = (await addons()).slice();
    const a = list.find((x) => x.transportUrl === url);
    if (!a) return true;
    if (a.flags && a.flags.protected) throw new Error((a.manifest && a.manifest.name || 'This addon') + ' is built in and can’t be removed');
    data.addons = list.filter((x) => x !== a);
    await pushAddons();
    return true;
  }
  async function addonMove(url, dir) {
    const list = (await addons()).slice();
    const i = list.findIndex((x) => x.transportUrl === url);
    const j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= list.length) return false;
    [list[i], list[j]] = [list[j], list[i]];
    data.addons = list;
    await pushAddons();
    return true;
  }
  function addonByUrl(url) { return (data.addons || []).find((a) => a.transportUrl === url) || null; }

  // ---------- catalogs, info, streams
  async function catalogs() {
    const out = [];
    for (const a of await addons()) {
      const m = a.manifest || {};
      if (!supports(a, 'catalog')) continue;
      for (const c of m.catalogs || []) {
        if (!c || !c.type || !c.id) continue;
        const extras = Array.isArray(c.extra) ? c.extra : [];
        const required = extras.filter((e) => e && e.isRequired).map((e) => e.name).concat(c.extraRequired || []);
        const supported = extras.map((e) => e && e.name).filter(Boolean).concat(c.extraSupported || []);
        const genres = (extras.find((e) => e && e.name === 'genre') || {}).options || c.genres || [];
        out.push({
          addon: a.transportUrl, addonName: m.name || m.id, type: c.type, id: c.id, name: c.name || c.id,
          board: !required.length, search: supported.includes('search'), skip: supported.includes('skip'),
          genres: Array.isArray(genres) ? genres.slice(0, 60) : [], genreRequired: required.includes('genre')
        });
      }
    }
    return out;
  }
  function previewOf(m) {
    if (!m || !m.id) return null;
    return {
      id: String(m.id), type: m.type, name: String(m.name || ''), poster: httpUrl(m.poster) ? m.poster : null,
      background: httpUrl(m.background) ? m.background : null, logo: httpUrl(m.logo) ? m.logo : null,
      description: String(m.description || '').slice(0, 600), releaseInfo: m.releaseInfo ? String(m.releaseInfo) : (m.year ? String(m.year) : ''),
      imdbRating: m.imdbRating ? String(m.imdbRating) : '', genres: Array.isArray(m.genres) ? m.genres.slice(0, 4) : (Array.isArray(m.genre) ? m.genre.slice(0, 4) : []),
      runtime: m.runtime ? String(m.runtime) : ''
    };
  }
  async function catalog(addonUrl, type, id, extra) {
    const a = addonByUrl(addonUrl) || (await addons(), addonByUrl(addonUrl));
    if (!a) throw new Error('That addon isn’t installed');
    const clean = {};
    for (const k of ['genre', 'search', 'skip']) if (extra && extra[k] != null && extra[k] !== '') clean[k] = String(extra[k]).slice(0, 120);
    const url = resourceUrl(a, 'catalog', type, id, clean);
    return cached(url, TTL.catalog, async () => {
      const j = await getJson(url);
      return (j && Array.isArray(j.metas) ? j.metas : []).map(previewOf).filter(Boolean).map((p) => Object.assign(p, { type: p.type || type }));
    });
  }
  // Search every catalog that can search, movies and series both.
  async function search(q) {
    q = String(q || '').trim();
    if (!q) return [];
    const cats = (await catalogs()).filter((c) => c.search);
    const results = await Promise.allSettled(cats.map((c) => catalog(c.addon, c.type, c.id, { search: q }).then((items) => ({ c, items }))));
    const rows = [];
    for (const r of results) if (r.status === 'fulfilled' && r.value.items.length) rows.push({ title: (r.value.c.type === 'series' ? 'Series' : r.value.c.type === 'movie' ? 'Movies' : r.value.c.name) + ' · ' + r.value.c.addonName, type: r.value.c.type, items: r.value.items.slice(0, 40) });
    return rows;
  }
  async function meta(type, id) {
    const list = (await addons()).filter((a) => supports(a, 'meta', type, id));
    let last = null;
    for (const a of list) {
      const url = resourceUrl(a, 'meta', type, id);
      try {
        const m = await cached(url, TTL.meta, async () => { const j = await getJson(url); if (!j || !j.meta) throw new Error('No info'); return j.meta; });
        const p = previewOf(m);
        const videos = (Array.isArray(m.videos) ? m.videos : []).filter((v) => v && v.id).map((v) => ({
          id: String(v.id), title: String(v.title || v.name || ''), season: Number(v.season) || 0, episode: Number(v.episode || v.number) || 0,
          released: v.released || null, overview: String(v.overview || v.description || '').slice(0, 400), thumbnail: httpUrl(v.thumbnail) ? v.thumbnail : null
        })).sort((x, y) => (x.season - y.season) || (x.episode - y.episode));
        const trailer = (Array.isArray(m.trailerStreams) && m.trailerStreams[0] && m.trailerStreams[0].ytId) || (Array.isArray(m.trailers) && m.trailers[0] && m.trailers[0].source) || null;
        return Object.assign(p, { type: m.type || type, videos, cast: Array.isArray(m.cast) ? m.cast.slice(0, 8) : [], director: Array.isArray(m.director) ? m.director.slice(0, 3) : [], trailer: trailer ? String(trailer) : null, defaultVideoId: m.behaviorHints && m.behaviorHints.defaultVideoId || null });
      } catch (e) { last = e; }
    }
    throw new Error('Couldn’t load the info for this' + (last ? ' (' + last.message + ')' : ''));
  }
  // Streams from every addon that has them, in your addon order.
  async function streams(type, videoId) {
    const list = (await addons()).filter((a) => supports(a, 'stream', type, videoId));
    const results = await Promise.allSettled(list.map(async (a) => {
      const url = resourceUrl(a, 'stream', type, videoId);
      const j = await cached(url, TTL.stream, () => getJson(url, 25000));
      return (j && Array.isArray(j.streams) ? j.streams : []).map((s) => describeStream(s, a.manifest.name || a.manifest.id)).filter((s) => s.kind);
    }));
    const groups = [];
    results.forEach((r, i) => {
      const name = list[i].manifest.name || list[i].manifest.id;
      if (r.status === 'fulfilled') { if (r.value.length) groups.push({ addon: name, streams: r.value.slice(0, 80) }); }
      else groups.push({ addon: name, error: 'Didn’t answer', streams: [] });
    });
    return { groups, total: groups.reduce((n, g) => n + g.streams.length, 0), addons: list.length };
  }
  async function subtitles(type, videoId) {
    const list = (await addons()).filter((a) => supports(a, 'subtitles', type, videoId));
    const results = await Promise.allSettled(list.map(async (a) => {
      const url = resourceUrl(a, 'subtitles', type, videoId);
      const j = await cached(url, TTL.subtitles, () => getJson(url, 12000));
      return (j && Array.isArray(j.subtitles) ? j.subtitles : []).filter((s) => s && httpUrl(s.url)).map((s) => ({ url: s.url, lang: String(s.lang || 'und').slice(0, 12), addon: a.manifest.name }));
    }));
    return [].concat(...results.filter((r) => r.status === 'fulfilled').map((r) => r.value)).slice(0, 60);
  }

  // ---------- library and progress
  async function library(force) {
    const key = authKey();
    if (key && (force || now() - data.libraryAt > TTL.library)) {
      try {
        const items = await api('datastoreGet', { type: 'DatastoreGet', authKey: key, collection: 'libraryItem', ids: [], all: true });
        const map = {};
        for (const it of Array.isArray(items) ? items : []) if (it && it._id) map[it._id] = it;
        // Keep changes made here that haven't reached Stremio yet.
        for (const id of Object.keys(data.dirty || {})) if (data.library[id]) map[id] = data.library[id];
        data.library = map; data.libraryAt = now();
        saveSoon();
      } catch (_) { /* offline: use what we have */ }
    }
    const all = Object.values(data.library || {});
    const view = (it) => ({
      id: it._id, type: it.type, name: it.name, poster: httpUrl(it.poster) ? it.poster : null,
      videoId: it.state && it.state.video_id || null,
      offset: it.state ? Math.round(Number(it.state.timeOffset) / 1000) || 0 : 0,
      duration: it.state ? Math.round(Number(it.state.duration) / 1000) || 0 : 0,
      lastWatched: it.state && Date.parse(it.state.lastWatched) || Date.parse(it._mtime) || 0
    });
    return {
      continueWatching: all.filter(inContinueWatching).map(view).sort((a, b) => b.lastWatched - a.lastWatched).slice(0, 30),
      items: all.filter(inLibrary).map(view).sort((a, b) => b.lastWatched - a.lastWatched)
    };
  }
  function itemFor(m) {
    const t = now();
    const it = data.library[m.id] || newItem(m, t);
    if (m.name) it.name = m.name;
    if (m.poster) it.poster = m.poster;
    if (m.type) it.type = m.type;
    it.state = Object.assign(newItem(m, t).state, it.state || {});
    data.library[m.id] = it;
    return it;
  }
  function touch(it) { it._mtime = iso(now()); data.dirty[it._id] = true; saveSoon(); schedulePush(); }
  let pushTimer = null;
  function schedulePush() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => pushDirty().catch(() => {}), 1500);
    if (pushTimer.unref) pushTimer.unref();
  }
  async function pushDirty() {
    const key = authKey();
    const ids = Object.keys(data.dirty || {});
    if (!key || !ids.length) return false;
    const changes = ids.map((id) => data.library[id]).filter(Boolean);
    await api('datastorePut', { type: 'DatastorePut', authKey: key, collection: 'libraryItem', changes });
    for (const id of ids) delete data.dirty[id];
    saveSoon();
    return true;
  }
  function setInLibrary(m, on) {
    const it = itemFor(m);
    it.removed = !on; it.temp = false;
    touch(it);
    return on;
  }
  // Called while you watch (seconds). Near the end it counts as watched and leaves Continue Watching.
  function progress(m, videoId, pos, dur) {
    if (!m || !m.id || !(dur > 0)) return;
    const it = itemFor(m);
    const st = it.state;
    const prevOffset = Number(st.timeOffset) || 0;
    const watchedMs = Math.max(0, Math.min(60e3, pos * 1000 - prevOffset));
    const finished = pos >= dur * 0.92 || (dur > 1200 && dur - pos < 180);
    st.lastWatched = iso(now());
    st.duration = Math.round(dur * 1000);
    st.video_id = videoId || m.id;
    st.timeWatched = (Number(st.timeWatched) || 0) + watchedMs;
    st.overallTimeWatched = (Number(st.overallTimeWatched) || 0) + watchedMs;
    if (finished) {
      if (prevOffset > 0 || !st.flaggedWatched) st.timesWatched = (Number(st.timesWatched) || 0) + (prevOffset > 0 ? 1 : 0);
      st.timeOffset = 0; st.flaggedWatched = 1;
      data.watched[videoId || m.id] = true;
    } else st.timeOffset = Math.round(pos * 1000);
    touch(it);
    return finished;
  }
  function setWatched(videoId, on) {
    if (!videoId) return false;
    if (on) data.watched[videoId] = true; else delete data.watched[videoId];
    saveSoon();
    return !!on;
  }
  function watched(ids) { const out = {}; for (const id of ids || []) if (data.watched[id]) out[id] = true; return out; }
  // The stream you played last for a movie / episode, so Resume picks the same one.
  function rememberStream(id, videoId, stream) {
    if (!id || !stream) return;
    data.last = data.last || {};
    data.last[id] = { videoId: videoId || id, stream, at: now() };
    const keys = Object.keys(data.last);
    if (keys.length > 300) keys.sort((a, b) => data.last[a].at - data.last[b].at).slice(0, keys.length - 300).forEach((k) => delete data.last[k]);
    saveSoon();
  }
  function lastStream(id, videoId) {
    const l = data.last && data.last[id];
    return l && l.videoId === (videoId || id) ? l.stream : null;
  }
  function resumeAt(id, videoId) {
    const it = data.library[id];
    if (!it || !it.state || !(Number(it.state.timeOffset) > 0)) return 0;
    if (videoId && it.state.video_id && it.state.video_id !== videoId) return 0;
    return Math.round(Number(it.state.timeOffset) / 1000);
  }

  return {
    status, login, linkCreate, linkPoll, logout,
    addons, addonList, addonInstall, addonRemove, addonMove, addonByUrl,
    catalogs, catalog, search, meta, streams, subtitles,
    library, setInLibrary, progress, setWatched, watched, resumeAt, pushDirty, rememberStream, lastStream,
    flush: () => { saveNow(); return pushDirty().catch(() => false); }
  };
}

module.exports = { createStremio, describeStream, bestStream, supports, resourceUrl, normalizeAddonUrl, quality, inContinueWatching };
