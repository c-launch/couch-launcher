'use strict';
/* Couch Launcher interface: views, controller navigation, dialogs. */
(function () {
  const api = window.launcher;
  // The same page also runs as the see-through guide that floats over a game.
  const OVERLAY = /[?&]overlay=1/.test(location.search);
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // ---------------------------------------------------------------- state
  const S = {
    lib: null,
    info: { emulators: {}, hotkey: false, platform: 'win32' },
    view: 'home',
    libFilter: 'all',
    libSort: 'recent',
    libSearch: '',
    setTab: 'platforms',
    baseFocus: null,        // data-key of the focused element in the main screen
    zoneMemory: {},         // last focused key per zone, so moving back returns to where you were
    input: 'pad',           // 'pad' | 'key' | 'mouse'
    glyphs: 'xbox',         // 'xbox' | 'ps' | 'nin'
    playing: null,          // { id, tracked }
    scanInfo: {},
    scanning: false,
    heroId: null,
    theme: null,
    deleted: new Set()
  };
  const layers = [];

  // ---------------------------------------------------------------- helpers
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const reduce = () => !!(S.lib && S.lib.settings.reduceMotion);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 10;

  function fileUrl(p) {
    if (!p) return '';
    const raw = String(p);
    if (/^(file|https?|data):/i.test(raw)) return raw;
    const unc = /^\\\\/.test(raw);
    const s = raw.replace(/\\/g, '/').replace(/^\/+/, '');
    const enc = s.split('/').map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join('/');
    return (unc ? 'file://' : 'file:///') + enc;
  }

  function cleanTitle(name) {
    let t = String(name).replace(/\.[^.\\/]+$/, '');
    t = t.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
    return t || String(name);
  }
  const baseName = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);
  const extOf = (p) => { const m = /\.[^.\\/]+$/.exec(String(p)); return m ? m[0].toLowerCase() : ''; };

  function hash(str) { let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0; return Math.abs(h); }
  function tileColor(g) { const t = S.theme || window.THEMES[0]; return t.tiles[hash(g.title || g.id) % t.tiles.length]; }

  function fmtPlay(sec) {
    if (!sec) return '';
    const h = sec / 3600;
    if (h >= 1) return (h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)) + (h >= 1 && h < 1.05 ? ' hr' : ' hrs') + ' played';
    return Math.max(1, Math.round(sec / 60)) + ' min played';
  }
  function fmtWhen(ms) {
    if (!ms) return '';
    const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    const d = new Date(ms); d.setHours(0, 0, 0, 0);
    const days = Math.round((d0 - d) / 86400000);
    if (days <= 0) return 'Played today';
    if (days === 1) return 'Played yesterday';
    if (days < 7) return 'Played ' + days + ' days ago';
    return 'Played ' + new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  const SOURCES = {
    steam: { name: 'Steam', badge: 'STEAM', color: '#2F4F6B', letter: 'S' },
    epic: { name: 'Epic Games', badge: 'EPIC', color: '#465060', letter: 'E' },
    msstore: { name: 'Microsoft Store & Xbox app', badge: 'XBOX PC', color: '#2F5A36', letter: 'M' },
    roblox: { name: 'Roblox', badge: 'ROBLOX', color: '#3A4048', letter: 'R' },
    dolphin: { name: 'GameCube / Wii', badge: 'GC/WII', color: '#3B3F6E', letter: 'D' },
    rpcs3: { name: 'PS3', badge: 'PS3', color: '#6A2F3D', letter: 'P' },
    ryujinx: { name: 'Switch', badge: 'SWITCH', color: '#3C5A3A', letter: 'R' },
    custom: { name: 'PC & other', badge: 'PC', color: '#4B3A2A', letter: '+' }
  };

  // ---------------------------------------------------------------- icons
  const I = {
    home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
    level: '<circle cx="12" cy="12" r="9"/><path d="M8 14l4-4 4 4"/>',
    store: '<path d="M4 8h16l-1 12H5z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
    pad: '<path d="M6 12h4M8 10v4"/><circle cx="15" cy="11" r="1"/><circle cx="17" cy="13" r="1"/><path d="M7 6h10a5 5 0 0 1 4.9 6l-1 5a2.5 2.5 0 0 1-4.4 1L15 16H9l-1.5 2a2.5 2.5 0 0 1-4.4-1l-1-5A5 5 0 0 1 7 6z"/>',
    star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
    play: '<path d="M7 4l13 8-13 8z"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
    pin: '<path d="M9 4h6l-1 6 4 4H6l4-4z"/><path d="M12 14v7"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2a5 5 0 0 1 6 4.8"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    chat: '<path d="M4 5h16v11H9l-5 4z"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    headset: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>',
    folder: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
    file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
    image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M21 16l-5-5-8 8"/>',
    power: '<path d="M12 3v9"/><path d="M6.3 7.3a8 8 0 1 0 11.4 0"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    restart: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
    exit: '<path d="M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5"/><path d="M10 16l-4-4 4-4M6 12h10"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    refresh: '<path d="M4 12a8 8 0 0 1 14-5.3L20 9"/><path d="M20 4v5h-5"/><path d="M20 12a8 8 0 0 1-14 5.3L4 15"/><path d="M4 20v-5h5"/>',
    bksp: '<path d="M9 5h11a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-6-7z"/><path d="M13 9l5 6M18 9l-5 6"/>',
    shift: '<path d="M12 4l8 8h-4v7H8v-7H4z"/>',
    resume: '<path d="M8 5v14l11-7z"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.8-.8 1.8-1.7 0-1.1-.9-1.4-.9-2.4 0-.9.7-1.4 1.6-1.4H17a4 4 0 0 0 4-4c0-4.8-4-8.5-9-8.5z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="14.5" cy="7" r="1"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
    trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M9 20h6M10 17h4"/>',
    link: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    prev: '<path d="M19 20L9 12l10-8z"/><path d="M5 19V5"/>',
    next: '<path d="M5 4l10 8-10 8z"/><path d="M19 5v14"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    minus: '<path d="M5 12h14"/>',
    volume: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>',
    shuffle: '<path d="M16 3h5v5"/><path d="M4 20L21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>'
  };
  const icon = (n) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (I[n] || '') + '</svg>';
  const starIcon = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' + I.star + '</svg>';

  // ---------------------------------------------------------------- toasts
  function toast(msg, isErr) {
    const host = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (isErr ? ' err' : '');
    el.textContent = msg;
    host.appendChild(el);
    while (host.children.length > 3) host.firstChild.remove();
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, isErr ? 5200 : 2800);
  }

  // ---------------------------------------------------------------- saving (all calls to the app core run one at a time)
  let chain = Promise.resolve();
  function enqueue(fn) { const p = chain.then(fn); chain = p.catch(() => {}); return p; }
  let saveTimer = null;
  function save() {
    if (OVERLAY) return; // only the main launcher writes the library
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      enqueue(() => api.save(S.lib)).then(() => S.deleted.clear()).catch((e) => toast('Could not save: ' + e.message, true));
    }, 250);
  }

  const USER_FIELDS = ['favorite', 'pinned', 'coop', 'args', 'playtime', 'lastPlayed', 'titleEdited', 'artEdited', 'hidden', 'artTried'];
  // Take a fresh scan result but keep anything changed here while the scan ran.
  function adoptScan(result) {
    const mine = new Map(S.lib.games.map((g) => [g.id, g]));
    const out = [];
    const seen = new Set();
    for (const rg of result.games) {
      if (S.deleted.has(rg.id)) continue;
      seen.add(rg.id);
      const m = mine.get(rg.id);
      if (!m) { out.push(rg); continue; }
      const g = Object.assign({}, rg);
      for (const k of USER_FIELDS) if (m[k] !== undefined) g[k] = m[k];
      g.playtime = Math.max(Number(rg.playtime) || 0, Number(m.playtime) || 0);
      g.lastPlayed = Math.max(Number(rg.lastPlayed) || 0, Number(m.lastPlayed) || 0);
      if (m.titleEdited || m.source === 'custom') g.title = m.title;
      g.art = Object.assign({}, rg.art || {});
      const ae = m.artEdited || {};
      for (const k of ['tile', 'hero', 'logo']) if (ae[k] || m.source === 'custom') g.art[k] = (m.art || {})[k] || null;
      if (m.source === 'custom') g.launch = m.launch;
      out.push(g);
    }
    for (const m of S.lib.games) if (!seen.has(m.id) && m.source === 'custom') out.push(m); // added during the scan
    S.lib.games = out;
  }

  async function rescan(source, silent) {
    if (S.scanning) return;
    S.scanning = true;
    if (S.view === 'settings') refreshContent();
    try {
      const r = await enqueue(async () => {
        const res = await api.scan(source || null);
        adoptScan(res.lib);
        return res;
      });
      for (const x of r.results) S.scanInfo[x.source] = x;
      save();
      if (!silent) {
        const n = r.results.reduce((a, x) => a + x.count, 0);
        toast(source ? (S.info.emulators[source] ? S.info.emulators[source].name : SOURCES[source].name) + ': ' + n + ' game' + (n === 1 ? '' : 's') + ' found' : 'Library updated · ' + S.lib.games.length + ' games');
      }
    } catch (e) {
      toast('Scan failed: ' + e.message, true);
    } finally {
      S.scanning = false;
      renderTop();
      if (S.view === 'settings') refreshContent(); else if (!layers.length) renderView(false);
    }
    autoArt(false);
  }

  // ---------------------------------------------------------------- game lists
  const allGames = () => S.lib.games;
  const games = () => S.lib.games.filter((g) => !g.hidden);
  const byId = (id) => S.lib.games.find((g) => g.id === id);
  function homeList() {
    const gs = games().slice();
    const pinned = gs.filter((g) => g.pinned).sort((a, b) => (b.lastPlayed - a.lastPlayed) || a.title.localeCompare(b.title));
    const rest = gs.filter((g) => !g.pinned).sort((a, b) => (b.lastPlayed - a.lastPlayed) || (b.addedAt - a.addedAt));
    // The most recently played game always comes first, pinned games next.
    const all = pinned.concat(rest);
    const recent = gs.filter((g) => g.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed)[0];
    if (recent) { all.splice(all.indexOf(recent), 1); all.unshift(recent); }
    return all.slice(0, 12);
  }
  function libList() {
    const f = S.libFilter;
    let gs = f === 'hidden' ? allGames().filter((g) => g.hidden) : games().slice();
    if (f === 'fav') gs = gs.filter((g) => g.favorite);
    else if (f === 'coop') gs = gs.filter((g) => g.coop);
    else if (f !== 'all' && f !== 'hidden') gs = gs.filter((g) => g.source === f);
    if (S.libSearch) { const q = S.libSearch.toLowerCase(); gs = gs.filter((g) => g.title.toLowerCase().includes(q)); }
    if (S.libSort === 'az') gs.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }));
    else if (S.libSort === 'most') gs.sort((a, b) => (b.playtime - a.playtime) || a.title.localeCompare(b.title));
    else gs.sort((a, b) => (b.lastPlayed - a.lastPlayed) || (b.addedAt - a.addedAt) || a.title.localeCompare(b.title));
    return gs;
  }

  // ---------------------------------------------------------------- tiles
  function tileHTML(g, o) {
    o = o || {};
    const src = SOURCES[g.source] || SOURCES.custom;
    return '<button class="tile' + (o.big ? ' big' : '') + '" data-nav data-key="' + esc(o.key) + '" data-zone="' + esc(o.zone) + '"' +
      (o.lock ? ' data-lock="' + esc(o.lock) + '"' : '') + ' data-game="' + esc(g.id) + '" data-action="play" style="--tile-bg:' + tileColor(g) + '" aria-label="' + esc(g.title) + '">' +
      '<div class="ph">' + esc(g.title) + '</div>' +
      (g.art && g.art.tile ? '<img src="' + esc(fileUrl(g.art.tile)) + '" alt="" decoding="async">' : '') +
      (o.badge ? '<span class="badge">' + src.badge + '</span>' : '') +
      (g.favorite && o.badge ? '<span class="star">' + starIcon + '</span>' : '') +
      '<div class="label">' + esc(g.title) + '</div></button>';
  }
  // Fade images in when they load; drop broken ones so the placeholder shows.
  document.addEventListener('load', (e) => { if (e.target && e.target.tagName === 'IMG') e.target.classList.add('loaded'); }, true);
  document.addEventListener('error', (e) => { if (e.target && e.target.tagName === 'IMG') e.target.remove(); }, true);

  // ---------------------------------------------------------------- top bar & prompts
  function padCount() {
    try { return Array.from(navigator.getGamepads()).filter((p) => p && p.connected).length; } catch (_) { return 0; }
  }
  function renderTop() {
    const s = S.lib.settings;
    const n = games().length;
    const navs = [['home', 'home', 'Home'], ['library', 'grid', 'My library'], ['search', 'search', 'Search'], ['friends', 'users', 'Friends'], ['settings', 'gear', 'Settings']];
    const x = s.xbox;
    const sub = profileFrom() === 'steam' ? icon('level') + '<span>' + esc(profileSub()) + '</span>'
      : x ? icon('trophy') + '<span>' + Number(x.gamerscore || 0).toLocaleString() + '</span>'
      : esc(S.scanning ? 'Looking for games…' : n + ' game' + (n === 1 ? '' : 's'));
    $('#topbar').innerHTML =
      '<button class="me" data-nav data-key="nav-me" data-zone="nav" data-lock="nav" data-action="profile" aria-label="Your profile">' + avatarHTML('avatar') +
      '<div><div class="me-name">' + esc(displayName()) + '</div><div class="me-sub">' + sub + '</div></div></button>' +
      '<nav class="navpill" aria-label="Main">' + navs.map(([k, ic, label]) =>
        '<button class="navbtn' + (S.view === k ? ' active' : '') + '" data-nav data-key="nav-' + k + '" data-zone="nav" data-lock="nav" data-action="nav" data-to="' + k + '" aria-label="' + label + '">' + icon(ic) + '</button>').join('') + '</nav>' +
      '<div class="clock"><span class="pads" id="padcount"></span><span id="clock"></span></div>';
    tickClock();
    restoreFocusClass();
  }
  // Whose name and picture to show: Xbox, Steam or your own (falls back to your own when
  // that account isn't connected).
  function profileFrom() {
    const s = S.lib.settings;
    const want = s.profileFrom || (s.useXboxProfile ? 'xbox' : 'own');
    if (want === 'xbox' && s.xbox) return 'xbox';
    if (want === 'steam' && s.steamProfile) return 'steam';
    return 'own';
  }
  const useXbox = () => profileFrom() === 'xbox';
  function displayName() {
    const s = S.lib.settings, f = profileFrom();
    return f === 'xbox' ? s.xbox.gamertag : f === 'steam' ? s.steamProfile.name : (s.userName || 'Player');
  }
  function profileSub() {
    const s = S.lib.settings, f = profileFrom();
    if (f === 'steam') { const p = s.steamProfile; return [p.level != null ? 'Level ' + p.level : '', p.games != null ? p.games + ' games' : ''].filter(Boolean).join(' · ') || 'Steam'; }
    return s.xbox ? Number(s.xbox.gamerscore || 0).toLocaleString() + ' gamerscore' : '';
  }
  function avatarHTML(cls) {
    const s = S.lib.settings, f = profileFrom();
    const pic = f === 'xbox' && s.xbox.pic ? s.xbox.pic : f === 'steam' && s.steamProfile.pic ? s.steamProfile.pic : s.avatar ? fileUrl(s.avatar) : null;
    const initial = esc((displayName() || 'P').trim().charAt(0).toUpperCase() || 'P');
    return '<div class="' + cls + '">' + initial + (pic ? '<img src="' + esc(pic) + '" alt="">' : '') + '</div>';
  }
  function tickClock() {
    const c = $('#clock'); if (c) c.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const p = $('#padcount'); if (p) { const n = padCount(); p.innerHTML = n ? icon('pad') + n : ''; }
  }

  const GLYPHS = {
    xbox: { A: 'A', B: 'B', X: 'X', Y: 'Y', LB: 'LB', RB: 'RB', MENU: '☰', VIEW: '⧉' },
    ps: { A: '✕', B: '○', X: '□', Y: '△', LB: 'L1', RB: 'R1', MENU: 'OPTIONS', VIEW: 'SHARE' },
    nin: { A: 'B', B: 'A', X: 'Y', Y: 'X', LB: 'L', RB: 'R', MENU: '+', VIEW: '−' },
    key: { A: 'Enter', B: 'Esc', X: 'Del', Y: 'F2', LB: 'Q', RB: 'E', MENU: 'M', VIEW: 'Tab' }
  };
  function glyph(b) {
    const set = S.input === 'pad' ? S.glyphs : 'key';
    return '<span class="glyph' + (set === 'key' ? ' kbd' : '') + '">' + esc(GLYPHS[set][b] || b) + '</span>';
  }
  function updatePrompts() {
    const el = currentFocus();
    let list;
    const top = layers[layers.length - 1];
    if (top && top.className === 'launching') list = []; // the boot screen has its own Cancel hint
    else if (top) list = top.prompts ? top.prompts(el) : [['A', 'Select'], ['B', 'Back']];
    else if (el && el.dataset.game) list = [['A', 'Play'], ['Y', 'Edit game'], ['MENU', 'Options']].concat(S.view !== 'home' ? [['B', 'Back']] : []);
    else list = [['A', 'Select']].concat(S.view !== 'home' ? [['B', 'Back']] : [['MENU', 'Power']]);
    if (!top && S.view !== 'home') list.push(['LB', 'RB']);
    $('#prompts').innerHTML = list.map(([b, label]) => b === 'LB' ? '<span class="prompt">' + glyph('LB') + glyph('RB') + 'Switch</span>' : '<span class="prompt">' + glyph(b) + esc(label) + '</span>').join('');
  }

  // ---------------------------------------------------------------- views
  function renderView(animate, back) {
    const host = $('#view');
    const app = $('#app');
    app.classList.toggle('view-home', S.view === 'home');
    app.classList.toggle('view-library', S.view === 'library');
    app.classList.toggle('view-settings', S.view === 'settings');
    const html = S.view === 'library' ? libraryHTML() : S.view === 'settings' ? settingsHTML() : homeHTML();
    const next = document.createElement('div');
    next.className = 'view';
    next.innerHTML = html;
    const old = $$('.view', host);
    if (animate && !reduce()) {
      for (const o of old) { o.classList.add('leave'); setTimeout(() => o.remove(), 170); }
      next.classList.add('enter'); if (back) next.classList.add('back');
      next.addEventListener('animationend', () => next.classList.remove('enter', 'back'), { once: true });
    } else {
      for (const o of old) o.remove();
    }
    host.appendChild(next);
    renderTop();
    if (!layers.length) {
      const target = S.baseFocus && $('[data-key="' + cssEsc(S.baseFocus) + '"]', next);
      setFocus(target || $('[data-nav]', next) || $('[data-nav]', $('#topbar')), { instant: true });
    }
    if (S.view === 'home') updateHero(true);
    updatePrompts();
  }
  function cssEsc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/"/g, '\\"'); }

  function go(view, focusKey) {
    if (view === S.view && !focusKey) return;
    const order = ['home', 'library', 'settings'];
    const back = order.indexOf(view) < order.indexOf(S.view);
    if (S.view !== view) S.zoneMemory = {};
    S.view = view;
    S.baseFocus = focusKey || null;
    renderView(true, back);
  }

  // ----- home
  function homeHTML() {
    const list = homeList();
    const n = games().length;
    const coop = games().filter((g) => g.coop).length;
    let tiles;
    if (!list.length) {
      tiles = '<button class="tile special big" data-nav data-key="h-setup" data-zone="tiles" data-lock="tiles" data-action="go-settings" data-tab="platforms">' + icon('gear') + 'Set up platforms</button>' +
        '<button class="tile special" data-nav data-key="h-add" data-zone="tiles" data-lock="tiles" data-action="add">' + icon('plus') + 'Add a game</button>';
    } else {
      tiles = list.map((g, i) => tileHTML(g, { big: i === 0, key: 'h-' + g.id, zone: 'tiles', lock: 'tiles' })).join('') +
        '<button class="tile special" data-nav data-key="h-all" data-zone="tiles" data-lock="tiles" data-action="nav" data-to="library">' + icon('grid') + 'All games</button>';
    }
    const cards = [
      ['c-lib', 'grid', 'My library', n + ' game' + (n === 1 ? '' : 's'), 'data-action="nav" data-to="library"'],
      ['c-store', 'store', 'Stores', 'Steam, Xbox, Epic', 'data-action="stores"'],
      ['c-add', 'plus', 'Add a game', 'Any program or game file', 'data-action="add"'],
      ['c-coop', 'users', 'Co-op games', coop ? coop + ' for the couch' : 'Mark games as co-op', 'data-action="coop"'],
      ['c-set', 'palette', 'Customize', 'Themes, platforms, startup', 'data-action="go-settings" data-tab="themes"']
    ];
    return '<div class="hero"><div class="eyebrow" id="hero-eyebrow"></div><h1 id="hero-title"></h1><div class="meta" id="hero-meta"></div></div>' +
      '<div class="row home-tiles"><div class="row-inner">' + tiles + '</div></div>' +
      '<div class="row home-cards"><div class="row-inner">' + cards.map(([k, ic, t, s, attrs]) =>
        '<button class="card" data-nav data-key="' + k + '" data-zone="cards" data-lock="cards" ' + attrs + '>' + icon(ic) + '<div><div class="t">' + t + '</div><div class="s">' + esc(s) + '</div></div></button>').join('') + '</div></div>';
  }

  let heroTimer = null;
  let bgFlip = false;
  function updateHero(now) {
    if (S.view !== 'home') { setBackground(null); return; }
    clearTimeout(heroTimer);
    const run = () => {
      const el = currentFocus();
      let g = el && el.dataset.game ? byId(el.dataset.game) : null;
      if (!g) g = (S.heroId && byId(S.heroId)) || homeList()[0] || null;
      const eb = $('#hero-eyebrow'), ti = $('#hero-title'), me = $('#hero-meta');
      if (!eb) return;
      const id = g ? g.id : '_none';
      const changed = S.heroId !== id || !ti.textContent;
      S.heroId = g ? g.id : null;
      if (!changed) return;
      if (!g) {
        setBackground(S.lib.settings.customBg || null);
        eb.textContent = 'Welcome';
        ti.textContent = "Let's add your games";
        me.textContent = 'Set up Steam, Epic and your emulators in Platforms, or add any game yourself.';
      } else {
        const first = homeList()[0];
        eb.textContent = first && first.id === g.id && g.lastPlayed ? 'Continue playing' : g.pinned ? 'Pinned' : g.favorite ? 'Favorite' : (SOURCES[g.source] || SOURCES.custom).name;
        ti.textContent = g.title;
        me.textContent = [fmtWhen(g.lastPlayed), fmtPlay(g.playtime)].filter(Boolean).join(' · ') || (g.coop ? 'Co-op' : 'Ready to play');
      }
      for (const n of [eb, ti, me]) { n.classList.remove('swap'); void n.offsetWidth; n.classList.add('swap'); }
      setBackground((g && S.lib.settings.useArtBackground && g.art && g.art.hero) || S.lib.settings.customBg || null);
    };
    if (now) run(); else heroTimer = setTimeout(run, 110);
  }
  let currentBg = null;
  function setBackground(path) {
    const url = path ? fileUrl(path) : null;
    if (url === currentBg) return;
    currentBg = url;
    const a = $('#bg-a'), b = $('#bg-b');
    const show = bgFlip ? a : b, hide = bgFlip ? b : a;
    bgFlip = !bgFlip;
    hide.classList.remove('show');
    if (url) {
      const img = new Image();
      img.onload = () => {
        if (currentBg !== url) return;
        show.style.backgroundImage = 'url("' + url.replace(/"/g, '%22') + '")';
        show.classList.add('show');
        $('#app').classList.add('has-art');
      };
      img.src = url;
    } else {
      show.classList.remove('show');
      $('#app').classList.remove('has-art');
    }
    $('.bg-deco').style.opacity = url ? '0' : '1';
  }

  // ----- library
  function libraryHTML() {
    const gs = games();
    const count = (fn) => gs.filter(fn).length;
    const filters = [['all', 'All games', gs.length], ['fav', 'Favorites', count((g) => g.favorite)], ['coop', 'Co-op', count((g) => g.coop)]];
    for (const k of Object.keys(SOURCES)) { const c = count((g) => g.source === k); if (c) filters.push([k, SOURCES[k].name, c]); }
    const hiddenCount = allGames().filter((g) => g.hidden).length;
    if (hiddenCount) filters.push(['hidden', 'Hidden', hiddenCount]);
    if (!filters.some((f) => f[0] === S.libFilter)) S.libFilter = 'all';
    return '<div class="shell"><aside class="side"><h1>My library</h1>' +
      filters.map(([k, label, c]) => '<button class="sideitem' + (S.libFilter === k ? ' sel' : '') + '" data-nav data-key="f-' + k + '" data-zone="side" data-action="filter" data-f="' + k + '"><span>' + esc(label) + '</span><span class="n">' + c + '</span></button>').join('') +
      '<div class="spacer"></div><button class="dashed" data-nav data-key="l-add" data-zone="side" data-action="add">' + icon('plus') + 'Add a game</button></aside>' +
      '<section class="content" id="content">' + libraryContentHTML() + '</section></div>';
  }
  function libraryContentHTML() {
    const list = libList();
    const sorts = [['recent', 'Recently played'], ['az', 'A–Z'], ['most', 'Most played']];
    let h = '<div class="toolbar"><div class="pills">' + sorts.map(([k, l]) => '<button class="pill' + (S.libSort === k ? ' sel' : '') + '" data-nav data-key="s-' + k + '" data-zone="tools" data-action="sort" data-s="' + k + '">' + l + '</button>').join('') +
      (S.libSearch ? '<button class="pill" data-nav data-key="s-clear" data-zone="tools" data-action="clear-search">' + icon('x') + 'Clear search</button>' : '') +
      '</div><button class="search' + (S.libSearch ? ' has' : '') + '" data-nav data-key="s-search" data-zone="tools" data-action="search">' + icon('search') + '<span>' + esc(S.libSearch || 'Search your games') + '</span></button></div>';
    if (!list.length) {
      h += '<div class="empty"><b>' + (S.libSearch ? 'No games match “' + esc(S.libSearch) + '”' : games().length ? 'Nothing here yet' : 'Your library is empty') + '</b>' +
        (S.libFilter === 'hidden' ? 'Hidden games show up here.' : S.libFilter === 'coop' ? 'Open a game’s options and turn on Co-op to see it here.' : S.libFilter === 'fav' ? 'Open a game’s options and add it to favorites.' : 'Set up your platforms or add a game yourself.') + '</div>';
    } else {
      h += '<div class="grid">' + list.map((g) => '<div class="gitem">' + tileHTML(g, { key: 'g-' + g.id, zone: 'grid', badge: true }) + '<div class="name">' + esc(g.title) + '</div></div>').join('') + '</div>';
    }
    return h;
  }

  // ----- settings
  const TABS = [['platforms', 'Platforms'], ['themes', 'Themes'], ['display', 'Display'], ['controllers', 'Controllers'], ['startup', 'Startup & power'], ['about', 'About']];
  function settingsHTML() {
    return '<div class="shell"><aside class="side"><h1>Settings</h1>' +
      TABS.map(([k, l]) => '<button class="sideitem' + (S.setTab === k ? ' sel' : '') + '" data-nav data-key="t-' + k + '" data-zone="side" data-action="tab" data-tab="' + k + '"><span>' + l + '</span></button>').join('') +
      '</aside><section class="content" id="content">' + settingsContentHTML() + '</section></div>';
  }
  function toggleHTML(key, label, on, desc, action, extra) {
    return '<button class="toggle-row" data-nav data-key="' + key + '" data-zone="body" data-action="' + action + '" ' + (extra || '') + ' role="switch" aria-checked="' + (on ? 'true' : 'false') + '"><span><div>' + esc(label) + '</div>' +
      (desc ? '<div class="d">' + esc(desc) + '</div>' : '') + '</span><span class="switch' + (on ? ' on' : '') + '"></span></button>';
  }
  function settingsContentHTML() {
    const s = S.lib.settings;
    const P = S.lib.platforms;
    const tab = S.setTab;
    if (tab === 'platforms') {
      const cnt = (src) => games().filter((g) => g.source === src).length;
      let h = '<div class="sect-h"><div><h2>Platforms</h2><p>Where your games come from. New games in these folders show up automatically.</p></div>' +
        '<div class="btn-row"><button class="btn big" data-nav data-key="p-emudeck" data-zone="body" data-action="emudeck">' + icon('search') + 'Find EmuDeck setup</button>' +
        '<button class="btn primary big" data-nav data-key="p-all" data-zone="body" data-action="rescan">' + icon('refresh') + (S.scanning ? 'Scanning…' : 'Rescan all') + '</button></div></div><div class="plist">';
      for (const src of ['steam', 'epic', 'msstore', 'roblox']) {
        const info = S.scanInfo[src];
        const on = (P[src] || { enabled: true }).enabled !== false;
        const status = !on ? ['off', 'Turned off'] : !info ? ['off', 'Not scanned yet'] : info.found ? ['ok', 'Connected · ' + cnt(src) + ' games'] : ['warn', 'Not found on this PC'];
        h += '<div class="prow"><div class="picon" style="background:' + SOURCES[src].color + '">' + SOURCES[src].letter + '</div><div class="pinfo"><div class="t">' + SOURCES[src].name + '</div><div class="p">Found automatically</div></div>' +
          '<span class="status ' + status[0] + '">' + status[1] + '</span>' +
          '<button class="btn" data-nav data-key="p-' + src + '-toggle" data-zone="body" data-action="plat-toggle" data-src="' + src + '">' + (on ? 'Turn off' : 'Turn on') + '</button>' +
          '<button class="btn" data-nav data-key="p-' + src + '-scan" data-zone="body" data-action="rescan" data-src="' + src + '"' + (on ? '' : ' disabled') + '>Rescan</button></div>';
      }
      for (const src of ['dolphin', 'rpcs3', 'ryujinx']) {
        const e = S.info.emulators[src] || { name: src, system: '' };
        const c = P[src];
        const needsDir = src !== 'rpcs3';
        const status = !c.exe ? ['warn', 'Not set up'] : needsDir && !c.dir ? ['warn', 'Needs games folder'] : ['ok', cnt(src) + ' game' + (cnt(src) === 1 ? '' : 's')];
        const where = c.exe ? c.exe + (c.dir ? '  →  ' + c.dir.split(';').join(' + ') : src === 'rpcs3' ? '  →  installed games' : '') : 'Choose the emulator program, then your games folder';
        h += '<div class="prow"><div class="picon" style="background:' + SOURCES[src].color + '">' + SOURCES[src].letter + '</div><div class="pinfo"><div class="t">' + esc(e.name + ' · ' + e.system) + '</div><div class="p">' + esc(where) + '</div></div>' +
          '<span class="status ' + status[0] + '">' + status[1] + '</span>' +
          '<button class="btn" data-nav data-key="p-' + src + '-exe" data-zone="body" data-action="plat-exe" data-src="' + src + '">' + (c.exe ? 'Change program' : 'Set program') + '</button>' +
          '<button class="btn" data-nav data-key="p-' + src + '-dir" data-zone="body" data-action="plat-dir" data-src="' + src + '">' + (c.dir ? 'Change folder' : 'Games folder') + '</button>' +
          '<button class="btn" data-nav data-key="p-' + src + '-scan" data-zone="body" data-action="rescan" data-src="' + src + '"' + (c.exe ? '' : ' disabled') + '>Rescan</button>' +
          (c.exe ? '<button class="btn" data-nav data-key="p-' + src + '-open" data-zone="body" data-action="emu-open" data-src="' + src + '">Open</button>' : '') + '</div>';
      }
      h += '<div class="prow"><div class="picon" style="background:var(--chip);color:var(--text)">' + icon('image') + '</div><div class="pinfo"><div class="t">Game art · SteamGridDB</div><div class="p">Finds tiles and backgrounds by game name</div></div>' +
        (S.artOn ? '<span class="status ok">Connected</span><button class="btn" data-nav data-key="p-art-find" data-zone="body" data-action="art-find">' + icon('search') + (S.artRunning ? 'Finding…' : 'Find missing art') + '</button>' +
          '<button class="btn" data-nav data-key="p-art-off" data-zone="body" data-action="art-off">Disconnect</button>'
          : '<span class="status off">Not connected</span><button class="btn" data-nav data-key="p-art-on" data-zone="body" data-action="art-on">' + icon('link') + 'Connect</button>') + '</div>';
      h += '<div class="prow"><div class="picon" style="background:' + SOURCES.custom.color + '">+</div><div class="pinfo"><div class="t">Custom</div><div class="p">Games and programs you add one at a time</div></div>' +
        '<span class="status ok">' + cnt('custom') + ' games</span><button class="btn" data-nav data-key="p-custom-add" data-zone="body" data-action="add">' + icon('plus') + 'Add a game</button></div>';
      h += '</div>';
      if (S.info.platform === 'win32') {
        h += '<p class="field-note" style="margin-top:2rem">PS3 games can be disc folders (with PS3_GAME inside) or games installed in RPCS3. You need your own firmware, keys and game dumps for each emulator.</p>';
      }
      return h;
    }
    if (tab === 'themes') {
      let h = '<div class="sect-h"><div><h2>Themes</h2><p>Changes apply right away, everywhere.</p></div></div><div class="theme-grid">';
      for (const t of window.THEMES) {
        const sel = s.theme === t.id;
        h += '<button class="tcard' + (sel ? ' sel' : '') + '" data-nav data-key="th-' + t.id + '" data-zone="body" data-action="theme" data-id="' + t.id + '">' +
          '<div class="sw" style="background:' + t.bg + '">' + [t.accent, t.tiles[0], t.tiles[1], t.tiles[2]].map((c) => '<span style="background:' + c + '"></span>').join('') + '</div>' +
          '<div class="n">' + esc(t.name) + (sel ? '<span class="check">' + icon('check') + '</span>' : '') + '</div><div class="d">' + esc(t.desc) + '</div></button>';
      }
      h += '</div><div class="sub-h">Corner style</div><div class="pills">' + window.CORNERS.map((c) =>
        '<button class="pill' + (s.corners === c.id ? ' sel' : '') + '" data-nav data-key="co-' + c.id + '" data-zone="body" data-action="corners" data-id="' + c.id + '">' + c.name + '</button>').join('') + '</div>';
      h += '<div class="sub-h">Accent color</div><div class="swatches">' +
        '<button class="swatch' + (!s.accent ? ' sel' : '') + '" style="background:var(--chip);color:var(--text)" data-nav data-key="ac-auto" data-zone="body" data-action="accent" data-c="" aria-label="Theme default">AUTO</button>' +
        window.ACCENTS.map((c) => '<button class="swatch' + (s.accent === c ? ' sel' : '') + '" style="background:' + c + '" data-nav data-key="ac-' + c.slice(1) + '" data-zone="body" data-action="accent" data-c="' + c + '" aria-label="Accent ' + c + '"></button>').join('') +
        (s.accent && !window.ACCENTS.includes(s.accent) ? '<button class="swatch sel" style="background:' + s.accent + '" data-nav data-key="ac-mine" data-zone="body" data-action="accent" data-c="' + s.accent + '" aria-label="Your color"></button>' : '') +
        '<button class="pill" data-nav data-key="ac-custom" data-zone="body" data-action="accent-custom">' + icon('edit') + 'Custom color</button></div>';
      h += '<div class="sub-h">Display</div><div class="toggles">' +
        toggleHTML('d-art', 'Use game art as the background', s.useArtBackground, 'On Home, when a game has background art', 'set-toggle', 'data-k="useArtBackground"') +
        toggleHTML('d-motion', 'Reduce motion', s.reduceMotion, 'Snappier, with fewer animations', 'set-toggle', 'data-k="reduceMotion"') + '</div>' +
        '<div class="sub-h">Home background</div><div class="prow"><div class="bgthumb"' + (s.customBg ? ' style="background-image:url(&quot;' + esc(fileUrl(s.customBg)) + '&quot;)"' : '') + '>' + (s.customBg ? '' : icon('image')) + '</div>' +
        '<div class="pinfo"><div class="t">' + (s.customBg ? 'Your background' : 'Theme background') + '</div><div class="p">Shows on Home when the selected game has no background art' + (s.useArtBackground ? '' : ' (game art is off, so always)') + '</div></div>' +
        '<button class="btn" data-nav data-key="bg-pick" data-zone="body" data-action="bg-pick">' + icon('image') + (s.customBg ? 'Change' : 'Choose image') + '</button>' +
        (s.customBg ? '<button class="btn" data-nav data-key="bg-clear" data-zone="body" data-action="bg-clear">Remove</button>' : '') + '</div>';
      return h;
    }
    if (tab === 'display') {
      if (!S.displays) {
        api.listDisplays().then((d) => { S.displays = d; if (S.view === 'settings' && S.setTab === 'display') refreshContent(); }).catch((e) => toast(e.message, true));
        return '<div class="sect-h"><div><h2>Display</h2><p>Looking for monitors…</p></div></div>';
      }
      return '<div class="sect-h"><div><h2>Display</h2><p>Choose which monitor the launcher and the guide use.</p></div></div><div class="plist">' +
        S.displays.map((d, i) => '<button class="prow display-row' + (d.current ? ' sel' : '') + '" data-nav data-key="dp-' + esc(d.id) + '" data-zone="body" data-action="display" data-id="' + esc(d.id) + '">' +
          '<div class="picon" style="background:var(--chip);color:var(--text)">' + icon('monitor') + '</div><div class="pinfo"><div class="t">' + esc(d.name) + '</div><div class="p">' +
          esc([d.size, d.hz ? d.hz + ' Hz' : '', d.primary ? 'Main monitor' : ''].filter(Boolean).join(' · ')) + '</div></div>' +
          (d.current ? '<span class="status ok">In use</span>' : '<span class="status off">Use this one</span>') + '</button>').join('') + '</div>' +
        '<p class="field-note" style="margin-top:2rem;font-size:1.5rem">Games open on whatever monitor they choose; most use the main monitor, which you can change in Windows display settings.</p>';
    }
    if (tab === 'controllers') {
      const pads = Array.from(navigator.getGamepads ? navigator.getGamepads() : []).filter((p) => p && p.connected);
      let h = '<div class="sect-h"><div><h2>Controllers</h2><p>Any connected controller can move around the launcher.</p></div></div><div class="pad-list">';
      if (!pads.length) h += '<div class="prow"><div class="pinfo"><div class="t">No controllers found</div><div class="p">Press any button on a controller to wake it up</div></div></div>';
      pads.forEach((p, i) => {
        const kind = padKind(p.id);
        h += '<div class="prow"><div class="picon" style="background:var(--accent);color:var(--on-accent)">P' + (i + 1) + '</div><div class="pinfo"><div class="t">Player ' + (i + 1) + ' · ' + (kind === 'ps' ? 'PlayStation' : kind === 'nin' ? 'Nintendo' : 'Xbox / standard') + ' controller</div><div class="p">' + esc(p.id.replace(/\s*\(.*$/, '')) + '</div></div><span class="status ok">Connected</span></div>';
      });
      h += '</div><div class="sub-h">During a game</div><dl class="kv">' +
        '<dt>Back to the launcher</dt><dd>Hold View + Menu for 1 second' + (S.info.hotkey ? '' : ' (not available on this PC)') + '</dd>' +
        '<dt>Keyboard</dt><dd>Ctrl + Alt + Home</dd>' +
        '<dt>PlayStation / Switch pads</dt><dd>The hold works when Steam Input or DS4Windows is running</dd></dl>' +
        '<div class="sub-h">Guide</div><div class="toggles" style="grid-template-columns:1fr">' +
        toggleHTML('c-pause', 'Pause the game while the guide is open', S.lib.settings.pauseGame !== false, 'Stops the controller from also moving you in the game. Turn off for online matches, since a paused game can’t stay connected.', 'set-toggle', 'data-k="pauseGame"') + '</div>' +
        '<div class="sub-h">Music apps</div><div class="toggles" style="grid-template-columns:1fr">' +
        toggleHTML('c-mmouse', 'Use the controller as a mouse in Apple Music, Spotify and Discord', S.lib.settings.musicMouse !== false, 'Left stick moves the pointer, A clicks, right stick scrolls, B goes back, X plays/pauses. Xbox-style controllers.', 'set-toggle', 'data-k="musicMouse"') + '</div>' +
        '<div class="sub-h">Couch co-op</div><p class="field-note" style="font-size:1.5rem">Player 1–4 inside games are set once in each emulator’s own controller settings (Dolphin, RPCS3, Ryujinx). After that every game picks them up.</p>';
      return h;
    }
    if (tab === 'startup') {
      return '<div class="sect-h"><div><h2>Startup &amp; power</h2><p>Turn on the PC, grab a controller.</p></div></div><div class="toggles" style="grid-template-columns:1fr">' +
        toggleHTML('st-auto', 'Start with Windows', s.autostart, 'Opens the launcher full screen when you sign in', 'autostart') +
        '<button class="toggle-row" data-nav data-key="st-name" data-zone="body" data-action="rename"><span><div>Your name</div><div class="d">Shown at the top of Home</div></span><span>' + esc(s.userName || 'Player') + '</span></button></div>' +
        '<div class="sub-h">Power</div><div class="btn-row">' +
        '<button class="btn big" data-nav data-key="pw-exit" data-zone="body" data-action="power" data-p="exit">' + icon('exit') + 'Exit to desktop</button>' +
        '<button class="btn big" data-nav data-key="pw-sleep" data-zone="body" data-action="power" data-p="sleep">' + icon('moon') + 'Sleep</button>' +
        '<button class="btn big" data-nav data-key="pw-restart" data-zone="body" data-action="power" data-p="restart">' + icon('restart') + 'Restart</button>' +
        '<button class="btn big" data-nav data-key="pw-off" data-zone="body" data-action="power" data-p="shutdown">' + icon('power') + 'Shut down</button></div>';
    }
    return '<div class="sect-h"><div><h2>About</h2><p>Couch Launcher ' + esc(S.info.version || '') + '</p></div></div><dl class="kv">' +
      '<dt>Games</dt><dd>' + games().length + '</dd><dt>Controllers</dt><dd>' + padCount() + ' connected</dd>' +
      '<dt>Full screen</dt><dd>' + (S.info.windowed ? 'Off (windowed mode)' : 'On') + '</dd></dl>' +
      '<div class="btn-row" style="margin-top:3rem"><button class="btn big primary" data-nav data-key="ab-update" data-zone="body" data-action="update-check">' + icon('refresh') + 'Check for update</button>' +
      '<button class="btn big" data-nav data-key="ab-rescan" data-zone="body" data-action="rescan">' + icon('refresh') + 'Rescan games</button></div>' +
      '<p class="field-note" style="margin-top:2rem;font-size:1.5rem">To update: put the CouchLauncher-update zip from the chat in your Downloads folder or G:\\launcher. The launcher finds it there.</p>';
  }
  function padKind(id) {
    if (/045e|xbox|xinput/i.test(id)) return 'xbox';
    // Sony pads report vendor 054c; a DualShock 4 may just call itself "Wireless Controller".
    if (/054c|playstation|dualsense|dualshock|^wireless controller/i.test(id)) return 'ps';
    if (/057e|nintendo|pro controller|joy-?con/i.test(id)) return 'nin';
    return 'xbox';
  }
  // Re-render only the right side of Library/Settings (focus stays where it is).
  function refreshContent() {
    const c = $('#content');
    if (!c) return;
    const scroll = c.scrollTop;
    const focusedKey = currentFocus() ? currentFocus().dataset.key : null;
    c.innerHTML = S.view === 'library' ? libraryContentHTML() : settingsContentHTML();
    c.scrollTop = scroll;
    if (focusedKey && !layers.length) {
      const el = $('[data-key="' + cssEsc(focusedKey) + '"]', $('#app'));
      if (el) setFocus(el, { instant: true, noScroll: true });
      else setFocus($('[data-nav]', c) || $('.side .sideitem.sel') || $('.side [data-nav]'), { instant: true });
    }
    // Side list selection highlight
    $$('.side .sideitem').forEach((b) => b.classList.toggle('sel', (S.view === 'library' ? b.dataset.f === S.libFilter : b.dataset.tab === S.setTab)));
    updatePrompts();
  }

  // ---------------------------------------------------------------- focus & navigation
  function scope() { return layers.length ? layers[layers.length - 1].el : $('#app'); }
  function visible(el) { if (el.disabled || el.closest('.leave')) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
  function navEls() { return $$('[data-nav]', scope()).filter(visible); }
  function currentFocus() {
    const sc = scope();
    const el = $('[data-nav].focused', sc);
    return el && visible(el) ? el : null;
  }
  function restoreFocusClass() {
    if (layers.length || !S.baseFocus) return;
    if (currentFocus()) return;
    const el = $('[data-key="' + cssEsc(S.baseFocus) + '"]', $('#app'));
    if (el) el.classList.add('focused');
  }
  function setFocus(el, opts) {
    opts = opts || {};
    if (!el) return;
    const sc = scope();
    for (const f of $$('[data-nav].focused', sc)) if (f !== el) f.classList.remove('focused');
    el.classList.add('focused');
    const top = layers[layers.length - 1];
    if (top) top.focusKey = el.dataset.key; else S.baseFocus = el.dataset.key;
    if (el.dataset.zone) S.zoneMemory[el.dataset.zone] = el.dataset.key;
    if (!opts.noScroll) ensureVisible(el, opts.instant);
    onFocusChanged(el);
  }
  function ensureVisible(el, instant) {
    const sc = el.closest('.row, .content, .fb-list, .side, .flist, .gbody');
    if (!sc) return;
    const r = el.getBoundingClientRect(), c = sc.getBoundingClientRect();
    const rem = remPx();
    const behavior = instant || reduce() ? 'auto' : 'smooth';
    if (sc.classList.contains('row')) {
      const pad = 5.6 * rem;
      let dx = 0;
      if (r.left < c.left + pad) dx = r.left - (c.left + pad);
      else if (r.right > c.right - pad) dx = r.right - (c.right - pad);
      if (Math.abs(dx) > 1) sc.scrollBy({ left: dx, behavior });
    } else {
      const tight = sc.classList.contains('fb-list') || sc.classList.contains('flist') || sc.classList.contains('gbody');
      const top = (tight ? 1 : 4) * rem, bottom = (tight ? 1 : 3.5) * rem;
      // Music controls: keep the whole card (cover and song) in view, not just the buttons.
      const card = el.closest('.gmusic');
      const rTop = card ? card.getBoundingClientRect().top : r.top;
      let dy = 0;
      if (rTop < c.top + top) dy = rTop - (c.top + top);
      else if (r.bottom > c.bottom - bottom) dy = r.bottom - (c.bottom - bottom);
      // At the top of a list, show its heading too.
      if (dy < 0 && sc.scrollTop + dy < 6 * rem) dy = -sc.scrollTop;
      // Items pinned under the music card (Home): going there shows the whole card again.
      if (el.hasAttribute('data-top') && sc.scrollTop > 0) dy = -sc.scrollTop;
      if (Math.abs(dy) > 1) sc.scrollBy({ top: dy, behavior });
    }
  }

  let tabTimer = null;
  function onFocusChanged(el) {
    if (!layers.length) {
      if (S.view === 'home') updateHero(false);
      // Settings tabs follow focus, like a console.
      if (S.view === 'settings' && el.dataset.action === 'tab' && el.dataset.tab !== S.setTab) {
        clearTimeout(tabTimer);
        tabTimer = setTimeout(() => { if (currentFocus() === el) { S.setTab = el.dataset.tab; refreshContent(); $('#content').scrollTop = 0; } }, 140);
      }
      if (S.view === 'library' && el.dataset.action === 'filter' && el.dataset.f !== S.libFilter) {
        clearTimeout(tabTimer);
        tabTimer = setTimeout(() => { if (currentFocus() === el) { S.libFilter = el.dataset.f; refreshContent(); $('#content').scrollTop = 0; } }, 160);
      }
    }
    const top = layers[layers.length - 1];
    if (top && top.onFocus) top.onFocus(el);
    updatePrompts();
  }

  function rectOf(el) { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 }; }
  function overlap(a1, a2, b1, b2) { return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1)); }

  function findNext(cur, dir, els) {
    const c = rectOf(cur);
    const horiz = dir === 'left' || dir === 'right';
    const lock = cur.dataset.lock;
    let cands = els.filter((e) => e !== cur);
    if (horiz && lock) {
      const same = cands.filter((e) => e.dataset.lock === lock);
      cands = same; // rows don't jump to another row sideways
    } else if (horiz) {
      // The top dock is only reached by pressing up, never sideways from the page.
      cands = cands.filter((e) => e.dataset.lock !== 'nav');
    }
    if (horiz && !lock) {
      // Sideways: stay in the same row when something is there; otherwise cross over to the
      // next panel (e.g. back to the Settings menu) instead of drifting diagonally down the page.
      const side = cands.filter((e) => { const r = rectOf(e); return dir === 'right' ? r.l >= c.cx : r.r <= c.cx; });
      const inRow = side.filter((e) => { const r = rectOf(e); return overlap(c.t, c.b, r.t, r.b) > Math.min(c.b - c.t, r.b - r.t) * 0.3; });
      if (inRow.length) cands = inRow;
      else {
        const other = side.filter((e) => e.dataset.zone && e.dataset.zone !== cur.dataset.zone);
        if (other.length) cands = other;
      }
    }
    let best = null, bestScore = Infinity;
    for (const e of cands) {
      const r = rectOf(e);
      let primary, ortho, ov;
      if (dir === 'right') { if (r.l < c.cx) continue; primary = Math.max(0, r.l - c.r); ov = overlap(c.t, c.b, r.t, r.b); ortho = ov > 0 ? 0 : Math.abs(r.cy - c.cy); }
      else if (dir === 'left') { if (r.r > c.cx) continue; primary = Math.max(0, c.l - r.r); ov = overlap(c.t, c.b, r.t, r.b); ortho = ov > 0 ? 0 : Math.abs(r.cy - c.cy); }
      else if (dir === 'down') { if (r.t < c.cy) continue; primary = Math.max(0, r.t - c.b); ov = overlap(c.l, c.r, r.l, r.r); ortho = ov > 0 ? Math.abs(r.l - c.l) * 0.05 : Math.abs(r.cx - c.cx); }
      else { if (r.b > c.cy) continue; primary = Math.max(0, c.t - r.b); ov = overlap(c.l, c.r, r.l, r.r); ortho = ov > 0 ? Math.abs(r.l - c.l) * 0.05 : Math.abs(r.cx - c.cx); }
      const score = primary + ortho * 2;
      if (score < bestScore) { bestScore = score; best = e; }
    }
    // Coming back into an area you were in before? Return to the same item.
    if (best && best.dataset.zone && best.dataset.zone !== cur.dataset.zone) {
      const memKey = S.zoneMemory[best.dataset.zone];
      const mem = memKey && els.find((e) => e.dataset.key === memKey);
      if (mem && mem !== best) {
        const r = rectOf(mem);
        const okDir = dir === 'right' ? r.cx > c.cx : dir === 'left' ? r.cx < c.cx : dir === 'down' ? r.cy > c.cy : r.cy < c.cy;
        if (okDir) best = mem;
      }
    }
    return best;
  }
  function move(dir) {
    const top = topLayer();
    if (top && top.onMove && top.onMove(dir, currentFocus())) return true;
    const els = navEls();
    if (!els.length) return false;
    const cur = currentFocus();
    if (!cur) { setFocus(els[0]); return true; }
    const next = findNext(cur, dir, els);
    if (next) { setFocus(next); return true; }
    return false;
  }
  function page(dir) { for (let i = 0; i < 4; i++) if (!move(dir)) break; }

  // ---------------------------------------------------------------- layers (dialogs)
  function openLayer(opts) {
    const el = document.createElement('div');
    el.className = 'layer' + (opts.className ? ' ' + opts.className : '');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML = opts.html;
    $('#layers').appendChild(el);
    const prev = currentFocus();
    if (prev) prev.classList.remove('focused');
    const layer = Object.assign({ el, focusKey: null, openedAt: Date.now() }, opts);
    layers.push(layer);
    const first = opts.focus ? $('[data-key="' + cssEsc(opts.focus) + '"]', el) : null;
    setFocus(first || $('[data-nav]', el), { instant: true });
    updatePrompts();
    return layer;
  }
  function closeLayer(layer) {
    const i = layers.indexOf(layer);
    if (i < 0) return;
    layers.splice(i, 1);
    const el = layer.el;
    if (reduce()) el.remove(); else { el.classList.add('closing'); setTimeout(() => el.remove(), 190); }
    if (layer.onClose) layer.onClose();
    const sc = scope();
    const key = layers.length ? layers[layers.length - 1].focusKey : S.baseFocus;
    const back = key && $('[data-key="' + cssEsc(key) + '"]', sc);
    if (back && visible(back)) setFocus(back, { instant: true, noScroll: !layers.length });
    else { const f = $('[data-nav]', sc); if (f) setFocus(f, { instant: true }); }
    updatePrompts();
  }
  const topLayer = () => layers[layers.length - 1];

  // Generic menu (list of actions)
  function openMenu(title, items) {
    return new Promise((resolve) => {
      let done = false;
      const layer = openLayer({
        html: '<div class="dialog menu"><h2>' + esc(title) + '</h2>' + items.map((it, i) =>
          '<button class="mitem' + (it.danger ? ' danger' : '') + '" data-nav data-key="m-' + i + '" data-idx="' + i + '">' + icon(it.icon || 'play') + '<span>' + esc(it.label) + '</span></button>').join('') + '</div>',
        onActivate: (el) => { done = true; closeLayer(layer); resolve(items[Number(el.dataset.idx)].id); },
        onBack: () => { closeLayer(layer); },
        onClose: () => { if (!done) resolve(null); },
        prompts: () => [['A', 'Select'], ['B', 'Close']]
      });
    });
  }
  function confirmBox(title, text, okLabel, danger, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      let result = false;
      const layer = openLayer({
        html: '<div class="dialog confirm"><h2>' + esc(title) + '</h2><p>' + esc(text) + '</p><div class="dialog-foot">' +
          '<button class="btn big" data-nav data-key="c-no" data-v="0">' + esc(opts.cancelLabel || 'Cancel') + '</button><button class="btn big ' + (danger ? 'danger' : 'primary') + '" data-nav data-key="c-yes" data-v="1">' + esc(okLabel) + '</button></div></div>',
        focus: opts.focusOk ? 'c-yes' : 'c-no',
        onActivate: (el) => { result = el.dataset.v === '1'; closeLayer(layer); },
        onBack: () => closeLayer(layer),
        onClose: () => resolve(result),
        prompts: () => [['A', 'Select'], ['B', 'Cancel']]
      });
    });
  }

  // ---- Color wheel (controller and mouse friendly)
  function hsvToHex(h, sat, v) {
    const f = (n) => { const k = (n + h / 60) % 6; return v - v * sat * Math.max(0, Math.min(k, 4 - k, 1)); };
    return '#' + [f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  function hexToHsv(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return { h: 30, s: 0.8, v: 0.95 };
    const n = parseInt(m[1], 16), r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: (h * 60 + 360) % 360, s: mx ? d / mx : 0, v: mx };
  }
  function colorWheel(initial) {
    return new Promise((resolve) => {
      let result = null;
      const c = hexToHsv(initial || (S.theme && S.theme.accent));
      c.v = Math.max(0.35, c.v);
      const layer = openLayer({
        html: '<div class="dialog cwheel"><h2>Pick a color</h2><div class="cw-body">' +
          '<button class="cw-wheel" data-nav data-key="cw-wheel" data-act="wheel" aria-label="Color wheel"><span class="cw-shade"></span><span class="cw-dot"></span></button>' +
          '<div class="cw-side"><div class="cw-preview"></div><div class="cw-hex"></div>' +
          '<span class="lbl">Brightness</span><button class="cw-slider" data-nav data-key="cw-light" data-act="light" aria-label="Brightness"><span class="cw-knob"></span></button>' +
          '<p class="hint">On the wheel: left and right change the color, up and down make it more or less vivid. Press A to go to brightness.</p></div></div>' +
          '<div class="dialog-foot"><button class="btn big" data-nav data-key="cw-cancel" data-act="cancel">Cancel</button>' +
          '<button class="btn big primary" data-nav data-key="cw-use" data-act="use">Use color</button></div></div>',
        focus: 'cw-wheel',
        onMove: (dir, el) => {
          if (!el) return false;
          if (el.dataset.act === 'wheel') {
            if (dir === 'left') c.h = (c.h + 354) % 360;
            else if (dir === 'right') c.h = (c.h + 6) % 360;
            else if (dir === 'up') c.s = Math.min(1, c.s + 0.05);
            else c.s = Math.max(0, c.s - 0.05);
            draw(); return true;
          }
          if (el.dataset.act === 'light' && (dir === 'left' || dir === 'right')) {
            c.v = Math.min(1, Math.max(0.2, c.v + (dir === 'right' ? 0.04 : -0.04)));
            draw(); return true;
          }
          return false;
        },
        onActivate: (el) => {
          const act = el.dataset.act;
          if (act === 'wheel') return setFocus($('[data-key="cw-light"]', layer.el));
          if (act === 'light') return setFocus($('[data-key="cw-use"]', layer.el));
          if (act === 'use') { result = hsvToHex(c.h, c.s, c.v); return closeLayer(layer); }
          if (act === 'cancel') return closeLayer(layer);
        },
        onBack: () => closeLayer(layer),
        onClose: () => resolve(result),
        prompts: (el) => (el && (el.dataset.act === 'wheel' || el.dataset.act === 'light') ? [['A', 'Next'], ['B', 'Cancel']] : [['A', 'Select'], ['B', 'Cancel']])
      });
      const wheel = $('.cw-wheel', layer.el), dot = $('.cw-dot', layer.el), shade = $('.cw-shade', layer.el);
      const knob = $('.cw-knob', layer.el), slider = $('.cw-slider', layer.el);
      function draw() {
        const hex = hsvToHex(c.h, c.s, c.v);
        const a = c.h * Math.PI / 180;
        dot.style.left = (50 + 50 * c.s * Math.sin(a)) + '%';
        dot.style.top = (50 - 50 * c.s * Math.cos(a)) + '%';
        dot.style.background = hex;
        shade.style.opacity = String(1 - c.v);
        knob.style.left = ((c.v - 0.2) / 0.8 * 100) + '%';
        slider.style.background = 'linear-gradient(to right, #000, ' + hsvToHex(c.h, c.s, 1) + ')';
        $('.cw-preview', layer.el).style.background = hex;
        $('.cw-hex', layer.el).textContent = hex;
      }
      // Mouse: click or drag on the wheel and the slider
      const fromWheel = (e) => {
        const r = wheel.getBoundingClientRect();
        const x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
        c.h = (Math.atan2(x, -y) * 180 / Math.PI + 360) % 360;
        c.s = Math.min(1, Math.hypot(x, y) / (r.width / 2));
        draw();
      };
      const fromSlider = (e) => { const r = slider.getBoundingClientRect(); c.v = Math.min(1, Math.max(0.2, 0.2 + 0.8 * (e.clientX - r.left) / r.width)); draw(); };
      for (const [elx, fn] of [[wheel, fromWheel], [slider, fromSlider]]) {
        elx.addEventListener('pointerdown', (e) => { fn(e); elx.setPointerCapture(e.pointerId); });
        elx.addEventListener('pointermove', (e) => { if (e.buttons) fn(e); });
      }
      draw();
    });
  }

  // On-screen keyboard. Physical keyboards can type straight into the box too.
  function osk(title, value, placeholder) {
    return new Promise((resolve) => {
      let result = null;
      let shift = false;
      const rows = [
        '1234567890'.split(''),
        'qwertyuiop'.split(''),
        "asdfghjkl'".split(''),
        ['SHIFT'].concat('zxcvbnm'.split(''), ['-', '.']),
        ['BKSP', 'SPACE', 'CLEAR', 'DONE']
      ];
      const keyHTML = (k) => {
        if (k === 'SHIFT') return '<button class="key" data-nav data-key="k-shift" data-k="SHIFT" aria-label="Shift">' + icon('shift') + '</button>';
        if (k === 'BKSP') return '<button class="key w2" data-nav data-key="k-bksp" data-k="BKSP" aria-label="Backspace">' + icon('bksp') + '</button>';
        if (k === 'SPACE') return '<button class="key w5" data-nav data-key="k-space" data-k="SPACE"><small>Space</small></button>';
        if (k === 'CLEAR') return '<button class="key w2" data-nav data-key="k-clear" data-k="CLEAR"><small>Clear</small></button>';
        if (k === 'DONE') return '<button class="key w3" data-nav data-key="k-done" data-k="DONE" style="background:var(--accent);color:var(--on-accent)"><small>Done</small></button>';
        return '<button class="key" data-nav data-key="k-' + esc(k) + '" data-k="' + esc(k) + '">' + esc(k) + '</button>';
      };
      const layer = openLayer({
        html: '<div class="dialog osk"><h2>' + esc(title) + '</h2><input class="osk-input" type="text" spellcheck="false" maxlength="120" placeholder="' + esc(placeholder || '') + '" aria-label="' + esc(title) + '">' +
          '<div class="keys">' + rows.map((r) => '<div class="krow">' + r.map(keyHTML).join('') + '</div>').join('') + '</div></div>',
        focus: 'k-q',
        onActivate: (el) => press(el.dataset.k),
        onBack: () => closeLayer(layer),
        onButton: (b) => {
          if (b === 'X') { press('BKSP'); return true; }
          if (b === 'Y') { press('SPACE'); return true; }
          if (b === 'MENU') { press('DONE'); return true; }
          if (b === 'VIEW' || b === 'LB') { press('SHIFT'); return true; }
          return false;
        },
        onKey: (e) => {
          if (e.key === 'Enter') { press('DONE'); return true; }
          if (e.key === 'Escape') { closeLayer(layer); return true; }
          // Typing while the text box isn't focused (after a mouse click on a key): send it to the box.
          if (e.target !== input && !e.ctrlKey && !e.altKey && !e.metaKey) {
            if (e.key === 'Backspace') { press('BKSP'); return true; }
            if (e.key.length === 1) { input.focus({ preventScroll: true }); insert(e.key); return true; }
          }
          return false;
        },
        onClose: () => resolve(result),
        prompts: () => S.input === 'pad'
          ? [['A', 'Type'], ['X', 'Delete'], ['Y', 'Space'], ['MENU', 'Done'], ['B', 'Cancel']]
          : [['A', 'Done'], ['B', 'Cancel']]
      });
      const input = $('.osk-input', layer.el);
      input.value = value || '';
      const caretEnd = () => { const n = input.value.length; try { input.setSelectionRange(n, n); } catch (_) { /* ignore */ } };
      caretEnd();
      setTimeout(() => { input.focus({ preventScroll: true }); caretEnd(); }, 30);
      function insert(text) {
        const s = input.selectionStart == null ? input.value.length : input.selectionStart;
        const e = input.selectionEnd == null ? s : input.selectionEnd;
        input.value = input.value.slice(0, s) + text + input.value.slice(e);
        const p = s + text.length;
        try { input.setSelectionRange(p, p); } catch (_) { /* ignore */ }
      }
      function press(k) {
        if (k === 'DONE') { result = input.value.trim(); closeLayer(layer); return; }
        if (k === 'SHIFT') {
          shift = !shift;
          $$('.key[data-k]', layer.el).forEach((b) => { const v = b.dataset.k; if (v.length === 1 && /[a-z]/i.test(v)) { b.textContent = shift ? v.toUpperCase() : v.toLowerCase(); } });
          $('[data-k="SHIFT"]', layer.el).classList.toggle('on', shift);
          return;
        }
        if (k === 'BKSP') {
          const s = input.selectionStart == null ? input.value.length : input.selectionStart;
          const e = input.selectionEnd == null ? s : input.selectionEnd;
          if (s !== e) { input.value = input.value.slice(0, s) + input.value.slice(e); try { input.setSelectionRange(s, s); } catch (_) { /* ignore */ } }
          else if (s > 0) { input.value = input.value.slice(0, s - 1) + input.value.slice(s); try { input.setSelectionRange(s - 1, s - 1); } catch (_) { /* ignore */ } }
          return;
        }
        if (k === 'CLEAR') { input.value = ''; return; }
        if (k === 'SPACE') { insert(' '); return; }
        insert(shift ? k.toUpperCase() : k);
      }
    });
  }

  // File / folder picker that works with a controller.
  const lastDirs = {};
  function browse(opts) {
    // opts: { title, exts, folder: bool, start }
    return new Promise((resolve) => {
      let result = null;
      let cur = '';
      const memKey = (opts.folder ? 'dir' : 'file') + ':' + (opts.exts || []).join(',');
      const layer = openLayer({
        html: '<div class="dialog fb"><h2>' + esc(opts.title) + '</h2><div class="fb-path"></div><div class="fb-list"></div>' +
          '<div class="dialog-foot"><button class="btn big" data-nav data-key="fb-native" data-act="native">' + icon('folder') + 'Windows file picker</button>' +
          '<button class="btn big" data-nav data-key="fb-paste" data-act="paste">' + icon('edit') + 'Paste a path</button>' +
          '<span class="hint fb-hint">' + esc(opts.hint || '') + '</span><button class="btn big" data-nav data-key="fb-cancel" data-act="cancel">Cancel</button>' +
          (opts.folder ? '<button class="btn big primary" data-nav data-key="fb-use" data-act="use">Use this folder</button>' : '') + '</div></div>',
        onActivate: (el) => {
          const act = el.dataset.act;
          if (act === 'cancel') { closeLayer(layer); return; }
          if (act === 'native') {
            api.pickNative({ title: opts.title, exts: opts.folder ? [] : opts.exts, folder: !!opts.folder, start: cur || undefined })
              .then((p) => { if (p && layers.indexOf(layer) >= 0) accept(p, !!opts.folder); })
              .catch((e) => toast(e.message, true));
            return;
          }
          if (act === 'paste') {
            osk(opts.folder ? 'Paste or type a folder path' : 'Paste or type a file path', '', opts.folder ? 'D:\\Games\\Switch' : 'C:\\Emulators\\Dolphin\\Dolphin.exe').then(async (typed) => {
              if (!typed || layers.indexOf(layer) < 0) return;
              let info;
              try { info = await api.statPath(typed); } catch (e) { toast(e.message, true); return; }
              if (!info.exists) { toast('Nothing found at ' + info.path, true); return; }
              if (info.isDir && !opts.folder) { load(info.path); return; } // open that folder in the list
              if (!info.isDir && opts.folder) { toast('That’s a file. Paste a folder path.', true); return; }
              if (!opts.folder && opts.exts && opts.exts.length && !opts.exts.includes(extOf(info.path))) { toast('That file type doesn’t fit here', true); return; }
              accept(info.path, info.isDir);
            });
            return;
          }
          if (act === 'use') { if (cur) { result = cur; lastDirs[memKey] = cur; closeLayer(layer); } else toast('Open a folder first'); return; }
          if (act === 'up') { load(el.dataset.path, cur); return; }
          if (el.dataset.dir === '1') { load(el.dataset.path); return; }
          if (el.dataset.path) { result = el.dataset.path; lastDirs[memKey] = cur; closeLayer(layer); }
        },
        onBack: () => { if (cur) { const parent = $('[data-act="up"]', layer.el); load(parent ? parent.dataset.path : '', cur); } else closeLayer(layer); },
        onClose: () => resolve(result),
        prompts: () => [['A', 'Open'], ['B', 'Up a level']].concat(opts.folder ? [['MENU', 'Use this folder']] : []),
        onButton: (b) => { if (b === 'MENU' && opts.folder) { layer.onActivate({ dataset: { act: 'use' } }); return true; } return false; }
      });
      function accept(p) {
        result = p;
        const parent = String(p).replace(/[\\/][^\\/]*$/, '');
        lastDirs[memKey] = opts.folder ? p : (parent || cur);
        closeLayer(layer);
      }
      const list = $('.fb-list', layer.el);
      const pathEl = $('.fb-path', layer.el);
      let token = 0;
      async function load(dir, focusPath) {
        const my = ++token;
        let res;
        try { res = await api.listDir(dir || '', opts.folder ? [] : (opts.exts || [])); }
        catch (e) { toast('Can’t open that folder: ' + e.message, true); if (dir) return load('', null); return; }
        if (my !== token || layers.indexOf(layer) < 0) return;
        cur = res.path;
        pathEl.textContent = res.path ? '‎' + res.path : 'This PC';
        const entries = opts.folder ? res.entries.filter((e) => e.isDir) : res.entries;
        let h = '';
        if (res.path) h += '<button class="fitem" data-nav data-key="fb-up" data-act="up" data-path="' + esc(res.parent || '') + '">' + icon('up') + '<span class="fn">Up one level</span></button>';
        h += entries.map((e, i) => '<button class="fitem' + (e.isDir ? ' dir' : '') + '" data-nav data-key="fb-' + i + '" data-dir="' + (e.isDir ? 1 : 0) + '" data-path="' + esc(e.path) + '">' +
          icon(e.isDir ? 'folder' : (/\.(png|jpe?g|webp|gif|bmp)$/i.test(e.name) ? 'image' : 'file')) + '<span class="fn">' + esc(e.name) + '</span></button>').join('');
        if (!entries.length) h += '<div class="hint" style="padding:2rem 1.6rem">' + (opts.folder ? 'No folders here' : 'Nothing that fits here') + '</div>';
        list.innerHTML = h;
        list.scrollTop = 0;
        const want = focusPath ? $$('.fitem', list).find((b) => b.dataset.path === focusPath) : null;
        setFocus(want || $('.fitem:not([data-act])', list) || $('.fitem', list) || $('[data-nav]', layer.el), { instant: true });
      }
      load(opts.start || lastDirs[memKey] || '');
    });
  }

  // ---------------------------------------------------------------- game actions
  const PICK_EXTS = ['.exe', '.lnk', '.url', '.bat'];
  function targetFromFile(p) {
    const ext = extOf(p);
    const E = S.info.emulators || {};
    if (baseName(p).toUpperCase() === 'EBOOT.BIN') return { launch: { type: 'emu', emu: 'rpcs3', file: p }, source: 'rpcs3', title: ps3Title(p) };
    if (ext === '.exe') return { launch: { type: 'exe', exe: p }, source: 'custom', title: cleanTitle(baseName(p)) };
    if (['.lnk', '.url', '.bat'].includes(ext)) return { launch: { type: 'open', path: p }, source: 'custom', title: cleanTitle(baseName(p)) };
    for (const k of ['dolphin', 'ryujinx']) if (E[k] && E[k].exts.includes(ext)) return { launch: { type: 'emu', emu: k, file: p }, source: 'custom', title: cleanTitle(baseName(p)) };
    return null;
  }
  function ps3Title(p) {
    const parts = String(p).split(/[\\/]/).filter(Boolean);
    // .../Game/PS3_GAME/USRDIR/EBOOT.BIN or .../BLUS12345/USRDIR/EBOOT.BIN
    const i = parts.length - 1;
    const name = parts[i - 2] === 'PS3_GAME' ? parts[i - 3] : parts[i - 2];
    return cleanTitle(name || 'PS3 game');
  }
  function targetText(g) {
    const L = g.launch || {};
    if (L.type === 'url') return (SOURCES[g.source] || {}).name + ' game';
    if (L.type === 'emu') return ((S.info.emulators[L.emu] || {}).name || L.emu) + ' · ' + L.file;
    if (L.type === 'exe') return L.exe;
    if (L.type === 'open') return L.path;
    return '';
  }

  async function play(id) {
    const g = byId(id);
    if (!g) return;
    if (S.playing) {
      if (S.playing.id === id && !layers.some((l) => l.className === 'launching')) { resumeGame(); return; }
      let st = null;
      try { st = await api.gameStatus(); } catch (_) { /* treat as nothing running */ }
      if (st && st.canClose) { await switchTo(id); return; }
      try { await api.cancelLaunch(); } catch (_) { /* ignore */ }
      S.playing = null;
    }
    S.playing = { id, tracked: null, at: Date.now() };
    // Boot screen: the game's background art fills the screen. With only a tile image, it's blurred behind the tile.
    const art = g.art || {};
    const cssUrl = (p) => "url('" + fileUrl(p).replace(/'/g, '%27') + "')";
    const bg = art.hero
      ? '<div class="launch-art" style="background-image:' + esc(cssUrl(art.hero)) + '"></div>'
      : art.tile ? '<div class="launch-art blur" style="background-image:' + esc(cssUrl(art.tile)) + '"></div>' : '';
    const layer = openLayer({
      className: 'launching',
      html: '<div class="launch-bg" style="background-color:' + tileColor(g) + '">' + bg + '</div>' +
        (!art.hero && art.tile ? '<div class="launch-card"><img src="' + esc(fileUrl(art.tile)) + '" alt=""></div>' : '') +
        '<div class="launch-info"><div class="launch-title">' + esc(g.title) + '</div><div class="launch-bar"><span></span></div></div>' +
        '<button class="launch-cancel" data-nav data-key="l-cancel" aria-label="Cancel">' + glyph('B') + 'Cancel</button>',
      // Only B (or a mouse click) cancels, so pressing A twice by accident doesn't stop the game.
      onActivate: () => { if (S.input === 'mouse') cancelLaunch(); },
      onBack: () => cancelLaunch(),
      prompts: () => [['B', 'Cancel']]
    });
    async function cancelLaunch() {
      // Always leave the boot screen right away; the app core closes whatever had started.
      if (S.playing && S.playing.id === id) S.playing = null;
      closeLayer(layer);
      try { await api.cancelLaunch(); } catch (_) { /* ignore */ }
    }
    await wait(reduce() ? 0 : 600);
    if (!S.playing || S.playing.id !== id) return;
    try {
      const r = await enqueue(() => api.launch(id));
      if (!S.playing) { try { await api.cancelLaunch(); } catch (_) { /* ignore */ } return; } // cancelled while it was starting
      if (S.playing.id !== id) return;
      S.playing.tracked = r.tracked;
      g.lastPlayed = Date.now();
      save();
    } catch (e) {
      S.playing = null;
      closeLayer(layer);
      toast(e.message, true);
    }
  }

  const exitWaiters = [];
  function backFromGame(payload) {
    if (payload && payload.cancelled) return; // a launch you cancelled closing in the background
    const id = payload && payload.gameId;
    const g = id && byId(id);
    if (g && payload.seconds) { g.playtime = (g.playtime || 0) + payload.seconds; save(); }
    S.playing = null;
    while (exitWaiters.length) exitWaiters.shift()(true);
    if (S.switching) return; // the switch flow starts the next game itself
    // Close boot screen and guide, then show Home with that game selected.
    for (const l of layers.slice().reverse()) if (l.className === 'launching' || l.isGuide) closeLayer(l);
    if (payload && payload.error) toast('Couldn’t start: ' + payload.error, true);
    if (!layers.length) {
      if (S.view !== 'home') S.view = 'home';
      S.baseFocus = g ? 'h-' + g.id : S.baseFocus;
      S.heroId = null;
      renderView(true, true);
    }
  }
  function waitForExit(ms) {
    return new Promise((resolve) => {
      if (!S.playing) return resolve(true);
      exitWaiters.push(resolve);
      setTimeout(() => { const i = exitWaiters.indexOf(resolve); if (i >= 0) exitWaiters.splice(i, 1); resolve(!S.playing); }, ms);
    });
  }
  async function resumeGame() {
    for (const l of layers.slice().reverse()) if (l.isGuide) closeLayer(l);
    if (OVERLAY) { try { await api.hideOverlay(); } catch (_) { /* ignore */ } return; }
    try { await api.resumeGame(); } catch (_) { /* ignore */ }
  }

  // Asks the running game to close the normal way. If it doesn't, offers to show it or force it.
  async function closeCurrentGame() {
    const cur = S.playing && byId(S.playing.id);
    const name = cur ? cur.title : 'The game';
    const waitLayer = openLayer({
      html: '<div class="dialog confirm"><h2>Closing ' + esc(name) + '…</h2><p>Asking it to close, like pressing its X.</p></div>',
      onActivate: () => {}, onBack: () => {}, prompts: () => []
    });
    try { await api.closeGame(false); } catch (_) { /* ignore */ }
    let gone = await waitForExit(12000);
    closeLayer(waitLayer);
    if (gone) return true;
    const pick = await openMenu(name + ' is still open', [
      { id: 'show', label: 'Show the game (it may be asking to save)', icon: 'resume' },
      { id: 'force', label: 'Force close (unsaved progress is lost)', icon: 'x', danger: true },
      { id: 'cancel', label: 'Cancel', icon: 'exit' }
    ]);
    if (pick === 'show') { resumeGame(); return false; }
    if (pick !== 'force') return false;
    try { await api.closeGame(true); } catch (_) { /* ignore */ }
    gone = await waitForExit(8000);
    if (!gone) toast(name + ' couldn’t be closed', true);
    return gone;
  }

  async function switchTo(id) {
    const g = byId(id);
    const cur = S.playing && byId(S.playing.id);
    const ok = await confirmBox('Switch to ' + g.title + '?',
      (cur ? cur.title : 'The game you’re playing') + ' will be closed the normal way first, so it can save or ask you to. Save your progress if the game doesn’t save on its own.',
      'Close & switch');
    if (!ok) return;
    for (const l of layers.slice().reverse()) if (l.isGuide) closeLayer(l);
    S.switching = true;
    let closed = false;
    try { closed = await closeCurrentGame(); } finally { S.switching = false; }
    if (closed) play(id);
    else if (!S.playing) renderView(false);
  }

  // ---------------------------------------------------------------- guide (Xbox button)
  let guideToggledAt = 0;
  function toggleGuide(fromGame) {
    if (Date.now() - guideToggledAt < 350) return; // one press can arrive twice (controller + app core)
    guideToggledAt = Date.now();
    const open = layers.find((l) => l.isGuide);
    if (open) { open.onBack(); return; }
    // The boot screen ignores the button at first (an accidental press), but after a few
    // seconds it opens the guide, so a game that starts wrong can't leave you stuck there.
    if (layers.some((l) => l.className === 'launching' && Date.now() - l.openedAt < 3000)) return;
    openGuide({ fromGame });
  }

  async function openGuide(opts) {
    opts = opts || {};
    if (layers.some((l) => l.isGuide)) return;
    for (const l of layers.slice().reverse()) if (l.className === 'launching') closeLayer(l);
    let tab = opts.tab || 'games';
    let status = null;
    let friends = null, friendsErr = null, xboxOn = false;
    const TABS_G = [['games', 'grid', 'Games'], ['friends', 'users', 'Friends'], ['system', 'user', 'Profile & system']];
    let music = null, musicErr = null, musicTimer = null;
    const item = (key, ic, label, attrs, cls) => '<button class="mitem' + (cls ? ' ' + cls : '') + '" data-nav data-key="' + key + '" data-zone="gbody" ' + attrs + '>' + icon(ic) + '<span>' + label + '</span></button>';
    const thumb = (g) => '<span class="mthumb" style="background-color:' + tileColor(g) + (g.art && g.art.tile ? ';background-image:url(&quot;' + esc(fileUrl(g.art.tile)) + '&quot;)' : '') + '"></span>';
    function body() {
      if (tab === 'games') {
        let h = item('g-home', 'home', 'Home', 'data-act="home" data-top') + '<div class="gsep"></div>' + musicHTML();
        const cur = S.playing && byId(S.playing.id);
        if (cur) {
          h += '<div class="glabel">Now playing</div><div class="gnow">' + thumb(cur) + '<div class="gnow-t">' + esc(cur.title) + '</div></div>' +
            item('g-resume', 'resume', 'Resume game', 'data-act="resume"') +
            (status && status.canClose ? item('g-close', 'x', 'Close game', 'data-act="close"', 'danger') : '') + '<div class="gsep"></div>';
        }
        const recent = games().filter((g) => !cur || g.id !== cur.id).sort((a, b) => (b.lastPlayed - a.lastPlayed) || (b.addedAt - a.addedAt)).slice(0, 6);
        if (recent.length) {
          h += '<div class="glabel">' + (cur ? 'Switch to' : 'Recent') + '</div>' + recent.map((g) =>
            '<button class="mitem gitem2" data-nav data-key="g-' + esc(g.id) + '" data-zone="gbody" data-act="play" data-id="' + esc(g.id) + '">' + thumb(g) + '<span>' + esc(g.title) + '</span></button>').join('');
          h += '<div class="gsep"></div>';
        }
        h += item('g-lib', 'grid', 'My library', 'data-act="library"') + item('g-add', 'plus', 'Add a game', 'data-act="add"');
        return h;
      }
      if (tab === 'friends') return discordHTML() + friendSectionsHTML(friends, 'gbody');
      const s = S.lib.settings;
      return '<button class="gprofile" data-nav data-key="s-profile" data-zone="gbody" data-act="profile">' + avatarHTML('avatar') +
        '<span><span class="gp-name">' + esc(displayName()) + '</span><span class="gp-sub">' +
        (s.xbox ? icon('trophy') + Number(s.xbox.gamerscore || 0).toLocaleString() : 'Edit profile') + '</span></span></button>' +
        (s.xbox ? '' : item('s-connect', 'link', 'Connect Xbox account', 'data-act="connect"')) +
        '<div class="gsep"></div>' +
        item('s-settings', 'gear', 'Settings', 'data-act="settings"') +
        item('s-themes', 'palette', 'Themes', 'data-act="themes"') +
        item('s-platforms', 'refresh', 'Platforms & rescan', 'data-act="platforms"') +
        '<div class="gsep"></div>' + item('s-power', 'power', 'Power', 'data-act="power"');
    }
    function html() {
      const t = TABS_G.find((x) => x[0] === tab);
      return '<aside class="guide"><div class="gtabs">' + TABS_G.map(([k, ic, label]) =>
        '<button class="gtab' + (k === tab ? ' sel' : '') + '" data-nav data-key="tab-' + k + '" data-zone="gtabs" data-lock="gtabs" data-act="tab" data-tab="' + k + '" aria-label="' + label + '">' +
        (k === 'system' ? avatarHTML('gtab-av') : icon(ic)) + '</button>').join('') +
        '</div><div class="gtitle">' + t[2] + '</div><div class="gbody">' + body() + '</div></aside>';
    }
    let layer;
    function redraw(focusKey) {
      const key = focusKey || layer.focusKey;
      $('.guide', layer.el).outerHTML = html().replace('<aside class="guide">', '<aside class="guide still">');
      const el = (key && $('[data-key="' + cssEsc(key) + '"]', layer.el)) || $('.gbody [data-nav]', layer.el) || $('[data-nav]', layer.el);
      setFocus(el, { instant: true });
    }
    function setTab(t) {
      if (t === tab) return;
      tab = t;
      redraw('tab-' + t);
      const first = $('.gbody [data-nav]', layer.el);
      if (first) setFocus(first, { instant: true });
      if (tab === 'friends' && !friends) loadFriends();
      if (tab === 'friends') loadDiscord();
      clearInterval(musicTimer);
      if (tab === 'games') { musicCmd('state'); musicTimer = setInterval(() => musicCmd('state'), 2000); }
    }
    async function loadFriends() {
      const next = await loadAllFriends();
      friends = next;
      if (layers.indexOf(layer) >= 0 && tab === 'friends') redraw();
    }
    // Game / music balance, like the Xbox guide: left = more game, right = more music.
    let bal = null, balBusy = false, balNext = null;
    const balLevels = (b) => ({ balance: b, game: 100 - Math.max(0, b), music: 100 + Math.min(0, b) });
    function balanceHTML() {
      if (!S.playing || !bal) return '';
      const pos = (bal.balance + 100) / 2;
      return '<div class="mbal"><span class="mbside" title="Game">' + icon('pad') + '<b class="mb-g">' + bal.game + '%</b></span>' +
        '<button class="mbslider" data-nav data-key="m-bal" data-zone="gbody" data-act="m-bal" role="slider" aria-label="Game and music balance" aria-valuemin="-100" aria-valuemax="100" aria-valuenow="' + bal.balance + '" aria-valuetext="Game ' + bal.game + '%, music ' + bal.music + '%">' +
        '<span class="mbtrack"><span class="mbmid"></span><span class="mbknob" style="left:' + pos + '%"></span></span></button>' +
        '<span class="mbside" title="Music"><b class="mb-m">' + bal.music + '%</b>' + icon('music') + '</span></div>';
    }
    function setBalance(b) {
      b = Math.max(-100, Math.min(100, Math.round(b / 10) * 10));
      if (bal && bal.balance === b) return;
      bal = balLevels(b);
      // Move the slider right away; Windows catches up in the background.
      const sl = $('.mbslider', layer.el);
      if (sl) {
        $('.mbknob', sl).style.left = ((b + 100) / 2) + '%';
        sl.setAttribute('aria-valuenow', String(b));
        sl.setAttribute('aria-valuetext', 'Game ' + bal.game + '%, music ' + bal.music + '%');
        $('.mb-g', layer.el).textContent = bal.game + '%';
        $('.mb-m', layer.el).textContent = bal.music + '%';
      }
      balNext = b;
      if (!balBusy) pushBalance();
    }
    async function pushBalance() {
      balBusy = true;
      while (balNext != null) {
        const b = balNext; balNext = null;
        const pref = music && music.app === 'Spotify' ? 'Spotify' : music && music.app === 'Apple Music' ? 'AppleMusic' : (S.musicPref !== 'auto' ? S.musicPref : '');
        try { await api.balance(b, pref); } catch (_) { /* keep the slider where you put it */ }
      }
      balBusy = false;
    }
    // Discord: opens your pinned channels / servers / invites, mute & deafen, and sends a
    // message to the chat that's open (typed here, pasted into Discord).
    let dc = null;
    function discordHTML() {
      const pins = S.lib.settings.discordPins || [];
      const pill = (key, ic, label, attrs) => '<button class="pill gpill" data-nav data-key="' + key + '" data-zone="gbody" data-lock="dcrow" ' + attrs + '>' + icon(ic) + '<span>' + label + '</span></button>';
      const note = !dc ? '' : !dc.installed && !dc.running ? 'Not installed' : dc.running ? 'Open' : 'Not open';
      let h = '<div class="gdiscord"><div class="gm-head">' + icon('chat') + '<span>Discord</span><span class="gm-note">' + note + '</span></div>' +
        '<div class="gmrow">' + pill('dc-open', 'link', dc && dc.running ? 'Show' : 'Open', 'data-act="dc-open"') + pill('dc-msg', 'chat', 'Message', 'data-act="dc-msg"') +
        pill('dc-mute', 'mic', 'Mute', 'data-act="dc-mute"') + pill('dc-deaf', 'headset', 'Deafen', 'data-act="dc-deaf"') + '</div>';
      h += pins.map((p, i) => '<button class="mitem" data-nav data-key="dc-pin-' + i + '" data-zone="gbody" data-act="dc-pin" data-i="' + i + '">' + icon(p.kind === 'channel' ? 'chat' : 'users') + '<span>' + esc(p.name) + '</span></button>').join('');
      h += '<button class="mitem" data-nav data-key="dc-add" data-zone="gbody" data-act="dc-add">' + icon('plus') + '<span>' + (pins.length ? 'Pins: add or remove' : 'Pin a server, channel or call') + '</span></button>';
      return h + '</div><div class="gsep"></div>';
    }
    async function loadDiscord() {
      try { dc = await api.discordStatus(); } catch (_) { dc = null; }
      if (layers.indexOf(layer) >= 0 && tab === 'friends') redraw();
    }
    function musicHTML() {
      const pref = S.musicPref || 'auto';
      const prefLabel = pref === 'AppleMusic' ? 'Apple Music' : pref === 'Spotify' ? 'Spotify' : 'Auto';
      const pill = (key, ic, label, attrs) => '<button class="pill gpill" data-nav data-key="' + key + '" data-zone="gbody" data-lock="gmrow" ' + attrs + '>' + icon(ic) + '<span>' + label + '</span></button>';
      const playing = music && !music.none && !musicErr;
      if (!playing) {
        return '<div class="gmusic idle"><div class="gm-head">' + icon('music') + '<span>Music</span><span class="gm-note">' + esc(musicErr ? 'Not available' : music ? 'Nothing playing' : '') + '</span></div>' +
          balanceHTML() +
          '<div class="gmrow">' + pill('m-open-am', 'music', 'Apple Music', 'data-act="m-open" data-app="Apple Music"') + pill('m-open-sp', 'music', 'Spotify', 'data-act="m-open" data-app="Spotify"') + '</div></div><div class="gsep"></div>';
      }
      const ctl = (key, ic, label, act, extra) => '<button class="mbtn' + (extra || '') + '" data-nav data-key="' + key + '" data-zone="gbody" data-lock="mctl" data-act="' + act + '" aria-label="' + label + '">' + icon(ic) + '</button>';
      const other = music.app === 'Spotify' ? 'Apple Music' : 'Spotify';
      return '<div class="gmusic"><div class="gm-head">' + icon('music') + '<span>' + esc(music.app || 'Music') + '</span></div>' +
        '<div class="mnow">' + (music.art ? '<img class="mart" src="' + esc(music.art) + '" alt="">' : '<div class="mart">' + icon('music') + '</div>') +
        '<div class="minfo"><div class="mtitle">' + esc(music.title || 'Unknown song') + '</div><div class="martist">' + esc([music.artist, music.album].filter(Boolean).join(' · ')) + '</div></div></div>' +
        '<div class="mctl">' + ctl('m-prev', 'prev', 'Previous', 'm-prev') + ctl('m-play', music.playing ? 'pause' : 'play', music.playing ? 'Pause' : 'Play', 'm-toggle', ' big') +
        ctl('m-next', 'next', 'Next', 'm-next') + ctl('m-shuf', 'shuffle', 'Shuffle', 'm-shuffle', music.shuffle ? ' on' : '') + '</div>' +
        (S.playing && bal ? balanceHTML() : music.volume != null
          ? '<div class="mvol"><button class="mvbtn" data-nav data-key="m-vdown" data-zone="gbody" data-lock="mvol" data-act="m-voldown" aria-label="' + esc(music.app) + ' volume down">' + icon('minus') + '</button>' +
            '<div class="mvbar" role="meter" aria-label="' + esc(music.app) + ' volume" aria-valuenow="' + music.volume + '" aria-valuemin="0" aria-valuemax="100"><span style="width:' + music.volume + '%"></span></div>' +
            '<span class="mvpct">' + icon('volume') + music.volume + '%</span>' +
            '<button class="mvbtn" data-nav data-key="m-vup" data-zone="gbody" data-lock="mvol" data-act="m-volup" aria-label="' + esc(music.app) + ' volume up">' + icon('plus') + '</button></div>'
          : '') +
        '<div class="gmrow">' + pill('m-open-cur', 'link', 'Open app', 'data-act="m-open" data-app="' + esc(music.app === 'Spotify' ? 'Spotify' : 'Apple Music') + '"') +
        pill('m-open-other', 'music', other === 'Apple Music' ? 'Apple' : 'Spotify', 'data-act="m-open" data-app="' + other + '" aria-label="Open ' + other + '"') +
        pill('m-pref', 'refresh', 'Control: ' + prefLabel, 'data-act="m-pref"') + '</div></div><div class="gsep"></div>';
    }
    let musicSig = '';
    async function musicCmd(cmd) {
      if (!layer.focusKey) { const f = currentFocus(); if (f) layer.focusKey = f.dataset.key; }
      try { music = await api.media(cmd, S.musicPref === 'auto' ? '' : S.musicPref); musicErr = null; }
      catch (e) { musicErr = e.message; }
      // Windows sometimes doesn't report the app's volume for a moment (between songs, while paused):
      // keep showing the last known level for that app instead of hiding the controls.
      if (music && music.app && !music.none) {
        if (music.volume != null) S.musicVol = { app: music.app, v: music.volume };
        else if (S.musicVol && S.musicVol.app === music.app) music.volume = S.musicVol.v;
      }
      // Only redraw when something you can see changed (no flicker every 2 seconds).
      const sig = JSON.stringify([musicErr, music && [music.none, music.app, music.title, music.artist, music.album, music.playing, music.shuffle, music.art || '', music.volume], S.musicPref]);
      if (sig === musicSig) return;
      musicSig = sig;
      if (layers.indexOf(layer) >= 0 && tab === 'games') redraw();
    }
    const close = () => {
      if (OVERLAY || (opts.fromGame && S.playing)) resumeGame(); else closeLayer(layer);
    };
    layer = openLayer({
      isGuide: true,
      className: 'guide-layer',
      onMove: (dir, el) => {
        if (!el || el.dataset.act !== 'm-bal' || (dir !== 'left' && dir !== 'right')) return false;
        if (bal) setBalance(bal.balance + (dir === 'right' ? 10 : -10));
        return true;
      },
      html: html(),
      focus: 'g-resume',
      onActivate: async (el) => {
        const act = el.dataset.act;
        if (act === 'tab') return setTab(el.dataset.tab);
        if (act === 'm-bal') { if (S.input !== 'mouse') setBalance(0); return; } // A: back to the middle
        // Over the game: anything that needs the full launcher is handed to it.
        if (act === 'dc-open' || act === 'dc-pin') {
          const pin = act === 'dc-pin' ? (S.lib.settings.discordPins || [])[Number(el.dataset.i)] : null;
          try { await api.discordOpen(pin ? pin.url : null); if (!OVERLAY) toast(pin ? 'Opening ' + pin.name : 'Opening Discord'); } catch (e) { toast(e.message, true); }
          return;
        }
        if (act === 'dc-mute' || act === 'dc-deaf') {
          try { await api.discordKey(act === 'dc-deaf' ? 'deafen' : 'mute'); toast(act === 'dc-deaf' ? 'Deafen switched' : 'Mute switched'); }
          catch (e) { toast(e.message, true); }
          return;
        }
        if (act === 'dc-msg') {
          const text = await osk('Message for Discord', '', 'Goes to the chat that’s open in Discord');
          if (!text || !text.trim()) return;
          try { await api.discordType(text); } catch (e) { toast(e.message, true); }
          return;
        }
        if (OVERLAY && !['resume', 'friends-retry', 'm-toggle', 'm-next', 'm-prev', 'm-shuffle', 'm-pref', 'm-open', 'm-voldown', 'm-volup'].includes(act)) {
          const req = act === 'play' ? { action: S.playing ? 'switch' : 'goto', id: el.dataset.id, target: 'library' }
            : act === 'close' ? { action: 'close' } : { action: 'goto', target: act };
          closeLayer(layer);
          try { await api.overlayAction(req); } catch (e) { toast(e.message, true); }
          return;
        }
        if (act === 'resume') return resumeGame();
        if (act === 'close') {
          const cur = S.playing && byId(S.playing.id);
          if (!(await confirmBox('Close ' + (cur ? cur.title : 'the game') + '?', 'It will be closed the normal way, like pressing its X. Save first if the game doesn’t save on its own.', 'Close game', true))) return;
          closeLayer(layer);
          await closeCurrentGame();
          return;
        }
        if (act === 'play') { const id = el.dataset.id; if (S.playing) { await switchTo(id); return; } closeLayer(layer); return play(id); }
        if (act === 'library') { closeLayer(layer); return go('library'); }
        if (act === 'home') {
          closeLayer(layer);
          for (const l of layers.slice().reverse()) if (l.className === 'launching') closeLayer(l);
          try { await api.goHome(); } catch (_) { /* still go Home */ }
          return go('home', S.playing ? 'h-' + S.playing.id : null);
        }
        if (act === 'add') { closeLayer(layer); return openEdit(null); }
        if (act === 'connect') { if (await connectXbox()) { xboxOn = true; friends = null; redraw(); if (tab === 'friends') loadFriends(); } return; }
        if (act === 'connect-steam') { if (await connectSteam()) { friends = null; redraw(); loadFriends(); } return; }
        if (act === 'm-toggle') return musicCmd('toggle');
        if (act === 'm-next') return musicCmd('next');
        if (act === 'm-prev') return musicCmd('prev');
        if (act === 'm-shuffle') return musicCmd('shuffle');
        if (act === 'm-voldown') return musicCmd('voldown');
        if (act === 'm-volup') return musicCmd('volup');
        if (act === 'm-pref') { const order = ['auto', 'AppleMusic', 'Spotify']; S.musicPref = order[(order.indexOf(S.musicPref || 'auto') + 1) % 3]; return musicCmd('state'); }
        if (act === 'm-open') {
          const appName = el.dataset.app;
          const other = appName === 'Spotify' ? 'Apple Music' : 'Spotify';
          let open = {};
          try { open = await api.musicRunning(); } catch (_) { /* assume not */ }
          if (open[other] && !open[appName]) {
            const pick = await openMenu(other + ' is still open', [
              { id: 'close', label: 'Close ' + other + ' and open ' + appName, icon: 'x' },
              { id: 'keep', label: 'Keep both open', icon: 'music' },
              { id: 'cancel', label: 'Cancel', icon: 'exit' }
            ]);
            if (!pick || pick === 'cancel') return;
            if (pick === 'close') { toast('Closing ' + other + '…'); try { await api.closeMusic(other); } catch (e) { toast(e.message, true); } }
          }
          closeLayer(layer);
          try { await api.launchMusic(appName); if (!OVERLAY) toast('Opening ' + appName); } catch (e) { toast(e.message, true); }
          return;
        }
        if (act === 'friends-retry') { friends = null; redraw(); return loadFriends(); }
        if (act === 'dc-add') { closeLayer(layer); return discordPins(); }
        if (act === 'profile') { openProfile(); return; }
        if (act === 'settings') { closeLayer(layer); S.setTab = 'platforms'; return go('settings', 't-platforms'); }
        if (act === 'themes') { closeLayer(layer); S.setTab = 'themes'; return go('settings', 't-themes'); }
        if (act === 'platforms') { closeLayer(layer); S.setTab = 'platforms'; return go('settings', 'p-all'); }
        if (act === 'power') { closeLayer(layer); return powerMenu(); }
      },
      onButton: (b) => {
        const order = TABS_G.map((x) => x[0]);
        if (b === 'LB' || b === 'RB') {
          const i = order.indexOf(tab);
          const n = b === 'LB' ? Math.max(0, i - 1) : Math.min(order.length - 1, i + 1);
          setTab(order[n]);
          return true;
        }
        if (b === 'HOME') { close(); return true; }
        if (b === 'X' && tab === 'friends') { loadFriends(); return true; }
        if (tab === 'games' && music && !music.none && (b === 'Y' || b === 'LT' || b === 'RT')) { musicCmd(b === 'Y' ? 'toggle' : b === 'LT' ? 'prev' : 'next'); return true; }
        return false;
      },
      onBack: close,
      onClose: () => clearInterval(musicTimer),
      prompts: (el) => (el && el.dataset.act === 'm-bal' ? [['A', 'Even']] : tab === 'games' && music && !music.none ? [['A', 'Select'], ['Y', 'Play/Pause']] : [['A', 'Select']]).concat([['LB', 'Tabs'], ['B', opts.fromGame && S.playing ? 'Back to game' : 'Close']])
    });
    { const f0 = $('[data-key="g-resume"]', layer.el) || $('.gbody [data-act="play"]', layer.el) || $('.gbody [data-nav]', layer.el); if (f0) setFocus(f0, { instant: true }); }
    // Fill in what needs the app core: can the game be closed, is Xbox connected.
    try { status = await api.gameStatus(); } catch (_) { status = null; }
    try { xboxOn = await api.xboxStatus(); } catch (_) { xboxOn = false; }
    if (S.playing) { try { const v = await api.balance(null); bal = balLevels(v.balance); } catch (_) { bal = null; } }
    if (layers.indexOf(layer) < 0) return;
    redraw();
    // Mouse: click or drag along the balance slider.
    layer.el.addEventListener('pointerdown', (e) => {
      const sl = e.target.closest && e.target.closest('.mbslider');
      if (!sl || !bal) return;
      const at = (ev) => { const r = $('.mbtrack', sl).getBoundingClientRect(); setBalance(((ev.clientX - r.left) / r.width) * 200 - 100); };
      at(e);
      const mv = (ev) => { if (ev.buttons) at(ev); };
      const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    });
    if (tab === 'friends') { loadFriends(); loadDiscord(); }
    if (tab === 'games') { musicCmd('state'); clearInterval(musicTimer); musicTimer = setInterval(() => musicCmd('state'), 2000); }
  }

  async function loadAllFriends() {
    const out = { xbox: { on: false }, steam: { on: false } };
    try { out.xbox.on = await api.xboxStatus(); } catch (_) { /* not connected */ }
    try { out.steam.on = await api.steamStatus(); } catch (_) { /* not connected */ }
    await Promise.all([
      out.xbox.on ? api.xboxFriends().then((l) => { out.xbox.list = l; }, (e) => { out.xbox.err = e.message; }) : null,
      out.steam.on ? api.steamFriends().then((l) => { out.steam.list = l; }, (e) => { out.steam.err = e.message; }) : null
    ]);
    return out;
  }
  function friendSectionsHTML(fr, zone) {
    if (!fr) return '<p class="hint gpad">Loading…</p>';
    const z = zone ? ' data-zone="' + zone + '"' : '';
    const part = (key, label, connectAct) => {
      const f = fr[key];
      let h = '';
      if (!f.on) return '<div class="glabel">' + label + '</div><button class="mitem" data-nav data-key="con-' + key + '"' + z + ' data-act="' + connectAct + '">' + icon('link') + '<span>Connect ' + label + '</span></button>';
      if (f.err) return '<div class="glabel">' + label + '</div><p class="hint gpad">' + esc(f.err) + '</p>';
      const list = f.list || [];
      h += '<div class="glabel">' + label + ' · ' + list.filter((x) => x.online).length + ' online</div>';
      h += list.length ? friendItemsHTML(list, zone) : '<p class="hint gpad">No friends yet.</p>';
      return h;
    };
    return part('xbox', 'Xbox', 'connect') + '<div class="gsep"></div>' + part('steam', 'Steam', 'connect-steam');
  }
  function friendSummary(fr) {
    if (!fr) return 'Loading…';
    const all = [].concat(fr.xbox.list || [], fr.steam.list || []);
    if (!fr.xbox.on && !fr.steam.on) return 'Connect Xbox or Steam to see friends';
    return all.filter((f) => f.online).length + ' online · ' + all.length + ' friends';
  }

  function friendItemsHTML(fr, zone) {
    return fr.map((f) => '<button class="friend' + (f.online ? ' online' : '') + '" data-nav data-key="fr-' + esc(f.xuid || f.gamertag) + '"' + (zone ? ' data-zone="' + zone + '"' : '') + '>' +
      '<div class="fpic">' + esc(f.gamertag.charAt(0).toUpperCase()) + (f.pic ? '<img src="' + esc(f.pic) + '" alt="">' : '') + '<span class="fdot"></span></div>' +
      '<div class="finfo"><div class="fname">' + esc(f.gamertag) + (f.favorite ? ' <span class="fstar">' + starIcon + '</span>' : '') + '</div>' +
      '<div class="fstatus">' + esc(f.status || (f.online ? 'Online' : 'Offline')) + '</div></div></button>').join('');
  }

  async function gameMenu(g) {
    const items = [
      { id: 'play', label: 'Play', icon: 'play' },
      { id: 'edit', label: 'Edit game', icon: 'edit' },
      { id: 'fav', label: g.favorite ? 'Remove from favorites' : 'Add to favorites', icon: 'star' },
      { id: 'pin', label: g.pinned ? 'Unpin from Home' : 'Pin to Home', icon: 'pin' },
      { id: 'coop', label: g.coop ? 'Not a co-op game' : 'Mark as co-op', icon: 'users' }
    ];
    items.push(g.hidden ? { id: 'unhide', label: 'Unhide', icon: 'refresh' } : { id: 'hide', label: 'Hide from library', icon: 'x' });
    if (g.source === 'custom') items.push({ id: 'remove', label: 'Remove from library', icon: 'trash', danger: true });
    const pick = await openMenu(g.title, items);
    if (!pick) return;
    if (pick === 'play') return play(g.id);
    if (pick === 'edit') return openEdit(g);
    if (pick === 'fav') { g.favorite = !g.favorite; toast(g.favorite ? 'Added to favorites' : 'Removed from favorites'); }
    if (pick === 'pin') { g.pinned = !g.pinned; toast(g.pinned ? 'Pinned to Home' : 'Unpinned'); }
    if (pick === 'coop') { g.coop = !g.coop; toast(g.coop ? 'Marked as co-op' : 'Removed from co-op'); }
    if (pick === 'hide' || pick === 'unhide') {
      g.hidden = pick === 'hide';
      if (g.hidden) { if (S.heroId === g.id) S.heroId = null; if (S.baseFocus && S.baseFocus.endsWith(g.id)) S.baseFocus = null; }
      toast(g.hidden ? 'Hidden. Find it under Library › Hidden.' : 'Back in your library');
    }
    if (pick === 'remove') {
      if (!(await confirmBox('Remove ' + g.title + '?', 'It will be removed from the launcher. The game itself stays on your PC.', 'Remove', true))) return;
      removeGame(g.id);
      return;
    }
    save();
    rerenderKeepFocus();
  }
  function removeGame(id) {
    S.lib.games = S.lib.games.filter((x) => x.id !== id);
    S.deleted.add(id);
    if (S.baseFocus && S.baseFocus.endsWith(id)) S.baseFocus = null;
    if (S.heroId === id) S.heroId = null;
    save();
    rerenderKeepFocus();
    toast('Removed');
  }
  function rerenderKeepFocus() {
    if (S.view === 'home') { S.heroId = null; renderView(false); }
    else if (S.view === 'library') renderView(false);
    else refreshContent();
  }

  // Add / edit a game
  function openEdit(orig) {
    const isNew = !orig;
    const id = isNew ? 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) : orig.id;
    const d = isNew
      ? { id, key: 'custom:' + id, source: 'custom', title: '', launch: {}, art: {}, args: '', favorite: false, pinned: false, coop: false, playtime: 0, lastPlayed: 0, addedAt: Date.now() }
      : JSON.parse(JSON.stringify(orig));
    d.art = d.art || {};
    const artChanged = {};
    const editableTarget = d.source === 'custom';
    let layer;
    const html = () => {
      const tile = d.art.tile, hero = d.art.hero;
      const showArgs = d.launch.type === 'exe' || d.launch.type === 'emu' || isNew;
      return '<div class="dialog edit"><h2>' + (isNew ? 'Add a game' : 'Edit game') + '</h2><div class="edit-body">' +
        '<div class="edit-art"><span class="lbl">Artwork</span>' +
        '<button class="artslot tile-slot' + (tile ? ' has' : '') + '" data-nav data-key="e-tile" data-act="art" data-kind="tile">' +
        (tile ? '<img src="' + esc(fileUrl(tile)) + '" alt=""><span class="cap">Tile image</span>' : icon('image') + '<span>Tile image (square)</span><span class="hint">Pick an image file</span>') + '</button>' +
        '<button class="artslot hero-slot' + (hero ? ' has' : '') + '" data-nav data-key="e-hero" data-act="art" data-kind="hero">' +
        (hero ? '<img src="' + esc(fileUrl(hero)) + '" alt=""><span class="cap">Background</span>' : icon('image') + '<span>Background (wide)</span>') + '</button>' +
        '<button class="btn" data-nav data-key="e-findart" data-act="findart">' + icon('search') + 'Find art online</button>' +
        '</div><div class="edit-fields">' +
        '<div class="field"><span class="lbl" id="lbl-name">Name</span><button class="field-btn" data-nav data-key="e-name" data-act="name" aria-labelledby="lbl-name">' + (d.title ? '<span>' + esc(d.title) + '</span>' : '<span class="ph">Type a name</span>') + '</button></div>' +
        '<div class="field"><span class="lbl">Launch target</span>' +
        (editableTarget
          ? '<button class="field-btn" data-nav data-key="e-target" data-act="target">' + icon('file') + (targetText(d) ? '<span>' + esc(targetText(d)) + '</span>' : '<span class="ph">Choose a program or game file</span>') + '</button><span class="field-note">An .exe or shortcut, a Dolphin or Ryujinx game file, or a PS3 EBOOT.BIN</span>'
          : '<div class="field-static">' + esc(targetText(d)) + '</div><span class="field-note">Found automatically from ' + esc((SOURCES[d.source] || {}).name || d.source) + '</span>') + '</div>' +
        (showArgs ? '<div class="field"><span class="lbl">Launch options</span><button class="field-btn" data-nav data-key="e-args" data-act="args">' + (d.args ? '<span>' + esc(d.args) + '</span>' : '<span class="ph">Optional, for example -fullscreen</span>') + '</button></div>' : '') +
        '<div class="toggles">' +
        '<button class="toggle-row" data-nav data-key="e-fav" data-act="flag" data-f="favorite" role="switch" aria-checked="' + d.favorite + '"><span>Favorite</span><span class="switch' + (d.favorite ? ' on' : '') + '"></span></button>' +
        '<button class="toggle-row" data-nav data-key="e-pin" data-act="flag" data-f="pinned" role="switch" aria-checked="' + d.pinned + '"><span>Pin to Home</span><span class="switch' + (d.pinned ? ' on' : '') + '"></span></button>' +
        '<button class="toggle-row" data-nav data-key="e-coop" data-act="flag" data-f="coop" role="switch" aria-checked="' + d.coop + '"><span>Co-op game</span><span class="switch' + (d.coop ? ' on' : '') + '"></span></button>' +
        '</div></div></div><div class="dialog-foot">' +
        (!isNew && d.source === 'custom' ? '<button class="btn big danger left" data-nav data-key="e-del" data-act="delete">' + icon('trash') + 'Remove</button>' : '') +
        '<button class="btn big" data-nav data-key="e-cancel" data-act="cancel">Cancel</button><button class="btn big primary" data-nav data-key="e-save" data-act="save">' + (isNew ? 'Add game' : 'Save') + '</button></div></div>';
    };
    const redraw = () => {
      const key = layer.focusKey;
      layer.el.innerHTML = html();
      const el = (key && $('[data-key="' + cssEsc(key) + '"]', layer.el)) || $('[data-nav]', layer.el);
      setFocus(el, { instant: true });
    };
    layer = openLayer({
      html: html(),
      focus: isNew ? 'e-target' : 'e-name',
      onActivate: async (el) => {
        const act = el.dataset.act;
        if (act === 'cancel') return closeLayer(layer);
        if (act === 'name') { const v = await osk('Name', d.title, 'Game name'); if (v !== null && v) { d.title = v; d.titleTouched = true; redraw(); } return; }
        if (act === 'args') { const v = await osk('Launch options', d.args || '', 'e.g. -fullscreen'); if (v !== null) { d.args = v; redraw(); } return; }
        if (act === 'flag') { d[el.dataset.f] = !d[el.dataset.f]; redraw(); return; }
        if (act === 'findart') {
          if (!d.title.trim()) { toast('Give the game a name first', true); return; }
          if (!(await ensureArtKey())) return;
          toast('Looking for art…');
          try {
            const r = await enqueue(() => api.findArt(d.title, d.id, { tile: true, hero: true }));
            if (r.notFound) { toast('Couldn’t find “' + d.title + '” on SteamGridDB. Try its exact name.', true); return; }
            if (r.tile) { d.art.tile = r.tile; artChanged.tile = true; }
            if (r.hero) { d.art.hero = r.hero; artChanged.hero = true; }
            redraw();
            toast(r.tile || r.hero ? 'Found art for ' + (r.name || d.title) : 'No art for ' + (r.name || d.title) + ' yet', !(r.tile || r.hero));
          } catch (e) { toast(e.message, true); }
          return;
        }
        if (act === 'art') {
          const p = await browse({ title: el.dataset.kind === 'tile' ? 'Pick a tile image' : 'Pick a background image', exts: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'] });
          if (!p) return;
          try { d.art[el.dataset.kind] = await api.importArt(p, d.id, el.dataset.kind); artChanged[el.dataset.kind] = true; redraw(); }
          catch (e) { toast(e.message, true); }
          return;
        }
        if (act === 'target') {
          const exts = PICK_EXTS.concat((S.info.emulators.dolphin || { exts: [] }).exts, (S.info.emulators.ryujinx || { exts: [] }).exts, ['.bin']);
          const p = await browse({ title: 'Choose a program or game file', exts, hint: 'PS3: pick the EBOOT.BIN inside USRDIR' });
          if (!p) return;
          const t = targetFromFile(p);
          if (!t) { toast(extOf(p) === '.bin' ? 'For PS3 games, pick the EBOOT.BIN file' : 'That file type can’t be launched', true); return; }
          d.launch = t.launch;
          if (!d.title || (isNew && !d.titleTouched)) d.title = t.title;
          if (t.launch.type === 'emu' && !S.lib.platforms[t.launch.emu].exe) toast('Set up ' + S.info.emulators[t.launch.emu].name + ' in Settings › Platforms before playing this.', true);
          redraw();
          return;
        }
        if (act === 'delete') {
          if (await confirmBox('Remove ' + (d.title || 'this game') + '?', 'It will be removed from the launcher. The game itself stays on your PC.', 'Remove', true)) { closeLayer(layer); removeGame(d.id); }
          return;
        }
        if (act === 'save') {
          if (!d.title.trim()) { toast('Give the game a name', true); setFocus($('[data-key="e-name"]', layer.el)); return; }
          if (!d.launch || !d.launch.type) { toast('Choose what to launch', true); setFocus($('[data-key="e-target"]', layer.el)); return; }
          delete d.titleTouched;
          if (isNew) {
            S.lib.games.push(d);
          } else {
            const g = byId(d.id);
            if (!g) { toast('That game is no longer in the library', true); return closeLayer(layer); }
            if (g.title !== d.title) d.titleEdited = true;
            d.artEdited = Object.assign({}, g.artEdited || {});
            for (const k of Object.keys(artChanged)) d.artEdited[k] = true;
            Object.assign(g, d);
          }
          save();
          closeLayer(layer);
          if (isNew) { S.baseFocus = (S.view === 'library' ? 'g-' : 'h-') + d.id; }
          rerenderKeepFocus();
          toast(isNew ? 'Added ' + d.title : 'Saved');
        }
      },
      onButton: (b) => {
        const el = currentFocus();
        if (b === 'X' && el && el.dataset.act === 'art' && d.art[el.dataset.kind]) { d.art[el.dataset.kind] = null; artChanged[el.dataset.kind] = true; redraw(); return true; }
        if (b === 'MENU') { layer.onActivate($('[data-key="e-save"]', layer.el)); return true; }
        return false;
      },
      onBack: () => closeLayer(layer),
      prompts: (el) => {
        const p = [['A', 'Select']];
        if (el && el.dataset.act === 'art' && d.art[el.dataset.kind]) p.push(['X', 'Remove image']);
        return p.concat([['MENU', 'Save'], ['B', 'Cancel']]);
      }
    });
  }

  // ---------------------------------------------------------------- profile & Xbox
  function openProfile() {
    const s = S.lib.settings;
    let layer;
    const html = () => {
      const x = s.xbox;
      const rows = [];
      const from = profileFrom();
      const opt = (k, ic, label, desc) => '<button class="pf-opt' + (from === k ? ' sel' : '') + '" data-nav data-key="pf-from-' + k + '" data-lock="pffrom" data-act="from" data-from="' + k + '" role="radio" aria-checked="' + (from === k) + '">' + icon(ic) + '<span><b>' + label + '</b><small>' + desc + '</small></span></button>';
      rows.push('<div class="pf-label">Show my profile from</div><div class="pf-from" role="radiogroup">' +
        opt('xbox', 'trophy', 'Xbox', x ? esc(x.gamertag) : 'Not connected') +
        opt('steam', 'level', 'Steam', s.steamProfile ? esc(s.steamProfile.name) : 'Not connected') +
        opt('own', 'user', 'My own', esc(s.userName && s.userName !== 'Player' ? s.userName : 'Name + picture')) + '</div>');
      rows.push('<button class="mitem" data-nav data-key="pf-name" data-act="name">' + icon('edit') + '<span>' + (s.userName && s.userName !== 'Player' ? 'Change name (' + esc(s.userName) + ')' : 'Set your name') + '</span></button>');
      rows.push('<button class="mitem" data-nav data-key="pf-pic" data-act="pic">' + icon('image') + '<span>' + (s.avatar ? 'Change picture' : 'Choose a picture') + '</span></button>');
      if (s.avatar) rows.push('<button class="mitem" data-nav data-key="pf-nopic" data-act="nopic">' + icon('x') + '<span>Remove picture</span></button>');
      if (x) {
        rows.push('<button class="mitem" data-nav data-key="pf-refresh" data-act="refresh">' + icon('refresh') + '<span>Refresh Xbox profile</span></button>');
        rows.push('<button class="mitem danger" data-nav data-key="pf-disc" data-act="disconnect">' + icon('exit') + '<span>Disconnect Xbox account</span></button>');
      } else {
        rows.push('<button class="mitem" data-nav data-key="pf-connect" data-act="connect">' + icon('link') + '<span>Connect Xbox account</span></button>');
      }
      const sub = from === 'steam' ? icon('level') + '<span>' + esc(profileSub()) + '</span>'
        : x ? icon('trophy') + '<span>' + Number(x.gamerscore || 0).toLocaleString() + ' gamerscore</span>' + (from === 'xbox' ? '' : '<span class="pf-gt">· ' + esc(x.gamertag) + '</span>') : '<span>Xbox not connected</span>';
      return '<div class="dialog profile"><div class="pf-head">' + avatarHTML('pf-av') + '<div><h2>' + esc(displayName()) + '</h2><div class="pf-sub">' + sub + '</div></div></div>' +
        '<div class="pf-list">' + rows.join('') + '</div></div>';
    };
    const redraw = () => {
      const key = layer.focusKey;
      layer.el.innerHTML = html();
      setFocus((key && $('[data-key="' + cssEsc(key) + '"]', layer.el)) || $('[data-nav]', layer.el), { instant: true });
      renderTop();
    };
    layer = openLayer({
      html: html(),
      onActivate: async (el) => {
        const act = el.dataset.act;
        if (act === 'from') {
          const k = el.dataset.from;
          if (k === 'xbox' && !s.xbox) { if (!(await connectXbox())) return; }
          if (k === 'steam') {
            if (!s.steamProfile || Date.now() - (s.steamProfile.at || 0) > 600000) {
              let on = false; try { on = await api.steamStatus(); } catch (_) { /* no */ }
              if (!on && !(await connectSteam())) return;
              try { s.steamProfile = await api.steamMe(); } catch (e) { toast(e.message, true); return; }
            }
          }
          s.profileFrom = k; s.useXboxProfile = k === 'xbox';
          save(); layer.focusKey = 'pf-from-' + k; redraw(); return;
        }
        if (act === 'name') { const v = await osk('Your name', s.userName === 'Player' ? '' : s.userName, 'Name'); if (v) { s.userName = v; save(); redraw(); } return; }
        if (act === 'pic') {
          const p = await browse({ title: 'Choose a profile picture', exts: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'] });
          if (!p) return;
          try { s.avatar = await api.importArt(p, 'profile', 'avatar'); s.profileFrom = 'own'; s.useXboxProfile = false; save(); redraw(); } catch (e) { toast(e.message, true); }
          return;
        }
        if (act === 'nopic') { s.avatar = null; save(); layer.focusKey = 'pf-pic'; redraw(); return; }
        if (act === 'refresh') { await refreshXbox(false); redraw(); return; }
        if (act === 'disconnect') {
          if (!(await confirmBox('Disconnect Xbox?', 'Your gamerscore and friends list won’t show until you connect again.', 'Disconnect', true))) return;
          try { await api.xboxDisconnect(); } catch (_) { /* ignore */ }
          s.xbox = null; save(); layer.focusKey = 'pf-connect'; redraw(); toast('Xbox account disconnected');
          return;
        }
        if (act === 'connect') { if (await connectXbox()) { layer.focusKey = 'pf-refresh'; redraw(); } }
      },
      onBack: () => closeLayer(layer),
      prompts: () => [['A', 'Select'], ['B', 'Close']]
    });
  }

  // Walks through getting an OpenXBL key. Resolves true once connected.
  function connectXbox() {
    return new Promise((resolve) => {
      let ok = false;
      const layer = openLayer({
        html: '<div class="dialog confirm xbox-connect"><h2>Connect your Xbox account</h2>' +
          '<ol class="steps"><li>Choose <b>Open xbl.io</b> and sign in with your Microsoft (Xbox) account.</li>' +
          '<li>Copy the <b>API key</b> shown on your xbl.io profile.</li>' +
          '<li>Come back, choose <b>Paste API key</b> and press Ctrl+V.</li></ol>' +
          '<p class="hint">xbl.io (OpenXBL) is a free service that reads your Xbox profile and friends for apps like this one. Your key stays on this PC, encrypted.</p>' +
          '<div class="dialog-foot"><button class="btn big" data-nav data-key="x-cancel" data-act="cancel">Cancel</button>' +
          '<button class="btn big" data-nav data-key="x-site" data-act="site">' + icon('link') + 'Open xbl.io</button>' +
          '<button class="btn big primary" data-nav data-key="x-key" data-act="key">' + icon('key') + 'Paste API key</button></div></div>',
        focus: 'x-site',
        onActivate: async (el) => {
          const act = el.dataset.act;
          if (act === 'cancel') return closeLayer(layer);
          if (act === 'site') { try { await api.openXblSite(); } catch (e) { toast(e.message, true); } return; }
          if (act === 'key') {
            const k = await osk('Paste your xbl.io API key', '', 'Press Ctrl+V');
            if (!k) return;
            toast('Checking your key…');
            try {
              const profile = await api.xboxConnect(k);
              S.lib.settings.xbox = profile;
              S.lib.settings.useXboxProfile = true;
              if (!S.lib.settings.profileFrom || S.lib.settings.profileFrom === 'own') S.lib.settings.profileFrom = 'xbox';
              save(); renderTop();
              ok = true;
              toast('Connected as ' + profile.gamertag);
              closeLayer(layer);
            } catch (e) { toast(e.message, true); }
          }
        },
        onBack: () => closeLayer(layer),
        onClose: () => resolve(ok),
        prompts: () => [['A', 'Select'], ['B', 'Cancel']]
      });
    });
  }

  function connectSteam() {
    return new Promise((resolve) => {
      let ok = false;
      const layer = openLayer({
        html: '<div class="dialog confirm xbox-connect"><h2>Connect Steam</h2>' +
          '<ol class="steps"><li>Choose <b>Get a Steam key</b> and sign in. If it asks for a domain name, type <b>localhost</b>.</li>' +
          '<li>Copy the <b>Key</b> it shows (32 letters and numbers).</li>' +
          '<li>Come back, choose <b>Paste key</b> and press Ctrl+V.</li></ol>' +
          '<p class="hint">Your friends list on Steam must be public (Profile › Edit Profile › Privacy Settings). The key stays on this PC, encrypted.</p>' +
          '<div class="dialog-foot"><button class="btn big" data-nav data-key="s-cancel" data-act="cancel">Cancel</button>' +
          '<button class="btn big" data-nav data-key="s-site" data-act="site">' + icon('link') + 'Get a Steam key</button>' +
          '<button class="btn big primary" data-nav data-key="s-key" data-act="key">' + icon('key') + 'Paste key</button></div></div>',
        focus: 's-site',
        onActivate: async (el) => {
          const act = el.dataset.act;
          if (act === 'cancel') return closeLayer(layer);
          if (act === 'site') { try { await api.openSteamKeyPage(); } catch (e) { toast(e.message, true); } return; }
          if (act === 'key') {
            const k = await osk('Paste your Steam API key', '', 'Press Ctrl+V');
            if (!k) return;
            toast('Checking your key…');
            let r = null;
            try { r = await api.steamConnect(k); }
            catch (e) {
              if (e.message !== 'NEED_PROFILE') { toast(e.message, true); return; }
              const prof = await osk('Your Steam profile link', '', 'steamcommunity.com/id/yourname');
              if (!prof) return;
              try { r = await api.steamConnect(k, prof); } catch (e2) { toast(e2.message, true); return; }
            }
            ok = true;
            toast('Steam connected as ' + r.name);
            closeLayer(layer);
          }
        },
        onBack: () => closeLayer(layer),
        onClose: () => resolve(ok),
        prompts: () => [['A', 'Select'], ['B', 'Cancel']]
      });
    });
  }

  function connectArt() {
    return new Promise((resolve) => {
      let ok = false;
      const layer = openLayer({
        html: '<div class="dialog confirm xbox-connect"><h2>Find game art automatically</h2>' +
          '<ol class="steps"><li>Choose <b>Get a key</b> and sign in to SteamGridDB (you can use your Steam account).</li>' +
          '<li>Generate and copy your <b>API key</b>.</li>' +
          '<li>Come back, choose <b>Paste key</b> and press Ctrl+V.</li></ol>' +
          '<p class="hint">SteamGridDB is a free community library of game art. Games that already have art keep it; only missing art is filled in.</p>' +
          '<div class="dialog-foot"><button class="btn big" data-nav data-key="a-cancel" data-act="cancel">Cancel</button>' +
          '<button class="btn big" data-nav data-key="a-site" data-act="site">' + icon('link') + 'Get a key</button>' +
          '<button class="btn big primary" data-nav data-key="a-key" data-act="key">' + icon('key') + 'Paste key</button></div></div>',
        focus: 'a-site',
        onActivate: async (el) => {
          const act = el.dataset.act;
          if (act === 'cancel') return closeLayer(layer);
          if (act === 'site') { try { await api.openArtKeyPage(); } catch (e) { toast(e.message, true); } return; }
          if (act === 'key') {
            const k = await osk('Paste your SteamGridDB API key', '', 'Press Ctrl+V');
            if (!k) return;
            toast('Checking your key…');
            try { await api.artConnect(k); ok = true; S.artOn = true; toast('Connected to SteamGridDB'); closeLayer(layer); }
            catch (e) { toast(e.message, true); }
          }
        },
        onBack: () => closeLayer(layer),
        onClose: () => resolve(ok),
        prompts: () => [['A', 'Select'], ['B', 'Cancel']]
      });
    });
  }
  async function ensureArtKey() {
    try { S.artOn = await api.artStatus(); } catch (_) { S.artOn = false; }
    return S.artOn || connectArt();
  }
  // Fills in missing tiles and backgrounds for the whole library, one game at a time.
  async function autoArt(loud) {
    if (OVERLAY || S.artRunning) return;
    try { S.artOn = await api.artStatus(); } catch (_) { S.artOn = false; }
    if (!S.artOn) return;
    const todo = games().filter((g) => (!g.art || !g.art.tile || !g.art.hero) && !g.artTried);
    if (!todo.length) { if (loud) toast('Every game already has art'); return; }
    S.artRunning = true;
    if (S.view === 'settings') refreshContent();
    if (loud) toast('Finding art for ' + todo.length + ' game' + (todo.length === 1 ? '' : 's') + '…');
    let found = 0;
    for (const g0 of todo) {
      try {
        // Applied inside the queue, so no save can run between the download and using it.
        await enqueue(async () => {
          const g = byId(g0.id);
          if (!g) return;
          const want = { tile: !(g.art && g.art.tile), hero: !(g.art && g.art.hero) };
          const r = await api.findArt(g.title, g.id, want);
          g.art = g.art || {};
          g.artEdited = Object.assign({}, g.artEdited);
          if (r.tile) { g.art.tile = r.tile; g.artEdited.tile = true; found++; }
          if (r.hero) { g.art.hero = r.hero; g.artEdited.hero = true; if (!r.tile) found++; }
          g.artTried = Date.now();
          await api.save(S.lib);
        });
      } catch (e) {
        const g = byId(g0.id);
        if (g) g.artTried = Date.now();
        if (/key|reach|busy/i.test(e.message)) { toast(e.message, true); break; }
      }
    }
    S.artRunning = false;
    save();
    if (!layers.length) rerenderKeepFocus();
    if (loud || found) toast(found ? 'Added art for ' + found + ' game' + (found === 1 ? '' : 's') : 'No new art found');
  }

  async function refreshXbox(silent) {
    try {
      if (!(await api.xboxStatus())) { if (S.lib.settings.xbox) { S.lib.settings.xbox = null; save(); renderTop(); } return; }
      const p = await api.xboxProfile();
      S.lib.settings.xbox = p;
      save(); renderTop();
      if (!silent) toast('Xbox profile updated');
    } catch (e) { if (!silent) toast(e.message, true); }
  }

  // Friends: a panel that slides in from the right, refreshed every minute while open.
  async function openFriends() {
    let timer = null;
    let fr = null;
    const layer = openLayer({
      className: 'side-layer',
      html: '<aside class="friends"><div class="fr-head"><h2>Friends</h2><div class="fr-sub">Loading…</div></div><div class="flist"></div></aside>',
      onActivate: async (el) => {
        if (el.dataset.act === 'connect') { if (await connectXbox()) load(); }
        if (el.dataset.act === 'connect-steam') { if (await connectSteam()) load(); }
      },
      onBack: () => closeLayer(layer),
      onButton: (b) => { if (b === 'X') { load(); return true; } return false; },
      onClose: () => clearInterval(timer),
      prompts: () => [['X', 'Refresh'], ['B', 'Close']]
    });
    const list = $('.flist', layer.el), subEl = $('.fr-sub', layer.el);
    async function load() {
      const next = await loadAllFriends();
      if (layers.indexOf(layer) < 0) return;
      fr = next;
      const keep = layer.focusKey;
      subEl.textContent = friendSummary(fr);
      list.innerHTML = friendSectionsHTML(fr);
      const el = (keep && $('[data-key="' + cssEsc(keep) + '"]', list)) || $('[data-nav]', list);
      if (el && topLayer() === layer) setFocus(el, { instant: true });
    }
    load();
    timer = setInterval(load, 60000);
  }


  // ---------------------------------------------------------------- updates
  let updateBusy = false;
  async function checkForUpdate(silent, found) {
    if (updateBusy) return;
    updateBusy = true;
    try {
      const r = found || await api.checkUpdate();
      if (r.status !== 'ready' && r.offline) { if (!silent) toast('Couldn’t check online: ' + r.offline, true); return; }
      if (r.status === 'none') { if (!silent) toast('No updates yet'); return; }
      if (r.status === 'current') { if (!silent) toast('You’re up to date (version ' + r.version + ')'); return; }
      const ok = await confirmBox('New version available · ' + r.version, (r.notes ? r.notes + ' ' : '') + 'Update now? The launcher restarts by itself; it only takes a few seconds.', 'Update now', false, { cancelLabel: 'Later', focusOk: true });
      if (!ok) return;
      toast('Installing update…');
      clearTimeout(saveTimer);
      await enqueue(() => api.save(S.lib));
      await api.installUpdate();
    } catch (e) {
      toast(e.message, true);
    } finally {
      updateBusy = false;
    }
  }

  // Discord pins: copy a link in Discord (right-click a channel, voice channel or server ›
  // Copy Link, or an invite link), then paste it here.
  async function discordPins() {
    const pins = S.lib.settings.discordPins = S.lib.settings.discordPins || [];
    const pick = await openMenu('Discord pins', [{ id: 'add', label: 'Paste a copied Discord link', icon: 'plus' }]
      .concat(pins.map((p, i) => ({ id: 'rm' + i, label: 'Remove “' + p.name + '”', icon: 'trash', danger: true }))));
    if (!pick) return;
    if (pick.startsWith('rm')) { pins.splice(Number(pick.slice(2)), 1); save(); toast('Removed'); return; }
    let url = '';
    try { url = await api.discordClipboard(); } catch (_) { /* empty */ }
    let kind;
    try { kind = await api.discordCheck(url); }
    catch (_) {
      await confirmBox('Copy a link in Discord first', 'In Discord, right-click a text channel, voice channel or server and choose Copy Link (or copy an invite link). Then come back and choose Paste again.', 'OK');
      return;
    }
    const name = await osk('Name this pin', kind === 'invite' ? 'Invite' : kind === 'server' ? 'Server' : 'Channel', 'like Squad voice');
    if (!name || !name.trim()) return;
    pins.push({ name: name.trim().slice(0, 40), url, kind });
    save();
    toast('Pinned ' + name.trim());
  }

  async function storesMenu() {
    const pick = await openMenu('Stores', [
      { id: 'steam', label: 'Steam Store (Big Picture)', icon: 'store' },
      { id: 'xbox', label: 'Xbox app (Game Pass)', icon: 'store' },
      { id: 'msstore', label: 'Microsoft Store', icon: 'store' },
      { id: 'epic', label: 'Epic Games Store', icon: 'store' }
    ]);
    if (!pick) return;
    try { await api.openStore(pick); toast('Opening ' + { steam: 'the Steam Store', xbox: 'the Xbox app', msstore: 'the Microsoft Store', epic: 'the Epic Games Store' }[pick]); }
    catch (e) { toast(e.message, true); }
  }

  async function powerMenu() {
    const pick = await openMenu('Power', [
      { id: 'settings', label: 'Settings', icon: 'gear' },
      { id: 'rescan', label: 'Rescan games', icon: 'refresh' },
      { id: 'exit', label: 'Exit to desktop', icon: 'exit' },
      { id: 'sleep', label: 'Sleep', icon: 'moon' },
      { id: 'restart', label: 'Restart PC', icon: 'restart' },
      { id: 'shutdown', label: 'Shut down PC', icon: 'power', danger: true }
    ]);
    if (!pick) return;
    if (pick === 'settings') return go('settings');
    if (pick === 'rescan') return rescan(null, false);
    return power(pick);
  }
  async function power(action) {
    if (action === 'restart' && !(await confirmBox('Restart the PC?', 'Anything unsaved in other programs will be lost.', 'Restart', true))) return;
    if (action === 'shutdown' && !(await confirmBox('Shut down the PC?', 'Anything unsaved in other programs will be lost.', 'Shut down', true))) return;
    try {
      clearTimeout(saveTimer);
      await enqueue(() => api.save(S.lib));
      await api.power(action);
    } catch (e) { toast(e.message, true); }
  }

  // ---------------------------------------------------------------- activation (A / Enter / click)
  async function activate(el) {
    if (!el) return;
    const top = topLayer();
    if (top) { if (top.onActivate) top.onActivate(el); return; }
    const a = el.dataset.action;
    const s = S.lib.settings;
    switch (a) {
      case 'play': return play(el.dataset.game);
      case 'nav': {
        const to = el.dataset.to;
        if (to === 'add') return openEdit(null);
        if (to === 'friends') return openFriends();
        if (to === 'search') { if (S.view !== 'library') go('library', 's-search'); return searchPrompt(); }
        return go(to);
      }
      case 'add': return openEdit(null);
      case 'profile': return openProfile();
      case 'stores': return storesMenu();
      case 'coop': S.libFilter = 'coop'; return go('library', 'f-coop');
      case 'go-settings': S.setTab = el.dataset.tab || 'platforms'; return go('settings', 't-' + S.setTab);
      case 'filter': S.libFilter = el.dataset.f; refreshContent(); $('#content').scrollTop = 0; { const first = $('#content .grid [data-nav]'); if (first) setFocus(first); } return;
      case 'sort': S.libSort = el.dataset.s; return refreshContent();
      case 'search': return searchPrompt();
      case 'clear-search': S.libSearch = ''; S.baseFocus = 's-search'; return refreshContent();
      case 'tab': S.setTab = el.dataset.tab; refreshContent(); { const first = $('#content [data-nav]'); if (first) setFocus(first); } return;
      case 'rescan': return rescan(el.dataset.src || null, false);
      case 'plat-toggle': { const p = S.lib.platforms[el.dataset.src] = S.lib.platforms[el.dataset.src] || { enabled: true }; p.enabled = !(p.enabled !== false); save(); refreshContent(); return rescan(el.dataset.src, true); }
      case 'plat-exe': {
        const src = el.dataset.src;
        const e = S.info.emulators[src];
        let p = await browse({ title: 'Find the ' + e.name + ' program', exts: ['.exe', '.ps1', '.bat', '.cmd'], hint: 'Pick ' + (src === 'dolphin' ? 'Dolphin.exe' : src === 'rpcs3' ? 'rpcs3.exe' : 'Ryujinx.exe') + ', or an EmuDeck .ps1 launcher' });
        if (!p) return;
        if (/\.(ps1|bat|cmd)$/i.test(p)) {
          try { p = await api.exeFromScript(p); toast('Using ' + baseName(p) + ' from that script'); }
          catch (err) { toast(err.message, true); return; }
        }
        S.lib.platforms[src].exe = p;
        save(); refreshContent();
        return rescan(src, false);
      }
      case 'plat-dir': {
        const src = el.dataset.src;
        const e = S.info.emulators[src];
        const p = await browse({ title: 'Choose your ' + e.system + ' games folder', folder: true, hint: 'Subfolders are included' });
        if (!p) return;
        S.lib.platforms[src].dir = p;
        save(); refreshContent();
        if (S.lib.platforms[src].exe) return rescan(src, false);
        toast('Now set the ' + e.name + ' program');
        return;
      }
      case 'theme': s.theme = el.dataset.id; s.accent = null; return themeChanged();
      case 'corners': s.corners = el.dataset.id; return themeChanged();
      case 'accent': s.accent = el.dataset.c || null; return themeChanged();
      case 'set-toggle': s[el.dataset.k] = !s[el.dataset.k]; if (el.dataset.k === 'useArtBackground') currentBg = undefined; return themeChanged();
      case 'autostart': {
        const want = !s.autostart;
        try { const real = await api.setAutostart(want); s.autostart = want; if (S.info.platform === 'win32' && real !== want) toast('Windows didn’t accept the change', true); }
        catch (e) { toast(e.message, true); }
        save(); return refreshContent();
      }
      case 'rename': { const v = await osk('Your name', s.userName || '', 'Name'); if (v) { s.userName = v; save(); renderTop(); refreshContent(); } return; }
      case 'power': return power(el.dataset.p);
      case 'update-check': return checkForUpdate(false);
      case 'accent-custom': {
        const hex = await colorWheel(s.accent || (S.theme && S.theme.accent));
        if (!hex) return;
        s.accent = hex;
        return themeChanged();
      }
      case 'bg-pick': {
        const p = await browse({ title: 'Choose a Home background', exts: ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'] });
        if (!p) return;
        try { s.customBg = await enqueue(() => api.importArt(p, 'profile', 'background')); } catch (e) { toast(e.message, true); return; }
        currentBg = undefined;
        save(); refreshContent(); toast('Background set');
        return;
      }
      case 'bg-clear': s.customBg = null; currentBg = undefined; save(); refreshContent(); return;
      case 'emu-open': try { await api.openEmulator(el.dataset.src); toast('Opening ' + S.info.emulators[el.dataset.src].name + '. Set up controllers there, then close it.'); } catch (e) { toast(e.message, true); } return;
      case 'art-on': if (await connectArt()) { refreshContent(); autoArt(false); } return;
      case 'art-off': try { await api.artDisconnect(); } catch (_) { /* ignore */ } S.artOn = false; return refreshContent();
      case 'art-find': for (const g of games()) delete g.artTried; return autoArt(false);
      case 'display': {
        s.displayId = el.dataset.id;
        save();
        try { await api.setDisplay(el.dataset.id); } catch (e) { toast(e.message, true); }
        await wait(500); // let the window settle on the new monitor
        try { S.displays = await api.listDisplays(); } catch (_) { /* keep the old list */ }
        return refreshContent();
      }
      case 'emudeck': {
        let d;
        try { d = await api.detectEmuDeck(); } catch (err) { toast(err.message, true); return; }
        const found = [];
        for (const id of ['dolphin', 'rpcs3', 'ryujinx']) {
          const r = d[id] || {};
          const P = S.lib.platforms[id];
          if (r.exe) P.exe = r.exe;
          if (r.dirs && r.dirs.length) P.dir = r.dirs.join(';');
          if (r.exe || (r.dirs && r.dirs.length)) found.push(S.info.emulators[id].name + (r.exe ? '' : ' (games only)'));
        }
        save(); refreshContent();
        if (!found.length) { toast('Couldn’t find an EmuDeck setup. Set each emulator by hand, or pick its .ps1 launcher.', true); return; }
        toast('Found ' + found.join(', '));
        return rescan(null, false);
      }
      default: return;
    }
  }
  async function searchPrompt() {
    const v = await osk('Search your games', S.libSearch, 'Game name');
    if (v === null) return;
    S.libSearch = v;
    S.baseFocus = 's-search';
    if (S.view !== 'library') go('library', 's-search'); else refreshContent();
    const first = $('#content .grid [data-nav]');
    if (first && v) setFocus(first);
  }
  function themeChanged() {
    S.theme = window.applyTheme(S.lib.settings, true);
    save();
    // Tiles use theme colors, so redraw the current screen in place.
    const key = S.baseFocus;
    refreshContent();
    renderTop();
    if (key) { const el = $('[data-key="' + cssEsc(key) + '"]', $('#app')); if (el) setFocus(el, { instant: true, noScroll: true }); }
  }

  // ---------------------------------------------------------------- buttons: shared by controller and keyboard
  function button(b) {
    const top = topLayer();
    if (top && top.onButton && top.onButton(b)) return;
    const el = currentFocus();
    switch (b) {
      case 'A': return activate(el);
      case 'B':
        if (top) return top.onBack ? top.onBack() : closeLayer(top);
        if (S.view !== 'home') return go('home');
        return;
      case 'Y':
        if (!top && el && el.dataset.game) { const g = byId(el.dataset.game); if (g) openEdit(g); }
        return;
      case 'MENU':
        if (top) return;
        if (el && el.dataset.game) { const g = byId(el.dataset.game); if (g) gameMenu(g); return; }
        return powerMenu();
      case 'LB': case 'RB': {
        if (top) return;
        const order = ['home', 'library', 'settings'];
        const i = order.indexOf(S.view);
        const n = b === 'LB' ? Math.max(0, i - 1) : Math.min(order.length - 1, i + 1);
        if (n !== i) go(order[n]);
        return;
      }
      case 'LT': return page('up');
      case 'RT': return page('down');
      case 'HOME': toggleGuide(!!S.playing); return;
      default: return;
    }
  }

  // ---------------------------------------------------------------- controller input
  const PADMAP = { 0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT', 8: 'VIEW', 9: 'MENU', 16: 'HOME' };
  const DIRS = { 12: 'up', 13: 'down', 14: 'left', 15: 'right' };
  const prevButtons = new Set();
  const held = { dir: null, since: 0, next: 0, count: 0 };
  let suppressUntilRelease = true; // ignore buttons already held when the app starts / regains focus

  function setInput(kind, padId) {
    const changed = S.input !== kind || (padId && padKind(padId) !== S.glyphs);
    S.input = kind;
    if (padId) S.glyphs = padKind(padId);
    document.body.classList.toggle('hide-cursor', kind !== 'mouse');
    if (changed) updatePrompts();
  }

  function pollPads(now) {
    requestAnimationFrame(pollPads);
    if (!document.hasFocus()) { prevButtons.clear(); held.dir = null; suppressUntilRelease = true; return; }
    let pads;
    try { pads = navigator.getGamepads(); } catch (_) { return; }
    const down = new Set();
    let dir = null, dirMag = 0, activePad = null;
    for (const p of pads) {
      if (!p || !p.connected) continue;
      for (let i = 0; i < p.buttons.length; i++) {
        const bt = p.buttons[i];
        const on = bt && (bt.pressed || bt.value > 0.5);
        if (!on) continue;
        if (PADMAP[i]) { down.add(PADMAP[i]); activePad = p; }
        if (DIRS[i]) { dir = DIRS[i]; dirMag = 1; activePad = p; }
      }
      const ax = p.axes[0] || 0, ay = p.axes[1] || 0;
      const mag = Math.max(Math.abs(ax), Math.abs(ay));
      if (mag > 0.55 && mag > dirMag) {
        dir = Math.abs(ax) > Math.abs(ay) ? (ax > 0 ? 'right' : 'left') : (ay > 0 ? 'down' : 'up');
        dirMag = mag; activePad = p;
      }
    }
    if (suppressUntilRelease) {
      if (!down.size && !dir) suppressUntilRelease = false;
      prevButtons.clear(); for (const b of down) prevButtons.add(b);
      return;
    }
    if (activePad) setInput('pad', activePad.id);
    for (const b of down) if (!prevButtons.has(b)) button(b);
    prevButtons.clear(); for (const b of down) prevButtons.add(b);

    // Held directions repeat, starting slow and speeding up the longer you hold.
    if (dir) {
      if (held.dir !== dir) { held.dir = dir; held.since = now; held.count = 0; held.next = now + 380; move(dir); }
      else if (now >= held.next) {
        held.count++;
        move(dir);
        const t = now - held.since;
        held.next = now + Math.max(55, 150 - t / 12);
      }
    } else held.dir = null;
  }

  // ---------------------------------------------------------------- keyboard & mouse
  const KEYMAP = { Enter: 'A', ' ': 'A', Escape: 'B', Backspace: 'B', y: 'Y', Y: 'Y', F2: 'Y', m: 'MENU', M: 'MENU', ContextMenu: 'MENU', q: 'LB', Q: 'LB', e: 'RB', E: 'RB', PageUp: 'LT', PageDown: 'RT', Delete: 'X', Home: 'HOME' };
  const KEYDIRS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const top = topLayer();
    const typing = e.target && e.target.tagName === 'INPUT';
    setInput('key');
    if (top && top.onKey && top.onKey(e)) { e.preventDefault(); return; }
    if (KEYDIRS[e.key]) { e.preventDefault(); move(KEYDIRS[e.key]); return; }
    if (typing) return; // letters, space, backspace go into the text box
    if (e.key === 'Tab') { e.preventDefault(); move(e.shiftKey ? 'up' : 'down'); return; }
    const b = KEYMAP[e.key];
    if (b) { e.preventDefault(); if (!e.repeat) button(b); }
  });
  let mouseTimer = null;
  let lastMouse = null;
  document.addEventListener('mousemove', (e) => {
    // Menus opening under a still cursor also fire mouse events: only real movement counts.
    const p = [e.screenX, e.screenY];
    const moved = lastMouse && (Math.abs(p[0] - lastMouse[0]) + Math.abs(p[1] - lastMouse[1]) > 6);
    if (!lastMouse || moved) lastMouse = p;
    if (!moved) return;
    setInput('mouse');
    clearTimeout(mouseTimer);
    mouseTimer = setTimeout(() => document.body.classList.add('hide-cursor'), 3000);
  });
  document.addEventListener('mouseover', (e) => {
    if (S.input !== 'mouse') return;
    const el = e.target.closest && e.target.closest('[data-nav]');
    if (el && scope().contains(el) && !el.classList.contains('focused') && visible(el)) setFocus(el, { noScroll: true });
  });
  document.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest('[data-nav]');
    if (!el || !scope().contains(el)) {
      const top = topLayer();
      if (top && e.target === top.el && top.className !== 'launching') button('B');
      return;
    }
    e.preventDefault();
    setFocus(el, { noScroll: true });
    activate(el);
  });
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const el = e.target.closest && e.target.closest('[data-nav]');
    if (el && scope().contains(el)) setFocus(el, { noScroll: true });
    button('MENU');
  });
  // Mouse wheel moves rows sideways on Home
  document.addEventListener('wheel', (e) => {
    const row = e.target.closest && e.target.closest('.row');
    if (row && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { row.scrollBy({ left: e.deltaY, behavior: reduce() ? 'auto' : 'smooth' }); }
  }, { passive: true });

  // ---------------------------------------------------------------- events from the app core
  api.on('game:exited', (p) => backFromGame(p));
  api.on('remote', async (r) => {
    if (OVERLAY || !r) return;
    S.noGuideUntil = Date.now() + 2500; // coming forward for this request, not to show the guide
    for (const l of layers.slice().reverse()) if (l.isGuide || l.className === 'launching') closeLayer(l);
    if (r.action === 'switch' && r.id) return switchTo(r.id);
    if (r.action === 'close') {
      const cur = S.playing && byId(S.playing.id);
      if (await confirmBox('Close ' + (cur ? cur.title : 'the game') + '?', 'It will be closed the normal way, like pressing its X. Save first if the game doesn’t save on its own.', 'Close game', true)) await closeCurrentGame();
      return;
    }
    const t = r.target;
    if (t === 'home') return go('home', S.playing ? 'h-' + S.playing.id : null);
    if (t === 'dc-add') return discordPins();
    if (t === 'library') return go('library');
    if (t === 'add') return openEdit(null);
    if (t === 'profile') return openProfile();
    if (t === 'power') return powerMenu();
    if (t === 'connect') return connectXbox();
    if (t === 'themes') { S.setTab = 'themes'; return go('settings', 't-themes'); }
    if (t === 'platforms') { S.setTab = 'platforms'; return go('settings', 'p-all'); }
    if (t === 'settings') { S.setTab = 'platforms'; return go('settings', 't-platforms'); }
  });
  api.on('launch:cancelled', () => {
    for (const l of layers.slice().reverse()) if (l.className === 'launching') closeLayer(l);
    S.playing = null;
    toast('Cancelled');
  });
  api.on('game:started', (p) => { if (S.playing && p && S.playing.id === p.gameId) S.playing.started = true; });
  api.on('update:found', (r) => { if (!S.playing) checkForUpdate(true, r); });
  api.on('overlay', () => { suppressUntilRelease = true; setInput('pad'); openGuide({ fromGame: true }); });
  api.on('guide', () => { suppressUntilRelease = true; setInput('pad'); toggleGuide(!!S.playing); });
  api.on('window:focus', () => {
    suppressUntilRelease = true;
    // Came back to the launcher while a game is still going (Alt+Tab, store games): show the guide.
    setTimeout(() => {
      if (!OVERLAY && S.playing && S.playing.started && !S.switching && Date.now() > (S.noGuideUntil || 0) && document.hasFocus() && !layers.some((l) => l.isGuide)) openGuide({ fromGame: true });
    }, 450);
  });
  window.addEventListener('gamepadconnected', (e) => { tickClock(); toast('Controller connected' + (padCount() > 1 ? ' · Player ' + (e.gamepad.index + 1) : '')); if (S.view === 'settings' && S.setTab === 'controllers' && !layers.length) refreshContent(); });
  window.addEventListener('gamepaddisconnected', () => { tickClock(); toast('Controller disconnected'); if (S.view === 'settings' && S.setTab === 'controllers' && !layers.length) refreshContent(); });

  // ---------------------------------------------------------------- start
  async function initOverlay() {
    document.documentElement.classList.add('overlay-mode');
    try { S.info = await api.info(); } catch (_) { /* defaults */ }
    S.lib = await api.load();
    S.theme = window.applyTheme(S.lib.settings, false);
    requestAnimationFrame(pollPads);
    api.on('overlay:open', async (p) => {
      try { S.lib = await api.load(); S.theme = window.applyTheme(S.lib.settings, false); } catch (_) { /* keep last */ }
      for (const l of layers.slice()) { l.el.remove(); layers.splice(layers.indexOf(l), 1); }
      S.playing = p && p.gameId ? { id: p.gameId, tracked: true, started: true, at: 0 } : null;
      suppressUntilRelease = true;
      setInput('pad');
      lastMouse = null;
      openGuide({ fromGame: true });
    });
    api.on('overlay:closed', () => { for (const l of layers.slice()) { l.el.remove(); layers.splice(layers.indexOf(l), 1); } updatePrompts(); });
  }

  async function init() {
    if (OVERLAY) return initOverlay();
    try { S.info = await api.info(); } catch (_) { /* defaults */ }
    S.lib = await api.load();
    if (typeof S.info.autostart === 'boolean') S.lib.settings.autostart = S.info.autostart;
    S.theme = window.applyTheme(S.lib.settings, false);
    renderView(false);
    requestAnimationFrame(pollPads);
    setInterval(tickClock, 10000);
    setTimeout(() => rescan(null, true), 400);
    if (S.info.updateFailed) toast('The last update couldn’t start, so the previous version is running. Details: ' + S.info.updateFailed, true);
    // Xbox profile: on start, then every 10 minutes.
    setTimeout(() => refreshXbox(true), 1500);
    // Keep the Steam name / picture / level fresh when that's the profile shown.
    const refreshSteamMe = async () => { if (S.lib.settings.profileFrom !== 'steam' || OVERLAY) return; try { S.lib.settings.steamProfile = await api.steamMe(); save(); renderTop(); } catch (_) { /* keep last */ } };
    setTimeout(refreshSteamMe, 2500);
    setInterval(refreshSteamMe, 600000);
    setInterval(() => refreshXbox(true), 600000);
  }
  window.__couch = { S, move, button, setFocus, currentFocus, layers }; // used by tests
  init().catch((e) => { document.body.innerHTML = '<pre style="color:#fff;padding:40px;font-size:18px">Couch Launcher couldn’t start:\n' + esc(e && e.stack || e) + '</pre>'; });
})();
