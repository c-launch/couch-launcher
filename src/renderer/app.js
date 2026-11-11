'use strict';
/* Couch Launcher interface: views, controller navigation, dialogs. */
(function () {
  const api = window.launcher;
  // The same page also runs as the see-through guide that floats over a game.
  const OVERLAY = /[?&]overlay=1/.test(location.search);
  // ...and as Couch TV: Movies & TV on its own, in a normal window, with its settings built in
  // (no games, no Home, no guide). Couch TV's app core answers only what these screens ask.
  const TVAPP = !OVERLAY && /[?&]tvapp=1/.test(location.search);
  if (TVAPP) document.documentElement.classList.add('tvapp');
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

  const IS_MAC = /Mac/i.test(navigator.platform || '') || /Macintosh/.test(navigator.userAgent || '');
  const PCW = IS_MAC ? 'Mac' : 'PC'; // for "on this PC" / "on this Mac"
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
    back: '<path d="M15 18l-6-6 6-6"/>',
    expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M5 12v8h14v-8M12 8v12M12 8S10.5 3.5 8 4.5 9 8 12 8zm0 0s1.5-4.5 4-3.5S15 8 12 8z"/>',
    tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5M4 20h16"/>',
    speaker: '<rect x="6" y="3" width="12" height="18" rx="2"/><circle cx="12" cy="14" r="3"/><circle cx="12" cy="7.5" r="1"/>',
    playc: '<circle cx="12" cy="12" r="9.5"/><path d="M10 8.6v6.8l5.4-3.4z"/>',
    tv: '<rect x="2.5" y="6" width="19" height="13" rx="2.5"/><path d="M8 2.5l4 3.5 4-3.5"/>',
    home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
    plug: '<path d="M9 2v6M15 2v6M7 8h10v4a5 5 0 0 1-10 0zM12 17v5"/>',
    level: '<circle cx="12" cy="12" r="9"/><path d="M8 14l4-4 4 4"/>',
    store: '<path d="M4 8h16l-1 12H5z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
    pad: '<path d="M6 12h4M8 10v4"/><circle cx="15" cy="11" r="1"/><circle cx="17" cy="13" r="1"/><path d="M7 6h10a5 5 0 0 1 4.9 6l-1 5a2.5 2.5 0 0 1-4.4 1L15 16H9l-1.5 2a2.5 2.5 0 0 1-4.4-1l-1-5A5 5 0 0 1 7 6z"/>',
    star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
    play: '<path d="M7 4l13 8-13 8z"/>',
    film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
    news: '<path d="M4 5h13v14H6a2 2 0 0 1-2-2zM17 9h3v8a2 2 0 0 1-2 2"/><path d="M7 9h7M7 13h7M7 16h4"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
    pin: '<path d="M9 4h6l-1 6 4 4H6l4-4z"/><path d="M12 14v7"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2a5 5 0 0 1 6 4.8"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    chat: '<path d="M4 5h16v11H9l-5 4z"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    micoff: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M3 3l18 18"/>',
    deaf: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/><path d="M3 3l18 18"/>',
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
    shield: '<path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
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
    monitor: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>',
    gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'
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
    return el;
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
  // ---- Gaming news (under Home): headlines from gaming sites, refreshed every couple of hours.
  S.news = null; S.newsErr = null;
  const ago = (t) => { if (!t) return ''; const m = Math.round((Date.now() - t) / 60000); return m < 60 ? Math.max(1, m) + ' min ago' : m < 1440 ? Math.round(m / 60) + ' hr ago' : Math.round(m / 1440) + ' d ago'; };
  function newsSub() {
    if (S.newsErr && !S.news) return 'Couldn’t reach news sites';
    if (!S.news) return 'Loading…';
    return 'Updated ' + ago(S.news.at) + ' · ' + S.news.items.length + ' stories';
  }
  function newsCardsHTML() {
    const items = (S.news && S.news.items) || [];
    if (!items.length) return '<p class="hint news-empty">' + (S.newsErr ? 'No news right now: the launcher tries again in a little while.' : 'Loading the latest gaming news…') + '</p>';
    // Magazine layout: a big lead story, some wide ones, the rest regular (only stories with a
    // picture get the bigger cards).
    const size = (it, i) => (!it.image ? '' : i % 9 === 0 ? ' big' : (i % 9 === 4 || i % 9 === 7) ? ' wide' : '');
    return items.slice(0, 36).map((it, i) => '<button class="ncard' + size(it, i) + '" data-nav data-key="n-' + i + '" data-zone="news" data-action="news" data-i="' + i + '">' +
      (it.image ? '<span class="nimg" style="background-image:url(&quot;' + esc(it.image) + '&quot;)"></span>' : '<span class="nimg none">' + icon('news') + '</span>') +
      '<span class="nbody"><span class="nmeta">' + esc(it.source) + (it.at ? ' · ' + ago(it.at) : '') + '</span><span class="ntitle">' + esc(it.title) + '</span></span></button>').join('');
  }
  function paintNews() {
    const list = $('#news-list'), sub = $('#news-sub');
    if (sub) sub.textContent = newsSub();
    if (!list || S.view !== 'home') return;
    const f = currentFocus(), key = f && f.closest('.home-news') ? f.dataset.key : null;
    list.innerHTML = newsCardsHTML();
    if (key) { const el = $('[data-key="' + cssEsc(key) + '"]', list) || $('[data-nav]', list); if (el) setFocus(el, { instant: true }); }
  }
  function openNews(it) {
    const layer = openLayer({
      html: '<div class="dialog news-read">' + (it.image ? '<div class="nr-img" style="background-image:url(&quot;' + esc(it.image) + '&quot;)"></div>' : '') +
        '<div class="nr-meta">' + esc(it.source) + (it.at ? ' · ' + ago(it.at) : '') + '</div><h2>' + esc(it.title) + '</h2>' +
        (it.summary ? '<p class="nr-sum">' + esc(it.summary) + '</p>' : '') +
        '<div class="dialog-foot"><button class="btn big" data-nav data-key="nr-close" data-act="close">Close</button>' +
        '<button class="btn big primary" data-nav data-key="nr-open" data-act="open">' + icon('link') + 'Read full article</button></div></div>',
      focus: 'nr-open',
      onActivate: async (el) => {
        if (el.dataset.act === 'close') return closeLayer(layer);
        try { await api.newsOpen(it.link); closeLayer(layer); } catch (e) { toast(e.message, true); }
      },
      onBack: () => closeLayer(layer),
      prompts: () => [['A', 'Select'], ['B', 'Back']]
    });
  }
  (async () => { if (OVERLAY || TVAPP) return; try { S.news = await api.news(false); S.newsErr = null; } catch (e) { S.newsErr = e.message; } paintNews(); })();

  // ----- Free games and deals (Home)
  const money = (n) => '$' + Number(n).toFixed(2);
  const shortDay = (t) => new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  // Free now, free soon, the games you watch, then the best deals.
  function dealItems() {
    const v = S.deals;
    if (!v) return [];
    const rank = (x) => (x.owned ? 2 : x.upcoming ? 1 : 0); // free now, free soon, ones you have
    const free = (v.free || []).slice().sort((a, b) => rank(a) - rank(b));
    const watching = (v.watch || []).map((w) => ({ id: 'w:' + w.gameID, kind: 'watch', gameID: w.gameID, title: w.title, image: w.image, store: (w.now && w.now.store) || w.store, price: w.now ? w.now.price : w.price, normal: w.now ? w.now.normal : null, best: w.best, was: w.price }));
    const watched = new Set(watching.map((w) => w.gameID));
    return [].concat(free, watching, (v.deals || []).filter((d) => !watched.has(d.gameID))).slice(0, 24);
  }
  function dealCardHTML(x, i) {
    let tag, sub;
    if (x.kind === 'free') {
      tag = x.owned ? '<span class="dl-tag have">In your library</span>' : x.upcoming ? '<span class="dl-tag soon">Free ' + esc(shortDay(x.from)) + '</span>' : '<span class="dl-tag free">Free</span>';
      sub = x.upcoming || x.owned || !x.until ? x.store : x.store + ' · until ' + shortDay(x.until);
    } else if (x.kind === 'watch') {
      tag = '<span class="dl-tag watch">' + icon('eye') + 'Watching</span>';
      sub = money(x.price) + ' at ' + x.store + (x.normal && x.normal > x.price ? ' · was ' + money(x.normal) : '');
    } else {
      tag = '<span class="dl-tag off">−' + x.savings + '%</span>' + (x.watched ? '<span class="dl-tag watch">' + icon('eye') + '</span>' : '');
      sub = '';
    }
    const price = x.kind === 'deal' ? '<span class="dl-price"><b>' + money(x.price) + '</b><s>' + money(x.normal) + '</s> · ' + esc(x.store) + '</span>' : '<span class="dl-sub">' + esc(sub) + '</span>';
    return '<button class="dl-card' + (x.upcoming ? ' soon' : '') + '" data-nav data-key="dl-' + esc(x.id) + '" data-zone="deals" data-action="deal" data-i="' + i + '">' +
      '<span class="dl-img">' + icon(x.kind === 'free' ? 'gift' : 'store') + (x.image ? '<img src="' + esc(x.image) + '" alt="" decoding="async">' : '') + '<span class="dl-tags">' + tag + '</span></span>' +
      '<span class="dl-t"><span class="dl-name">' + esc(x.title) + '</span>' + price + '</span></button>';
  }
  function dealsHTML() {
    if (S.lib && S.lib.settings.showDeals === false) return '';
    const items = dealItems();
    if (!items.length) return '';
    const free = items.filter((x) => x.kind === 'free' && !x.upcoming && !x.owned).length;
    return '<div class="news-head hf-head">' + icon('gift') + '<h2>Free games &amp; deals</h2><span class="news-sub">' + (free ? free + ' free to keep right now · ' : '') + 'Prices in US$ from CheapShark</span></div>' +
      '<div class="hf-row"><div class="hf-inner">' + items.map(dealCardHTML).join('') + '</div></div>';
  }
  function paintDeals() {
    const hosts = $$('#home-deals'), host = hosts[hosts.length - 1];
    if (!host || S.view !== 'home') return;
    const html = dealsHTML();
    if (host.dataset.sig === html) return;
    host.dataset.sig = html;
    const f = currentFocus(), key = dealFocus || (f && f.closest('.home-deals') ? f.dataset.key : null);
    dealFocus = null;
    host.innerHTML = html;
    if (key) { const el = $('[data-key="' + cssEsc(key) + '"]', host) || $('[data-nav]', host) || $('[data-key="c-lib"]'); if (el) setFocus(el, { instant: true }); }
  }
  let dealsAt = 0, dealFocus = null;
  async function loadDeals(force) {
    if (OVERLAY || (S.lib && S.lib.settings.showDeals === false)) return;
    if (!force && S.deals && Date.now() - dealsAt < 10 * 60e3) { paintDeals(); return; }
    dealsAt = Date.now();
    try { S.deals = await api.deals(!!force); } catch (_) { /* offline: Home just doesn't show it */ }
    paintDeals();
  }
  async function dealMenu(x) {
    if (!x) return;
    const items = [];
    if (x.kind === 'free') items.push({ id: 'open', label: x.owned ? 'Open in ' + x.store : x.upcoming ? 'See it in ' + x.store : 'Get it free in ' + x.store, icon: 'gift' });
    else items.push({ id: 'open', label: 'Open at ' + x.store + ' · ' + money(x.price), icon: 'store' });
    if (x.kind === 'deal') items.push(x.watched ? { id: 'unwatch', label: 'Stop watching the price', icon: 'x' } : { id: 'watch', label: 'Watch the price (tells you when it drops)', icon: 'eye' });
    if (x.kind === 'watch') items.push({ id: 'unwatch', label: 'Stop watching the price', icon: 'x' });
    items.push({ id: 'hide', label: 'Hide free games & deals on Home', icon: 'x' });
    const head = x.kind === 'watch' ? x.title + ' · lowest so far ' + money(x.best) : x.kind === 'deal' ? x.title + ' · ' + money(x.price) + ' (−' + x.savings + '%)'
      : x.title + (x.upcoming ? ' · free ' + shortDay(x.from) + (x.until ? ' to ' + shortDay(x.until) : '') : x.until ? ' · free until ' + shortDay(x.until) : '') + (x.was ? ' · normally ' + x.was : '');
    const pick = await openMenu(head, items);
    try {
      if (pick === 'open') { await api.dealOpen(x.id); return; }
      if (pick === 'watch') { S.deals = await api.dealWatch(x.id); dealFocus = 'dl-w:' + x.gameID; toast('Watching ' + x.title + ': you’ll hear when it gets cheaper'); }
      if (pick === 'unwatch') { S.deals = await api.dealUnwatch(x.gameID); toast('Stopped watching ' + x.title); }
      if (pick === 'hide') { S.lib.settings.showDeals = false; save(); toast('Hidden. Turn it back on in Settings › Controllers'); const c = $('[data-key="c-lib"]'); if (c) setFocus(c); }
    } catch (e) { toast(e.message, true); }
    paintDeals();
  }

  // ---- Medal clips: the Clips page (dock), the guide's Clips tab, and the player.
  let clipsCache = null;
  async function loadClips(force) {
    if (clipsCache && !force && Date.now() - clipsCache.t < 30000) return clipsCache.v;
    const v = await api.clips();
    clipsCache = { t: Date.now(), v };
    return v;
  }
  const clipName = (c) => c.game + ' · ' + new Date(c.at).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + new Date(c.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  function clipThumbHTML(c) {
    return '<span class="cthumb">' + (c.kind === 'shot' ? '<img src="' + esc(fileUrl(c.file)) + '" alt="" loading="lazy">' : '<video muted preload="none" data-src="' + esc(fileUrl(c.file)) + '#t=1"></video><span class="cplay">' + icon('play') + '</span><span class="cdur"></span>') + '</span>';
  }
  // Videos load their first frame only when they scroll into view.
  function lazyThumbs(root, scroller) {
    const vids = $$('video[data-src]', root);
    if (!vids.length) return;
    const load = (v) => {
      if (v.src) return;
      v.preload = 'metadata';
      v.addEventListener('loadedmetadata', () => { const d = v.duration; const lab = v.parentElement && $('.cdur', v.parentElement); if (lab && isFinite(d)) lab.textContent = Math.floor(d / 60) + ':' + String(Math.round(d % 60)).padStart(2, '0'); }, { once: true });
      v.src = v.dataset.src;
    };
    if (!('IntersectionObserver' in window)) { vids.slice(0, 24).forEach(load); return; }
    const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { load(e.target); io.unobserve(e.target); } }, { root: scroller || null, rootMargin: '300px' });
    vids.forEach((v) => io.observe(v));
  }
  async function openClips() {
    let data = null, err = null, filter = 'all';
    const layer = openLayer({
      className: 'clips-layer',
      html: '<div class="clips"><div class="clips-head"><h1>' + icon('film') + 'Clips</h1><span class="clips-sub">Looking for your Medal clips…</span></div><div class="clips-main"></div></div>',
      onActivate: async (el) => {
        const act = el.dataset.act;
        if (act === 'filter') { filter = el.dataset.f; draw('cf-' + filter); return; }
        if (act === 'play') return openClipPlayer(shown(), Number(el.dataset.i), gone);
        if (act === 'folder') {
          const p = await browse({ title: 'Choose your Medal folder', folder: true });
          if (!p) return;
          S.lib.settings.clipsFolder = p; save(); clipsCache = null;
          setTimeout(load, 400); // after the setting reaches the app core
        }
      },
      onButton: (b) => {
        const el = currentFocus();
        if (b !== 'X' || !el || el.dataset.act !== 'play') return false;
        const i = Number(el.dataset.i), c = shown()[i];
        const v = $('video', el);
        if (c) deleteClip(c, () => { if (v && v.src) { v.removeAttribute('src'); v.load(); } }).then((ok) => { if (ok) { gone(c); const left = shown(); draw(left.length ? 'cl-' + Math.min(i, left.length - 1) : null); } });
        return true;
      },
      onBack: () => closeLayer(layer),
      prompts: (el) => (el && el.dataset.act === 'play' ? [['A', 'Play'], ['X', 'Delete'], ['B', 'Close']] : [['A', 'Select'], ['B', 'Close']])
    });
    const shown = () => ((data && data.clips) || []).filter((c) => filter === 'all' || (filter === 'shots' ? c.kind === 'shot' : c.game === filter));
    // A clip deleted here or in the player leaves the list (and the filter, when it was its last).
    function gone(c) {
      if (data) data.clips = data.clips.filter((x) => x.file !== c.file);
      if (filter !== 'all' && !shown().length) filter = 'all';
      if (layers.indexOf(layer) < 0) return;
      const onTop = layers[layers.length - 1] === layer;
      draw(layer.focusKey, !onTop); // under the player: redrawn without taking its focus
    }
    function draw(focusKey, noFocus) {
      const main = $('.clips-main', layer.el), sub = $('.clips-sub', layer.el);
      if (err || !data) { sub.textContent = err || 'Looking for your Medal clips…'; main.innerHTML = ''; return; }
      const all = data.clips;
      sub.textContent = data.folder ? data.folder + ' · ' + all.length + ' clip' + (all.length === 1 ? '' : 's') : 'Medal folder not found';
      if (!all.length) {
        main.innerHTML = '<div class="clips-empty"><p>' + (data.folder ? 'No clips in your Medal folder yet.' : 'Couldn’t find Medal’s clips folder.') + ' Medal saves clips in <b>C:\\Medal</b> unless you changed it in Medal’s settings (Capture Folder Location).</p>' +
          '<button class="btn big primary" data-nav data-key="cl-folder" data-act="folder">' + icon('folder') + 'Choose Medal folder</button></div>';
        setFocus($('[data-nav]', main), { instant: true });
        return;
      }
      const games = [...new Set(all.filter((c) => c.kind === 'clip').map((c) => c.game))];
      const shots = all.filter((c) => c.kind === 'shot').length;
      const side = [['all', 'All clips', all.length]].concat(games.map((g) => [g, g, all.filter((c) => c.game === g && c.kind === 'clip').length]), shots ? [['shots', 'Screenshots', shots]] : []);
      const list = shown();
      main.innerHTML = '<aside class="side">' + side.map(([k, l, n]) => '<button class="sideitem' + (filter === k ? ' sel' : '') + '" data-nav data-key="cf-' + esc(k) + '" data-zone="cside" data-act="filter" data-f="' + esc(k) + '"><span>' + esc(l) + '</span><span class="n">' + n + '</span></button>').join('') +
        '<div class="spacer"></div><button class="dashed" data-nav data-key="cl-folder" data-zone="cside" data-act="folder">' + icon('folder') + 'Change folder</button></aside>' +
        '<section class="content"><div class="clip-grid">' + list.map((c, i) => '<button class="clip" data-nav data-key="cl-' + i + '" data-zone="cgrid" data-act="play" data-i="' + i + '">' + clipThumbHTML(c) +
          '<span class="cname">' + esc(c.kind === 'shot' ? 'Screenshot' : c.game) + '</span><span class="cwhen">' + esc(ago(c.at)) + '</span></button>').join('') + '</div></section>';
      lazyThumbs(main, $('.content', main));
      const el = (focusKey && $('[data-key="' + cssEsc(focusKey) + '"]', main)) || $('.clip', main) || $('[data-nav]', main);
      if (noFocus) { layer.focusKey = el ? el.dataset.key : null; return; }
      if (el) setFocus(el, { instant: true });
    }
    async function load() {
      try { data = await loadClips(true); err = null; } catch (e) { err = e.message; }
      if (layers.indexOf(layer) >= 0) draw(layer.focusKey);
    }
    load();
  }
  // Asks first, then moves the clip to the Recycle Bin. True when it's gone.
  // `release` lets go of the file first (a video that's showing it keeps it open).
  async function deleteClip(c, release, restore) {
    const what = c.kind === 'shot' ? 'screenshot' : 'clip';
    if (!(await confirmBox('Delete this ' + what + '?', clipName(c) + '. It goes to the Recycle Bin, so you can still get it back there.', 'Delete', true))) { if (restore) restore(); return false; }
    if (release) release();
    try { await api.clipsDelete(c.file); } catch (e) { toast(e.message, true); if (restore) restore(); return false; }
    clipsCache = null;
    toast(what === 'clip' ? 'Clip deleted' : 'Screenshot deleted');
    return true;
  }
  // Full-screen player: A play/pause, left/right 5 s, LB/RB previous/next, Y show in folder,
  // X delete.
  function openClipPlayer(list, index, onGone, onDone) {
    list = list.slice();
    let i = index;
    const layer = openLayer({
      className: 'player-layer',
      html: '<div class="player"><div class="pl-stage"></div><div class="pl-bar"><div class="pl-title"></div><div class="pl-time"></div><div class="pl-track"><i></i></div></div>' +
        '<button class="pl-hit" data-nav data-key="pl" aria-label="Play or pause"></button></div>',
      focus: 'pl',
      onActivate: () => toggle(),
      onMove: (dir) => { const v = $('video', layer.el); if (dir === 'left' || dir === 'right') { if (v) v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + (dir === 'right' ? 5 : -5))); return true; } return true; },
      onButton: (b) => {
        if (b === 'LB' || b === 'RB') { const n = i + (b === 'RB' ? 1 : -1); if (n >= 0 && n < list.length) { i = n; show(); } return true; }
        if (b === 'Y') { api.clipsShow(list[i].file).catch((e) => toast(e.message, true)); return true; }
        if (b === 'X') {
          const c = list[i];
          const v = $('video', layer.el); if (v) v.pause();
          const at = v ? v.currentTime : 0;
          const release = () => { stage.innerHTML = ''; };
          const restore = () => { if (!$('video, img', stage)) { show(); const nv = $('video', stage); if (nv) { nv.autoplay = false; nv.addEventListener('loadedmetadata', () => { nv.currentTime = at; }, { once: true }); } } };
          deleteClip(c, release, restore).then((ok) => {
            if (!ok) return;
            // Let go of the file first (the video was playing it).
            list.splice(i, 1);
            if (onGone) onGone(c);
            if (!list.length) return closeLayer(layer);
            i = Math.min(i, list.length - 1);
            show();
          });
          return true;
        }
        if (b === 'A') { toggle(); return true; }
        return false;
      },
      onBack: () => closeLayer(layer),
      onClose: () => { const v = $('video', layer.el); if (v) { v.pause(); v.removeAttribute('src'); v.load(); } clearInterval(tick); if (onDone) onDone(); },
      prompts: () => [['A', 'Play/Pause'], ['LB', 'RB'], ['X', 'Delete'], ['Y', 'Show in folder'], ['B', 'Close']]
    });
    const stage = $('.pl-stage', layer.el);
    function toggle() { const v = $('video', layer.el); if (v) { if (v.paused) v.play().catch(() => {}); else v.pause(); } }
    function show() {
      const c = list[i];
      stage.innerHTML = c.kind === 'shot' ? '<img src="' + esc(fileUrl(c.file)) + '" alt="">' : '<video src="' + esc(fileUrl(c.file)) + '" autoplay playsinline></video>';
      $('.pl-title', layer.el).textContent = (c.kind === 'shot' ? 'Screenshot · ' : '') + clipName(c) + '  (' + (i + 1) + '/' + list.length + ')';
      const v = $('video', stage);
      if (v) v.addEventListener('error', () => toast('Can’t play this clip here (its format isn’t supported). Y opens it in its folder.', true), { once: true });
    }
    const fmt = (t) => (isFinite(t) ? Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0') : '0:00');
    const tick = setInterval(() => {
      const v = $('video', layer.el);
      $('.pl-time', layer.el).textContent = v ? fmt(v.currentTime) + ' / ' + fmt(v.duration) + (v.paused ? '  ·  paused' : '') : '';
      $('.pl-track i', layer.el).style.width = v && v.duration ? (v.currentTime / v.duration * 100) + '%' : '0';
    }, 250);
    show();
  }

  // Steam achievement progress for a Steam game (null when there's none or Steam isn't connected).
  const steamAppId = (g) => (g && g.source === 'steam' && /^steam:(\d+)$/.exec(g.key || '') || [])[1] || null;
  async function steamAch(g) {
    const id = steamAppId(g);
    if (id) { try { return await api.steamAchievements(id); } catch (_) { return null; } }
    // Emulator games: RetroAchievements (when connected and the game is on RetroAchievements)
    if (g && g.launch && g.launch.type === 'emu' && S.raOn) { try { return await api.raProgress(g.id); } catch (_) { return null; } }
    return null;
  }

  // Your own groups ("Party games", "Racing"...), kept on each game.
  function collections() {
    const set = new Set();
    for (const g of allGames()) for (const c of (g.collections || [])) set.add(c);
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }
  async function editCollections(g) {
    for (;;) {
      const cols = collections();
      const has = (c) => (g.collections || []).includes(c);
      const pick = await openMenu('Collections · ' + g.title, cols.map((c) => ({ id: 'c:' + c, label: (has(c) ? '✓ ' : '') + c, icon: has(c) ? 'check' : 'grid' }))
        .concat([{ id: 'new', label: 'New collection', icon: 'plus' }]));
      if (!pick) return;
      g.collections = g.collections || [];
      if (pick === 'new') {
        const name = await osk('Name the collection', '', 'like Party games');
        if (!name || !name.trim()) continue;
        const n = name.trim().slice(0, 40);
        if (!g.collections.includes(n)) g.collections.push(n);
        toast('Added to ' + n);
      } else {
        const c = pick.slice(2);
        if (has(c)) { g.collections = g.collections.filter((x) => x !== c); toast('Removed from ' + c); }
        else { g.collections.push(c); toast('Added to ' + c); }
      }
      save();
      rerenderKeepFocus();
    }
  }
  async function collectionsMenu() {
    const gs = games();
    const cols = collections();
    const pick = await openMenu('Collections', [{ id: 'coop', label: 'Co-op (' + gs.filter((g) => g.coop).length + ')', icon: 'users' }, { id: 'fav', label: 'Favorites (' + gs.filter((g) => g.favorite).length + ')', icon: 'star' }]
      .concat(cols.map((c) => ({ id: 'col:' + c, label: c + ' (' + gs.filter((g) => (g.collections || []).includes(c)).length + ')', icon: 'grid' }))));
    if (!pick) return;
    S.libFilter = pick;
    go('library', 'f-' + pick);
    if (!cols.length && pick === 'coop') toast('Tip: open a game’s options (Menu button) › Collections to make your own');
  }
  function libList() {
    const f = S.libFilter;
    let gs = f === 'hidden' ? allGames().filter((g) => g.hidden) : games().slice();
    if (f === 'fav') gs = gs.filter((g) => g.favorite);
    else if (f === 'coop') gs = gs.filter((g) => g.coop);
    else if (f.startsWith('col:')) gs = gs.filter((g) => (g.collections || []).includes(f.slice(4)));
    else if (f !== 'all' && f !== 'hidden') gs = gs.filter((g) => g.source === f);
    if (S.libSearch) { const q = S.libSearch.toLowerCase(); gs = gs.filter((g) => g.title.toLowerCase().includes(q)); }
    if (S.libSort === 'az') gs.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }));
    else if (S.libSort === 'most') gs.sort((a, b) => (b.playtime - a.playtime) || a.title.localeCompare(b.title));
    else gs.sort((a, b) => (b.lastPlayed - a.lastPlayed) || (b.addedAt - a.addedAt) || a.title.localeCompare(b.title));
    return gs;
  }

  function notInstalledHTML() {
    const list = notInstalledList();
    const sorts = [['recent', 'Recently played'], ['az', 'A–Z'], ['most', 'Most played']];
    let h = '<div class="toolbar"><div class="pills">' + sorts.map(([k, l]) => '<button class="pill' + (S.libSort === k ? ' sel' : '') + '" data-nav data-key="s-' + k + '" data-zone="tools" data-action="sort" data-s="' + k + '">' + l + '</button>').join('') +
      (S.libSearch ? '<button class="pill" data-nav data-key="s-clear" data-zone="tools" data-action="clear-search">' + icon('x') + 'Clear search</button>' : '') +
      '</div><button class="search' + (S.libSearch ? ' has' : '') + '" data-nav data-key="s-search" data-zone="tools" data-action="search">' + icon('search') + '<span>' + esc(S.libSearch || 'Search your games') + '</span></button></div>';
    h += '<p class="field-note ni-note">Games in your Steam library that aren’t on this ' + PCW + '. Choose one to install it with Steam; it shows up here with its download progress.</p>';
    if (!list.length) return h + '<div class="empty"><b>' + (S.libSearch ? 'No games match “' + esc(S.libSearch) + '”' : 'Everything you own is installed') + '</b></div>';
    return h + '<div class="grid">' + list.map((g) => '<div class="gitem"><button class="tile ni" data-nav data-key="ni-' + esc(g.appid) + '" data-zone="grid" data-action="steam-install" data-app="' + esc(g.appid) + '" aria-label="' + esc(g.title) + '">' +
      '<div class="ph">' + esc(g.title) + '</div>' + (g.img ? '<img src="' + esc(g.img) + '"' + (g.alt ? ' data-alt="' + esc(g.alt) + '"' : '') + ' alt="" decoding="async">' : '') +
      '<span class="badge">' + icon('download') + '</span><div class="label">' + esc(g.title) + '</div></button>' +
      '<div class="name">' + esc(g.title) + '</div><div class="sub">' + esc(g.hours ? fmtHours(g.hours) + ' played' : 'Never played') + '</div></div>').join('') + '</div>';
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
  // (Movies & TV handles its own: it tries the poster first, then shows the title.)
  document.addEventListener('error', (e) => {
    const im = e.target;
    if (!im || im.tagName !== 'IMG' || im.closest('.tv-layer')) return;
    if (im.dataset.alt) { const a = im.dataset.alt; delete im.dataset.alt; im.src = a; return; } // a second picture to try
    im.remove();
  }, true);

  // ---------------------------------------------------------------- top bar & prompts
  // Controllers with their battery (from the app core); falls back to a simple count.
  const LEVELS = ['Empty', 'Low', 'Medium', 'Full'];
  function batteryHTML(pd) {
    if (pd.power !== 'battery') return '<span class="bat wired" title="Wired">' + icon('plug') + '</span>';
    return '<span class="bat lv' + pd.level + '" title="Battery: ' + LEVELS[pd.level] + '">' + [1, 2, 3].map((i) => '<i class="' + (pd.level >= i ? 'on' : '') + '"></i>').join('') + '</span>';
  }
  function padsHTML() {
    if (Array.isArray(S.pads) && S.pads.length) return S.pads.map((pd) => '<span class="padb" title="Controller ' + (pd.slot + 1) + ' · ' + esc(slotInfo(pd.slot).name) + '">' + icon('pad') + '<b>' + (pd.slot + 1) + '</b>' + batteryHTML(pd) + '</span>').join('');
    const n = padCount();
    return n ? icon('pad') + n : '';
  }
  function padCount() {
    try { return Array.from(navigator.getGamepads()).filter((p) => p && p.connected && !(S.vpadsOn && /vendor:\s*1532\b.*product:\s*1000\b/i.test(p.id))).length; } catch (_) { return 0; }
  }
  // The dock, in order. These three are pages (LB/RB slide to them); the rest open something.
  // Clips come from Medal, which is Windows only: no Clips on a Mac.
  const DOCK_NAVS = [['home', 'home', 'Home'], ['library', 'grid', 'My library'], ['search', 'search', 'Search'], ['clips', 'film', 'Clips'], ['tv', 'tv', 'Movies & TV'], ['youtube', 'playc', 'YouTube'], ['friends', 'users', 'Friends'], ['settings', 'gear', 'Settings']].filter((x) => !(IS_MAC && x[0] === 'clips'));
  const DOCK = DOCK_NAVS.map((x) => x[0]);
  const DOCK_VIEWS = ['home', 'library', 'settings'];
  function renderTop() {
    if (TVAPP) { $('#topbar').innerHTML = ''; return; } // Couch TV has no dock
    const s = S.lib.settings;
    const n = games().length;
    const navs = DOCK_NAVS;
    const x = s.xbox;
    const sub = profileFrom() === 'steam' ? icon('level') + '<span>' + esc(profileSub()) + '</span>'
      : x ? icon('trophy') + '<span>' + Number(x.gamerscore || 0).toLocaleString() + '</span>'
      : esc(S.scanning ? 'Looking for games…' : n + ' game' + (n === 1 ? '' : 's'));
    $('#topbar').innerHTML =
      '<button class="me" data-nav data-key="nav-me" data-zone="nav" data-lock="nav" data-action="profile" aria-label="Your profile">' + avatarHTML('avatar') +
      '<div><div class="me-name">' + esc(displayName()) + '</div><div class="me-sub">' + sub + '</div></div></button>' +
      '<nav class="navpill" aria-label="Main">' + navs.map(([k, ic, label]) =>
        '<button class="navbtn' + (S.view === k ? ' active' : '') + '" data-nav data-key="nav-' + k + '" data-zone="nav" data-lock="nav" data-action="nav" data-to="' + k + '" aria-label="' + label + '">' + icon(ic) + '<span class="navtip">' + label + '</span></button>').join('') + '</nav>' +
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
    const p = $('#padcount'); if (p) p.innerHTML = padsHTML();
  }

  const GLYPHS = {
    xbox: { A: 'A', B: 'B', X: 'X', Y: 'Y', LB: 'LB', RB: 'RB', LT: 'LT', RT: 'RT', MENU: '☰', VIEW: '⧉' },
    ps: { A: '✕', B: '○', X: '□', Y: '△', LB: 'L1', RB: 'R1', LT: 'L2', RT: 'R2', MENU: 'OPTIONS', VIEW: 'SHARE' },
    nin: { A: 'B', B: 'A', X: 'Y', Y: 'X', LB: 'L', RB: 'R', LT: 'ZL', RT: 'ZR', MENU: '+', VIEW: '−' },
    key: { A: 'Enter', B: 'Esc', X: 'Del', Y: 'F2', LB: 'Q', RB: 'E', LT: 'PgUp', RT: 'PgDn', MENU: 'M', VIEW: 'Tab' }
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
    else if (TVAPP && !top) list = [['A', 'Select'], ['B', 'Back']];
    else if (top) list = top.prompts ? top.prompts(el) : [['A', 'Select'], ['B', 'Back']];
    else if (el && el.dataset.game) list = [['A', 'Play'], ['Y', 'Edit game'], ['MENU', 'Options']].concat(S.view !== 'home' ? [['B', 'Back']] : []);
    else if (el && el.classList.contains('navbtn') && !DOCK_VIEWS.includes(el.dataset.to)) list = [['A', 'Open']].concat(S.view !== 'home' ? [['B', 'Back']] : [['MENU', 'Power']]);
    else list = [['A', 'Select']].concat(S.view !== 'home' ? [['B', 'Back']] : [['MENU', 'Power']]);
    if (!top && S.view !== 'home' && !TVAPP) list.push(['LB', 'RB']);
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
    if (S.view === 'home') { updateHero(true); paintFriendsNow(); loadDeals(false); }
    if (S.downloads && S.downloads.length) paintDownloads();
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
      ['c-store', 'store', 'Stores', IS_MAC ? 'Steam, Epic' : 'Steam, Xbox, Epic', 'data-action="stores"'],
      ['c-add', 'plus', 'Add a game', 'Any program or game file', 'data-action="add"'],
      ['c-coop', 'users', 'Collections', (coop ? coop + ' co-op' : 'Co-op') + (collections().length ? ' · ' + collections().length + ' more' : ', your groups'), 'data-action="collections"'],
      ['c-set', 'palette', 'Customize', 'Themes, platforms, startup', 'data-action="go-settings" data-tab="themes"']
    ];
    return '<div class="hero"><div class="eyebrow" id="hero-eyebrow"></div><h1 id="hero-title"></h1><div class="meta" id="hero-meta"></div></div>' +
      '<div class="row home-tiles"><div class="row-inner">' + tiles + '</div></div>' +
      '<div class="row home-cards"><div class="row-inner">' + cards.map(([k, ic, t, s, attrs]) =>
        '<button class="card" data-nav data-key="' + k + '" data-zone="cards" data-lock="cards" ' + attrs + '>' + icon(ic) + '<div><div class="t">' + t + '</div><div class="s">' + esc(s) + '</div></div></button>').join('') + '</div></div>' +
      '<section class="home-news" aria-label="Gaming news"><div class="home-friends" id="home-friends"></div><div class="home-deals" id="home-deals">' + dealsHTML() + '</div><div class="news-head">' + icon('news') + '<h2>Gaming news</h2><span class="news-sub" id="news-sub">' + esc(newsSub()) + '</span></div>' +
      '<div class="news-list" id="news-list">' + newsCardsHTML() + '</div></section>';
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
        fitHeroTitle(ti);
        me.textContent = [fmtWhen(g.lastPlayed), fmtPlay(g.playtime)].filter(Boolean).join(' · ') || (g.coop ? 'Co-op' : 'Ready to play');
        // Steam achievements, filled in when they arrive.
        steamAch(g).then((a) => { if (a && S.heroId === g.id && $('#hero-meta') === me) me.innerHTML = esc(me.textContent) + ' · <span class="ach">' + icon('trophy') + a.got + '/' + a.total + '</span>'; });
      }
      for (const n of [eb, ti, me]) { n.classList.remove('swap'); void n.offsetWidth; n.classList.add('swap'); }
      setBackground((g && S.lib.settings.useArtBackground && g.art && g.art.hero) || S.lib.settings.customBg || null);
    };
    if (now) run(); else heroTimer = setTimeout(run, 110);
  }
  // Long names: smaller until they fit on two lines (then they may take a third at the smallest).
  function fitHeroTitle(el) {
    el.style.fontSize = '';
    let size = parseFloat(getComputedStyle(el).fontSize) || 64;
    const min = size * 0.6;
    for (let k = 0; k < 12 && el.scrollHeight > size * 1.1 * 2 + 2 && size > min; k++) { size = Math.max(min, size * 0.92); el.style.fontSize = size + 'px'; }
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
    for (const c of collections()) filters.push(['col:' + c, c, count((g) => (g.collections || []).includes(c))]);
    for (const k of Object.keys(SOURCES)) { const c = count((g) => g.source === k); if (c) filters.push([k, SOURCES[k].name, c]); }
    const hiddenCount = allGames().filter((g) => g.hidden).length;
    if (hiddenCount) filters.push(['hidden', 'Hidden', hiddenCount]);
    // Steam games you own that aren't installed (loaded when the library opens).
    if (S.notInst && S.notInst.list.length) filters.push(['steam-get', 'Steam · not installed', S.notInst.list.length]);
    if (!filters.some((f) => f[0] === S.libFilter)) S.libFilter = 'all';
    loadNotInstalled(false);
    return '<div class="shell"><aside class="side"><h1>My library</h1>' +
      filters.map(([k, label, c]) => '<button class="sideitem' + (S.libFilter === k ? ' sel' : '') + '" data-nav data-key="f-' + k + '" data-zone="side" data-action="filter" data-f="' + k + '"><span>' + esc(label) + '</span><span class="n">' + c + '</span></button>').join('') +
      '<div class="spacer"></div><button class="dashed" data-nav data-key="l-add" data-zone="side" data-action="add">' + icon('plus') + 'Add a game</button></aside>' +
      '<section class="content" id="content">' + libraryContentHTML() + '</section></div>';
  }
  function notInstalledList() {
    let gs = ((S.notInst && S.notInst.list) || []).slice();
    if (S.libSearch) { const q = S.libSearch.toLowerCase(); gs = gs.filter((g) => g.title.toLowerCase().includes(q)); }
    if (S.libSort === 'az') gs.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }));
    else if (S.libSort === 'most') gs.sort((a, b) => (b.hours - a.hours) || a.title.localeCompare(b.title));
    else gs.sort((a, b) => (b.last - a.last) || a.title.localeCompare(b.title));
    return gs;
  }
  let notInstAt = 0, notInstBusy = false;
  async function loadNotInstalled(force) {
    if (OVERLAY || notInstBusy || (!force && Date.now() - notInstAt < 5 * 60e3)) return;
    notInstBusy = true; notInstAt = Date.now();
    let r = null;
    try { r = await api.steamNotInstalled(!!force); } catch (e) { r = S.notInst ? Object.assign({}, S.notInst, { err: e.message }) : null; }
    notInstBusy = false;
    if (!r || !Array.isArray(r.list)) return;
    const before = JSON.stringify(((S.notInst && S.notInst.list) || []).map((g) => g.appid));
    S.notInst = r;
    if (S.view === 'library' && !layers.length && before !== JSON.stringify(r.list.map((g) => g.appid))) rerenderKeepFocus();
  }
  function libraryContentHTML() {
    if (S.libFilter === 'steam-get') return notInstalledHTML();
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
  const TABS = [['platforms', 'Platforms'], ['themes', 'Themes'], ['display', 'Display'], ['controllers', 'Controllers'], ['tv', 'Movies & TV'], ['saves', 'Saves & backups'], ['startup', 'Startup & power'], ['about', 'About']];
  // Couch TV's Settings: the Movies & TV page and About, with a way back at the top.
  const TABS_TV = [['tv', 'General'], ['about', 'About']];
  function settingsHTML() {
    return '<div class="shell"><aside class="side"><h1>Settings</h1>' +
      (TVAPP ? '<button class="sideitem tvapp-back" data-nav data-key="t-back" data-zone="side" data-action="tv-open">' + icon('back') + '<span>Back to Couch TV</span></button>' : '') +
      (TVAPP ? TABS_TV : TABS).map(([k, l]) => '<button class="sideitem' + (S.setTab === k ? ' sel' : '') + '" data-nav data-key="t-' + k + '" data-zone="side" data-action="tab" data-tab="' + k + '"><span>' + l + '</span></button>').join('') +
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
        '<div class="btn-row"><button class="btn big" data-nav data-key="p-emudeck" data-zone="body" data-action="emu-find">' + icon('search') + (IS_MAC ? 'Find emulators' : 'Find emulators (EmuDeck too)') + '</button>' +
        '<button class="btn primary big" data-nav data-key="p-all" data-zone="body" data-action="rescan">' + icon('refresh') + (S.scanning ? 'Scanning…' : 'Rescan all') + '</button></div></div><div class="plist">';
      for (const src of IS_MAC ? ['steam', 'epic'] : ['steam', 'epic', 'msstore', 'roblox']) {
        const info = S.scanInfo[src];
        const on = (P[src] || { enabled: true }).enabled !== false;
        const status = !on ? ['off', 'Turned off'] : !info ? ['off', 'Not scanned yet'] : info.found ? ['ok', 'Connected · ' + cnt(src) + ' games'] : ['warn', 'Not found on this ' + PCW + ''];
        h += '<div class="prow"><div class="picon" style="background:' + SOURCES[src].color + '">' + SOURCES[src].letter + '</div><div class="pinfo"><div class="t">' + SOURCES[src].name + '</div><div class="p">Found automatically</div></div>' +
          '<span class="status ' + status[0] + '">' + status[1] + '</span>' +
          '<button class="btn" data-nav data-key="p-' + src + '-toggle" data-zone="body" data-action="plat-toggle" data-src="' + src + '">' + (on ? 'Turn off' : 'Turn on') + '</button>' +
          '<button class="btn" data-nav data-key="p-' + src + '-scan" data-zone="body" data-action="rescan" data-src="' + src + '"' + (on ? '' : ' disabled') + '>Rescan</button></div>';
      }
      {
        const ids = Object.keys(S.info.emulators || {});
        const setUp = ids.filter((id) => P[id] && P[id].exe && P[id].enabled !== false);
        const n = games().filter((g) => ids.includes(g.source)).length;
        h += '<div class="prow"><div class="picon" style="background:#3B3F6E">' + icon('pad') + '</div><div class="pinfo"><div class="t">Emulators</div><div class="p">' +
          esc(setUp.length ? setUp.map((id) => S.info.emulators[id].name).slice(0, 5).join(', ') + (setUp.length > 5 ? ' and ' + (setUp.length - 5) + ' more' : '') : 'PS2, PS3, Switch, GameCube, Wii U, 3DS, PSP, Xbox, retro and more') + '</div></div>' +
          '<span class="status ' + (setUp.length ? 'ok' : 'warn') + '">' + (setUp.length ? setUp.length + ' set up · ' + n + ' game' + (n === 1 ? '' : 's') : 'None set up') + '</span>' +
          '<button class="btn primary" data-nav data-key="p-emus" data-zone="body" data-action="emu-page">' + icon('gear') + 'Open</button></div>';
      }
      h += '<div class="prow"><div class="picon" style="background:#6B4A1F">' + icon('trophy') + '</div><div class="pinfo"><div class="t">RetroAchievements</div><div class="p">' + esc(S.raOn ? 'Signed in as ' + S.raUser + ' · progress shows on retro games' : 'Achievements for retro games, shown like Steam’s (earn them in the emulators)') + '</div></div>' +
        (S.raOn ? '<span class="status ok">Connected</span><button class="btn" data-nav data-key="p-ra-off" data-zone="body" data-action="ra-off">Disconnect</button>'
          : '<span class="status off">Not connected</span><button class="btn" data-nav data-key="p-ra-on" data-zone="body" data-action="ra-on">' + icon('link') + 'Connect</button>') + '</div>';
      h += '<div class="prow"><div class="picon" style="background:var(--chip);color:var(--text)">' + icon('image') + '</div><div class="pinfo"><div class="t">Game art · SteamGridDB</div><div class="p">Finds tiles and backgrounds by game name</div></div>' +
        (S.artOn ? '<span class="status ok">Connected</span><button class="btn" data-nav data-key="p-art-find" data-zone="body" data-action="art-find">' + icon('search') + (S.artRunning ? 'Finding…' : 'Find missing art') + '</button>' +
          '<button class="btn" data-nav data-key="p-art-all" data-zone="body" data-action="art-all">' + icon('refresh') + 'Find all art</button>' +
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
      const cur = window.STYLES.some((x) => x.id === s.uiStyle) ? s.uiStyle : 'classic';
      const wire = {
        classic: '<rect x="42" y="6" width="36" height="7" rx="3.5"/><rect x="8" y="24" width="50" height="8" rx="2" class="t"/><rect x="8" y="44" width="26" height="20" rx="2"/><rect x="38" y="48" width="16" height="16" rx="2"/><rect x="58" y="48" width="16" height="16" rx="2"/><rect x="78" y="48" width="16" height="16" rx="2"/><rect x="98" y="48" width="16" height="16" rx="2"/>',
        shelf: '<rect x="8" y="14" width="30" height="30" rx="3"/><rect x="42" y="14" width="30" height="30" rx="3"/><rect x="76" y="14" width="30" height="30" rx="3"/><rect x="110" y="14" width="10" height="30" rx="3"/>' + [34, 46, 58, 70, 82].map((x) => '<circle cx="' + x + '" cy="58" r="4.5"/>').join(''),
        spotlight: '<rect x="42" y="5" width="36" height="6" rx="3"/>' + [8, 21, 34, 47, 60].map((x, i) => '<rect x="' + x + '" y="' + (i ? 17 : 15) + '" width="' + (i ? 10 : 13) + '" height="' + (i ? 10 : 13) + '" rx="2"/>').join('') + '<rect x="8" y="42" width="56" height="9" rx="2" class="t"/><rect x="8" y="56" width="26" height="10" rx="2"/><rect x="38" y="56" width="26" height="10" rx="2"/><rect x="68" y="56" width="26" height="10" rx="2"/>'
      };
      let h = '<div class="sect-h"><div><h2>Style</h2><p>How the Home screen is laid out. Everything works the same in each.</p></div></div><div class="theme-grid style-grid">' +
        window.STYLES.map((x) => '<button class="tcard' + (cur === x.id ? ' sel' : '') + '" data-nav data-key="st-' + x.id + '" data-zone="body" data-action="ui-style" data-id="' + x.id + '">' +
          '<div class="sw wire"><svg viewBox="0 0 120 72" aria-hidden="true">' + wire[x.id] + '</svg></div>' +
          '<div class="n">' + esc(x.name) + (cur === x.id ? '<span class="check">' + icon('check') + '</span>' : '') + '</div><div class="d">' + esc(x.desc) + '</div></button>').join('') + '</div>';
      h += '<div class="sect-h" style="margin-top:3.2rem"><div><h2>Themes</h2><p>Changes apply right away, everywhere.</p></div></div><div class="theme-grid">';
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
        (IS_MAC ? '<p class="field-note" style="margin-top:2rem;font-size:1.5rem">Games open on whatever monitor they choose; most use the main monitor, which you can change in System Settings › Displays.</p>'
          : '<p class="field-note" style="margin-top:2rem;font-size:1.5rem">A game still opens on another monitor? Some games, older ones especially, only open on Windows’ main monitor. In that game’s menu, choose <b>TV settings for this game › Make it the main monitor while playing</b>.</p>') +
        '<div class="sub-h">Window</div><div class="toggles" style="grid-template-columns:1fr">' +
        (IS_MAC ? '' : '<button class="toggle-row" data-nav data-key="d-mainmon" data-zone="body" data-action="main-mon"><span><div>Games that open on the main monitor</div><div class="d">Some games always open on Windows’ main monitor. The launcher can move them, or make this screen the main monitor while you play (screens blink once at the start and end). Each game can also have its own choice in its TV settings.</div></span><span>' +
          (s.mainWhilePlaying ? 'Make this the main monitor' : 'Move them here') + '</span></button>') +
        '<button class="toggle-row" data-nav data-key="d-idle" data-zone="body" data-action="idle-time"><span><div>Idle screen</div><div class="d">A slideshow of your games and the time when nothing’s been pressed for a while</div></span><span>' + (idleMinutes() ? 'After ' + idleMinutes() + ' min' : 'Off') + '</span></button>' +
        toggleHTML('d-full', 'Full screen', !S.info.windowed, 'Off: the launcher opens in a normal window you can move and resize. It restarts to switch.' + (IS_MAC ? ' (Also in the menu bar: Couch Launcher › Full Screen.)' : ''), 'full-toggle', '') + '</div>';
    }
    if (tab === 'controllers') {
      if (S.captureInfo === undefined) { S.captureInfo = null; Promise.resolve().then(() => api.captureStatus()).then((c) => { S.captureInfo = c || {}; if (S.view === 'settings' && S.setTab === 'controllers' && !layers.length) refreshContent(); }).catch(() => { S.captureInfo = {}; }); }
      const pads = Array.from(navigator.getGamepads ? navigator.getGamepads() : []).filter((p) => p && p.connected);
      let h = '<div class="sect-h"><div><h2>Controllers</h2><p>Any connected controller can move around the launcher.</p></div></div><div class="pad-list">';
      if (!pads.length) h += '<div class="prow"><div class="pinfo"><div class="t">No controllers found</div><div class="p">Press any button on a controller to wake it up</div></div></div>';
      pads.forEach((p, i) => {
        const kind = padKind(p.id);
        h += '<div class="prow"><div class="picon" style="background:var(--accent);color:var(--on-accent)">P' + (i + 1) + '</div><div class="pinfo"><div class="t">Player ' + (i + 1) + ' · ' + (kind === 'ps' ? 'PlayStation' : kind === 'nin' ? 'Nintendo' : 'Xbox / standard') + ' controller</div><div class="p">' + esc(p.id.replace(/\s*\(.*$/, '')) + '</div></div><span class="status ok">Connected</span></div>';
      });
      if (IS_MAC) {
        // Mac: the Xbox / PS button is read straight from the controller (no Windows parts).
        const ge = S.info.guideError;
        h += '</div><div class="sub-h">During a game</div><dl class="kv">' +
          '<dt>Open the guide</dt><dd>Press the Xbox or PS button' + (ge ? '<br><span class="field-note">' + esc(ge) + '</span>' : '') + '</dd>' +
          '<dt>Keyboard</dt><dd>Control + Option + G</dd>' +
          '<dt>Xbox button opens Launchpad?</dt><dd>Turn that off in System Settings › Game Controllers › your controller › Home button</dd></dl>' +
          '<div class="sub-h">Guide</div><div class="toggles" style="grid-template-columns:1fr">' +
          toggleHTML('c-pause', 'Pause the game while the guide is open', S.lib.settings.pauseGame !== false, 'Stops the controller from also moving you in the game. Turn off for online matches, since a paused game can’t stay connected.', 'set-toggle', 'data-k="pauseGame"') +
          toggleHTML('c-nbat', 'Warn me when a controller battery is low', S.lib.settings.notifyBattery !== false, 'A pop-up, even during a game.', 'set-toggle', 'data-k="notifyBattery"') +
        toggleHTML('c-pops', 'Show notifications as Couch Launcher pop-ups', S.lib.settings.ownPopups !== false, 'Top right, above games and everything else. Off: regular ' + (IS_MAC ? 'Mac' : 'Windows') + ' notifications.', 'set-toggle', 'data-k="ownPopups"') +
        toggleHTML('c-popsnd', 'Play a sound with pop-ups', S.lib.settings.popSound !== false, '', 'set-toggle', 'data-k="popSound"') +
        '<button class="toggle-row" data-nav data-key="c-poptest" data-zone="body" data-action="pops-test"><span><div>Show a test pop-up</div><div class="d">See where they appear.</div></span><span class="status ok">Try it</span></button>' +
        toggleHTML('c-callov', 'Show my Discord call on screen', S.lib.settings.callOverlay !== false, 'Who’s in the call, lit up while they talk. Top left, above games and the launcher. Needs Discord calls connected (guide › Friends).', 'set-toggle', 'data-k="callOverlay"') +
        toggleHTML('c-calltalk', 'Only show who’s talking', !!S.lib.settings.callTalkingOnly, 'Instead of everyone in the call.', 'set-toggle', 'data-k="callTalkingOnly"') +
        '<button class="toggle-row" data-nav data-key="c-dcmsg" data-zone="body" data-action="dc-msgs"><span><div>Discord messages as pop-ups</div><div class="d">Discord’s own notifications, shown the launcher’s way. Needs Discord calls connected and Discord’s permission to read notifications.</div></span><span class="status ok">' + (S.lib.settings.dcMessages !== false ? 'On' : 'Off') + '</span></button>' + '</div>';
        return h;
      }
      h += '</div><div class="sub-h">During a game</div><dl class="kv">' +
        '<dt>Back to the launcher</dt><dd>Hold View + Menu for 1 second' + (S.info.hotkey ? '' : ' (not available on this ' + PCW + ')') + '</dd>' +
        '<dt>Keyboard</dt><dd>Ctrl + Alt + Home</dd>' +
        '<dt>PlayStation / Switch pads</dt><dd>The hold works when Steam Input or DS4Windows is running</dd></dl>' +
        '<div class="sub-h">Guide</div><div class="toggles" style="grid-template-columns:1fr">' +
        toggleHTML('c-pause', 'Pause the game while the guide is open', S.lib.settings.pauseGame !== false, 'Stops the controller from also moving you in the game. Turn off for online matches, since a paused game can’t stay connected.', 'set-toggle', 'data-k="pauseGame"') + '</div>' +
        '<div class="sub-h">Music apps</div><div class="toggles" style="grid-template-columns:1fr">' +
        toggleHTML('c-mmouse', 'Use the controller as a mouse in Apple Music, Spotify, Discord and Epic Games', S.lib.settings.musicMouse !== false, 'Left stick moves the pointer, A clicks, right stick scrolls, B goes back, X plays/pauses. Xbox-style controllers.', 'set-toggle', 'data-k="musicMouse"') +
        '<button class="toggle-row" data-nav data-key="c-players" data-zone="body" data-action="players-setup"><span><div>Players</div><div class="d">' + esc(playersLabel()) + '</div></span><span class="status ok">Set up</span></button>' +
        '<button class="toggle-row" data-nav data-key="c-pick" data-zone="body" data-action="pick-mode"><span><div>Players in emulator games</div><div class="d">Ryujinx, Dolphin and RPCS3 (Xbox-style controllers).</div></span><span class="status ok">' +
          ({ saved: 'Use my saved players', ask: 'Ask every time', auto: 'Ask every time', always: 'Ask every time', off: 'Leave as set in the emulator' }[S.lib.settings.pickPlayers || 'saved']) + '</span></button>' +
        '<button class="toggle-row" data-nav data-key="c-phone" data-zone="body" data-action="phone-remote"><span><div>Phone remote</div><div class="d">Use your phone as a remote on your home Wi-Fi: move around, type into text boxes, start games, open the guide.</div></span><span class="status ok">' +
          (S.lib.settings.phoneRemote ? 'On' : 'Off') + '</span></button>' +
        '<button class="toggle-row" data-nav data-key="c-steady" data-zone="body" data-action="steady"><span><div>Steady players in Ryujinx</div><div class="d">The launcher holds a virtual controller for each player during the game, so a controller dying doesn’t shuffle the players. When it’s back on, it takes its spot again.</div></span><span class="status ok">' +
          (S.lib.settings.steadyPlayers ? 'On' : 'Off') + '</span></button>' +
        toggleHTML('c-nbat', 'Warn me when a controller battery is low', S.lib.settings.notifyBattery !== false, 'A pop-up, even during a game.', 'set-toggle', 'data-k="notifyBattery"') +
        toggleHTML('c-pops', 'Show notifications as Couch Launcher pop-ups', S.lib.settings.ownPopups !== false, 'Top right, above games and everything else. Off: regular ' + (IS_MAC ? 'Mac' : 'Windows') + ' notifications.', 'set-toggle', 'data-k="ownPopups"') +
        toggleHTML('c-popsnd', 'Play a sound with pop-ups', S.lib.settings.popSound !== false, '', 'set-toggle', 'data-k="popSound"') +
        '<button class="toggle-row" data-nav data-key="c-poptest" data-zone="body" data-action="pops-test"><span><div>Show a test pop-up</div><div class="d">See where they appear.</div></span><span class="status ok">Try it</span></button>' +
        toggleHTML('c-callov', 'Show my Discord call on screen', S.lib.settings.callOverlay !== false, 'Who’s in the call, lit up while they talk. Top left, above games and the launcher. Needs Discord calls connected (guide › Friends).', 'set-toggle', 'data-k="callOverlay"') +
        toggleHTML('c-calltalk', 'Only show who’s talking', !!S.lib.settings.callTalkingOnly, 'Instead of everyone in the call.', 'set-toggle', 'data-k="callTalkingOnly"') +
        '<button class="toggle-row" data-nav data-key="c-dcmsg" data-zone="body" data-action="dc-msgs"><span><div>Discord messages as pop-ups</div><div class="d">Discord’s own notifications, shown the launcher’s way. Needs Discord calls connected and Discord’s permission to read notifications.</div></span><span class="status ok">' + (S.lib.settings.dcMessages !== false ? 'On' : 'Off') + '</span></button>' +
        toggleHTML('c-nfr', 'Tell me when a friend comes online', S.lib.settings.notifyFriends !== false, 'Xbox and Steam friends you have connected.', 'set-toggle', 'data-k="notifyFriends"') +
        toggleHTML('c-njoin', 'Tell me when a friend starts a game I can join', S.lib.settings.notifyJoin !== false, 'Steam friends in a lobby or on a server (their Steam profile has to be public). Join from the alert or the guide.', 'set-toggle', 'data-k="notifyJoin"') +
        toggleHTML('c-ncall', 'Tell me when someone joins or leaves my Discord call', S.lib.settings.notifyCalls !== false, 'Needs Discord calls connected (guide › Friends).', 'set-toggle', 'data-k="notifyCalls"') +
        toggleHTML('c-ndl', 'Tell me when a Steam download finishes', S.lib.settings.notifyDownloads !== false, 'Installs and updates.', 'set-toggle', 'data-k="notifyDownloads"') +
        toggleHTML('c-deals', 'Show free games and deals on Home', S.lib.settings.showDeals !== false, 'Epic’s weekly free games, giveaways and the best deals at Steam, GOG, Humble and other official stores.', 'set-toggle', 'data-k="showDeals"') +
        toggleHTML('c-nfree', 'Tell me when there’s a new free game', S.lib.settings.notifyFree !== false, 'Free to keep, on Epic and other stores (not games you have).', 'set-toggle', 'data-k="notifyFree"') +
        toggleHTML('c-nprice', 'Tell me when a game I watch gets cheaper', S.lib.settings.notifyPrice !== false, 'Watch a deal from Home (A › Watch the price).', 'set-toggle', 'data-k="notifyPrice"') +
        toggleHTML('c-pspads', 'Read PlayStation controllers in the background', S.lib.settings.psPads !== false, 'The PS button opens the guide, also during games (DualShock 4, DualSense). Turn off if a PlayStation controller acts up.', 'set-toggle', 'data-k="psPads"') +
        toggleHTML('c-autoclose', 'Close stores when you press the Xbox button to come back', S.lib.settings.autoCloseApps !== false, 'Steam Big Picture, Epic Games, the Xbox app and Microsoft Store close when you return to the launcher. Music apps and Discord keep running.', 'set-toggle', 'data-k="autoCloseApps"') + '</div>' +
        (IS_MAC ? '' : '<div class="sub-h">Clips with Medal</div><div class="toggles" style="grid-template-columns:1fr">' +
        toggleHTML('m-share', 'Share button saves Medal clips', S.lib.settings.medalShare !== false, 'Tap Share for a screenshot, hold it for a clip. Works in games and apps (not inside the launcher). Medal needs to be running.', 'set-toggle', 'data-k="medalShare"') +
        '<button class="toggle-row" data-nav data-key="m-clip" data-zone="body" data-action="medal-key" data-which="clip"><span><div>Medal’s clip key</div><div class="d">Match Medal › Settings › Capture Hotkeys.</div></span><span class="status ok">' + esc(S.lib.settings.medalClipKey || 'F8') + '</span></button>' +
        '<button class="toggle-row" data-nav data-key="m-shot" data-zone="body" data-action="medal-key" data-which="shot"><span><div>Medal’s screenshot key</div><div class="d">Set a screenshot key in Medal, then pick the same one here.</div></span><span class="status ' + (S.lib.settings.medalShotKey ? 'ok' : 'warn') + '">' + esc(S.lib.settings.medalShotKey || 'Not set') + '</span></button>' +
        '<button class="toggle-row" data-nav data-key="m-xbox" data-zone="body" data-action="medal-xbox"><span><div>Xbox controllers</div><div class="d">' + esc(S.captureInfo == null ? 'Checking your controller…' : S.captureInfo.xboxShareReadable ? 'Your Xbox controller’s Share button can be read (Bluetooth).' : S.captureInfo.xboxNeedsFind ? 'Your Xbox controller is connected over Bluetooth: open Test the Share button below and choose Find Share once. Until then, View + RB clips.' : 'No Xbox Share button readable right now: it only works over Bluetooth. Hold View + RB for a clip, View + LB for a screenshot.') + '</div></span><span class="status ok">' +
          ({ auto: 'Share and View combo', share: 'Share button', combo: 'View + RB / LB' }[S.lib.settings.medalXbox || 'auto']) + '</span></button>' +
        '<button class="toggle-row" data-nav data-key="m-test" data-zone="body" data-action="share-test"><span><div>Test the Share button</div><div class="d">See what the launcher reads from your controller, and send Medal a test clip.</div></span><span class="status ok">Test</span></button></div>') +
        '<div class="sub-h">Couch co-op</div><p class="field-note" style="font-size:1.5rem">Player 1–4 inside games are set once in each emulator’s own controller settings (Dolphin, RPCS3, Ryujinx). After that every game picks them up.</p>';
      return h;
    }
    if (tab === 'emulators') {
      const E = S.info.emulators || {};
      const found = S.emuFound;
      if (found === undefined) { S.emuFound = null; Promise.resolve().then(() => api.findEmulators()).then((f) => { S.emuFound = f || {}; if (S.view === 'settings' && S.setTab === 'emulators' && !layers.length) refreshContent(); }).catch(() => { S.emuFound = {}; }); }
      const cnt = (id) => games().filter((g) => g.source === id).length;
      const ids = Object.keys(E);
      const setUp = ids.filter((id) => P[id] && P[id].exe);
      const foundOnly = ids.filter((id) => !(P[id] && P[id].exe) && found && found[id] && found[id].exe);
      const rest = ids.filter((id) => !setUp.includes(id) && !foundOnly.includes(id));
      const color = (id) => (SOURCES[id] && SOURCES[id].color) || '#444A52';
      const row = (id, kind) => {
        const e = E[id], c = P[id] || {};
        const off = c.enabled === false;
        const status = kind === 'found' ? ['ok', 'Found on this ' + PCW + ''] : kind === 'none' ? ['off', 'Not found'] : off ? ['off', 'Turned off'] : !e.noFolder && !c.dir ? ['warn', 'Needs games folder'] : ['ok', cnt(id) + ' game' + (cnt(id) === 1 ? '' : 's')];
        const u = kind === 'set' && S.emuUpdates && S.emuUpdates[id];
        const upNote = u ? (u.status === 'managed' ? (u.managedBy === 'installer' ? '  ·  updates with its own installer' : '  ·  kept up to date by ' + u.managedBy) : u.status === 'current' ? '  ·  up to date' : u.status === 'update' ? '  ·  update available' : '') : '';
        const where = (kind === 'found' ? found[id].exe + (found[id].dirs.length ? '  →  ' + found[id].dirs.join(' + ') : '') : c.exe ? c.exe + (c.dir ? '  →  ' + c.dir.split(';').join(' + ') : e.noFolder ? '  →  its own game list' : '') : e.system) + upNote;
        let btns = '';
        if (kind === 'found') btns = '<button class="btn primary" data-nav data-key="e-' + id + '-setup" data-zone="body" data-action="emu-setup" data-src="' + id + '">' + icon('check') + 'Set up</button>';
        else if (kind === 'none') btns = '<button class="btn" data-nav data-key="e-' + id + '-exe" data-zone="body" data-action="plat-exe" data-src="' + id + '">Set program</button>';
        else btns = (S.emuUpdates && S.emuUpdates[id] && S.emuUpdates[id].status === 'update' ? '<button class="btn primary" data-nav data-key="e-' + id + '-upd" data-zone="body" data-action="emu-update" data-src="' + id + '">' + icon('up') + 'Update' + (S.emuUpdates[id].latest && S.emuUpdates[id].latest.tag ? ' to ' + esc(String(S.emuUpdates[id].latest.tag).slice(0, 16)) : '') + '</button>' : '') +
          '<button class="btn" data-nav data-key="e-' + id + '-toggle" data-zone="body" data-action="emu-toggle" data-src="' + id + '">' + (off ? 'Turn on' : 'Turn off') + '</button>' +
          '<button class="btn" data-nav data-key="e-' + id + '-exe" data-zone="body" data-action="plat-exe" data-src="' + id + '">Program</button>' +
          (e.noFolder && id !== 'shadps4' ? '' : '<button class="btn" data-nav data-key="e-' + id + '-dir" data-zone="body" data-action="plat-dir" data-src="' + id + '">' + (c.dir ? 'Folder' : 'Games folder') + '</button>') +
          '<button class="btn" data-nav data-key="e-' + id + '-scan" data-zone="body" data-action="rescan" data-src="' + id + '"' + (off ? ' disabled' : '') + '>Rescan</button>' +
          '<button class="btn" data-nav data-key="e-' + id + '-open" data-zone="body" data-action="emu-open" data-src="' + id + '">Open</button>';
        return '<div class="prow"><div class="picon" style="background:' + color(id) + '">' + esc(e.name.charAt(0)) + '</div><div class="pinfo"><div class="t">' + esc(e.name + ' · ' + e.system) + '</div><div class="p">' + esc(where) + '</div></div>' +
          '<span class="status ' + status[0] + '">' + status[1] + '</span>' + btns + '</div>';
      };
      let h = '<div class="sect-h"><div><h2>Emulators</h2><p>' + (found === null ? 'Looking for emulators on this ' + PCW + '…' : setUp.length + ' set up' + (foundOnly.length ? ' · ' + foundOnly.length + ' more found on this ' + PCW + '' : '')) + '. EmuDeck folders (Emulation\\roms) are found by themselves.</p></div>' +
        '<div class="btn-row"><button class="btn big" data-nav data-key="e-back" data-zone="body" data-action="emu-back">' + icon('prev') + 'Platforms</button>' +
        (foundOnly.length ? '<button class="btn primary big" data-nav data-key="e-all" data-zone="body" data-action="emu-setup">' + icon('check') + 'Set up all ' + foundOnly.length + '</button>' : '') +
        '<button class="btn big" data-nav data-key="e-find" data-zone="body" data-action="emu-find">' + icon('search') + 'Find again</button>' +
        (setUp.length ? '<button class="btn big" data-nav data-key="e-upd" data-zone="body" data-action="emu-updates">' + icon('up') + 'Check for updates</button>' : '') + '</div></div>';
      if (setUp.length) h += '<div class="sub-h">Set up</div><div class="plist">' + setUp.map((id) => row(id, 'set')).join('') + '</div>';
      if (foundOnly.length) h += '<div class="sub-h">Found on this ' + PCW + '</div><div class="plist">' + foundOnly.map((id) => row(id, 'found')).join('') + '</div>';
      if (rest.length) h += S.emuShowAll ? '<div class="sub-h">More emulators</div><div class="plist">' + rest.map((id) => row(id, 'none')).join('') + '</div>'
        : '<div class="btn-row" style="margin-top:2rem"><button class="dashed" data-nav data-key="e-more" data-zone="body" data-action="emu-more">' + icon('plus') + 'Show ' + rest.length + ' more emulators</button></div>';
      h += '<p class="field-note" style="margin-top:2rem">You need your own BIOS / firmware files and game dumps for each emulator. Multi-disc games show once (an .m3u playlist is used when there is one); a game in several regions shows once too — pick the version in its menu (☰).</p>';
      return h;
    }
    if (tab === 'saves') {
      const b = S.backupInfo;
      if (b === undefined) { S.backupInfo = null; Promise.resolve().then(() => api.backupStatus()).then((x) => { S.backupInfo = x || {}; if (S.view === 'settings' && S.setTab === 'saves' && !layers.length) refreshContent(); }).catch(() => { S.backupInfo = {}; }); }
      const to = s.backupTo || 'off';
      const where = to === 'off' ? 'Off' : to === 'folder' ? (s.backupFolder ? baseName(s.backupFolder) : 'Choose a folder') : to === 'gdrive' ? 'Google Drive' : 'OneDrive';
      const warn = to !== 'off' && b && !b.root;
      let h = '<div class="sect-h"><div><h2>Saves &amp; backups</h2><p>Your emulator saves, copied before a game starts and after it closes (only when something changed).</p></div>' +
        '<div class="btn-row">' + (to !== 'off' ? '<button class="btn primary big" data-nav data-key="bk-now" data-zone="body" data-action="bk-now">' + icon('refresh') + 'Back up now</button>' : '') + '</div></div>' +
        '<div class="toggles" style="grid-template-columns:1fr">' +
        '<button class="toggle-row" data-nav data-key="bk-to" data-zone="body" data-action="bk-to"><span><div>Back up to</div><div class="d">' + esc(warn ? (to === 'gdrive' ? 'Google Drive for desktop isn’t running or signed in on this ' + PCW + '.' : to === 'onedrive' ? 'OneDrive isn’t set up on this ' + PCW + '.' : 'That folder isn’t there right now.') : to === 'off' ? 'Google Drive, OneDrive or any folder.' : (b && b.root ? b.root + '\\Couch Launcher\\Save backups' : '')) + '</div></span><span class="status ' + (warn ? 'warn' : to === 'off' ? 'off' : 'ok') + '">' + esc(where) + '</span></button>' +
        '<button class="toggle-row" data-nav data-key="bk-keep" data-zone="body" data-action="bk-keep"><span><div>Copies to keep</div><div class="d">Per emulator. The oldest go first.</div></span><span class="status ok">' + (Number(s.backupKeep) || 10) + '</span></button>' +
        toggleHTML('c-states', 'Save and resume', s.saveStates !== false, 'Closing or switching a game saves where you are; next time you’re asked whether to pick up from there. Dolphin, PCSX2, DuckStation and RetroArch.', 'set-toggle', 'data-k="saveStates"') +
        '</div>';
      if (b && b.emus && b.emus.length) {
        h += '<div class="sub-h">Emulators</div><div class="plist">' + b.emus.map((e) => '<div class="prow"><div class="picon" style="background:' + ((SOURCES[e.id] && SOURCES[e.id].color) || '#444A52') + '">' + esc(e.name.charAt(0)) + '</div><div class="pinfo"><div class="t">' + esc(e.name) + '</div><div class="p">' +
          esc(e.sources.length ? e.sources.map((x) => x.path).join(' + ') : 'Its saves are next to the games (backed up with EmuDeck’s saves folder)') + '</div>' +
          (e.result && !e.result.done ? '<div class="p bk-why">' + esc('Last try (' + ago(e.result.at) + '): ' + backupWhy(e.result)) + '</div>' : '') + '</div>' +
          '<span class="status ' + (e.last ? 'ok' : 'off') + '">' + (e.last ? esc(fmtWhen(e.last).replace(/^Played /, 'Backed up ')) + ' · ' + e.count : 'No backups yet') + '</span>' +
          (e.count ? '<button class="btn" data-nav data-key="bk-r-' + e.id + '" data-zone="body" data-action="bk-restore" data-src="' + e.id + '">Restore</button>' : '') +
          (to !== 'off' && e.sources.length ? '<button class="btn" data-nav data-key="bk-n-' + e.id + '" data-zone="body" data-action="bk-now" data-src="' + e.id + '">Back up</button>' : '') + '</div>').join('') + '</div>';
      } else if (b) h += '<p class="field-note">Set up emulators in Settings › Platforms › Emulators, and their saves show up here.</p>';
      return h;
    }
    if (tab === 'tv') {
      const t = S.tvStatus;
      if (!t) setTimeout(loadTvSettings, 0);
      const row = (key, action, label, desc, value, extra) => '<button class="toggle-row" data-nav data-key="' + key + '" data-zone="body" data-action="' + action + '" ' + (extra || '') + '><span><div>' + esc(label) + '</div>' + (desc ? '<div class="d">' + esc(desc) + '</div>' : '') + '</span><span class="status ok">' + esc(value) + '</span></button>';
      const QL = { '4K': '4K', '1080p': '1080p', '720p': '720p' };
      const SL = { off: 'Off', en: 'English', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', it: 'Italian' };
      const m = s.tvMode === 'light' ? 'light' : 'dark';
      return '<div class="sect-h"><div><h2>' + (TVAPP ? 'Couch TV' : 'Movies &amp; TV') + '</h2><p>Stremio with your addons, made for the couch.</p></div>' + (TVAPP ? '' : '<div class="btn-row"><button class="btn primary big" data-nav data-key="tv-open" data-zone="body" data-action="tv-open">' + icon('tv') + 'Open Movies &amp; TV</button></div>') + '</div>' +
        '<div class="sub-h">Appearance</div><div class="btn-row tv-modes">' +
        '<button class="btn big' + (m === 'dark' ? ' primary' : '') + '" data-nav data-key="tv-dark" data-zone="body" data-action="tv-mode" data-mode="dark" aria-pressed="' + (m === 'dark') + '">' + icon('moon') + 'Dark</button>' +
        '<button class="btn big' + (m === 'light' ? ' primary' : '') + '" data-nav data-key="tv-light" data-zone="body" data-action="tv-mode" data-mode="light" aria-pressed="' + (m === 'light') + '">' + icon('star') + 'Light</button></div>' +
        (TVAPP ? '<div class="toggles" style="grid-template-columns:1fr;margin-top:1.6rem">' +
          '<button class="toggle-row" data-nav data-key="tv-full" data-zone="body" data-action="tvapp-full"><span><div>Full screen</div><div class="d">Couch TV opens in a window you can size and move. F11 switches too.</div></span><span class="status ok">' + (S.tvFull ? 'On' : 'Off') + '</span></button>' +
          toggleHTML('tv-motion', 'Reduce motion', !!s.reduceMotion, 'Fewer animations.', 'set-toggle', 'data-k="reduceMotion"') +
          (S.info.canEmbed ? toggleHTML('tv-inwin', 'Play videos in the window', s.tvInWindow !== false, 'Off: videos take the whole screen, as in Couch Launcher.', 'set-toggle', 'data-k="tvInWindow"') : '') + '</div>' : '') +
        '<div class="sub-h">Stremio account</div><div class="toggles" style="grid-template-columns:1fr">' +
        (!t ? '<p class="field-note">Checking…</p>' : t.signedIn
          ? row('tv-out', 'tv-signout', 'Signed in' + (t.email ? ' as ' + t.email : ''), 'Your addons, library and Continue Watching sync with the Stremio app.', 'Sign out')
          : row('tv-in', 'tv-signin', 'Sign in to Stremio', 'Bring your own addons, library and Continue Watching. Without an account you get Cinemeta and OpenSubtitles.', 'Sign in')) +
        '</div><div class="sub-h">Playing</div><div class="toggles" style="grid-template-columns:1fr">' +
        toggleHTML('tv-intro', 'Opening animation', s.tvIntro !== false, TVAPP ? 'Plays when Couch TV opens.' : 'Plays the first time you open Movies & TV each session.', 'set-toggle', 'data-k="tvIntro"') +
        toggleHTML('tv-auto', 'Play the best match straight away', !!s.tvAutoPlay, 'Skips the stream list. Choose stream on a show’s page still lets you pick.', 'set-toggle', 'data-k="tvAutoPlay"') +
        row('tv-q', 'tv-quality', 'Preferred quality', 'What “best match” looks for first.', QL[s.tvQuality] || '1080p') +
        row('tv-s', 'tv-subs', 'Subtitles', 'Turned on automatically when a movie or episode has them.', SL[s.tvSubLang || 'en'] || 'English') +
        (t ? row('tv-mpv', 'tv-mpv', 'Video player', t.mpv ? 'mpv · ' + (t.mpvPath || '') : 'Movies play in mpv, a free player that handles every format (4K, HDR, all audio).', t.mpv ? 'Change' : 'Install mpv') : '') +
        (TVAPP ? '' : '</div><div class="sub-h">YouTube</div><div class="toggles" style="grid-template-columns:1fr">' +
        toggleHTML('yt-ads', 'Block ads in YouTube', s.ytAdblock !== false, 'Uses the ad blocker from VacuumTube by shy (MIT License). Takes effect the next time YouTube opens. Turn off if videos stop loading.', 'set-toggle', 'data-k="ytAdblock"') +
                row('yt-reset', 'yt-reset', 'Sign out of YouTube', 'Forgets the YouTube account and settings on this ' + PCW + '. Open YouTube from the dock to sign in again.', 'Sign out')) +
        '</div>' + (t ? '<p class="field-note">' + (t.engine ? 'Torrent streams use Stremio’s streaming engine from your Stremio app.' : 'Torrent streams need the Stremio app (or Stremio Service) installed on this ' + PCW + '. Debrid and direct links work without it.') + ' Controls while watching: A pause · ←/→ scrub · LB/RB skip · Y subtitles · X audio · B back.</p>' : '');
    }
    if (tab === 'startup') {
      return '<div class="sect-h"><div><h2>Startup &amp; power</h2><p>Turn on the PC, grab a controller.</p></div></div><div class="toggles" style="grid-template-columns:1fr">' +
        toggleHTML('st-auto', 'Start with Windows', s.autostart, 'Opens the launcher full screen when you sign in', 'autostart') +
        '<button class="toggle-row" data-nav data-key="st-name" data-zone="body" data-action="rename"><span><div>Your name</div><div class="d">Shown at the top of Home</div></span><span>' + esc(s.userName || 'Player') + '</span></button></div>' +
        '<div class="sub-h">Power</div><div class="btn-row">' +
        '<button class="btn big" data-nav data-key="pw-exit" data-zone="body" data-action="power" data-p="exit">' + icon('exit') + 'Exit to desktop</button>' +
        '<button class="btn big" data-nav data-key="pw-sleep" data-zone="body" data-action="power" data-p="sleep">' + icon('moon') + 'Sleep</button>' +
        '<button class="btn big" data-nav data-key="pw-restart" data-zone="body" data-action="power" data-p="restart">' + icon('restart') + 'Restart</button>' +
        '<button class="btn big" data-nav data-key="pw-off" data-zone="body" data-action="power" data-p="shutdown">' + icon('power') + (IS_MAC ? 'Shut Down' : 'Shut down') + '</button></div>';
    }
    if (TVAPP) {
      return '<div class="sect-h about-h"><img class="about-logo" src="couchtv.png" alt=""><div><h2>Couch TV</h2><p>Version ' + esc(S.info.version || '') + '</p></div></div>' +
        '<p class="field-note" style="font-size:1.6rem">Movies, series and Cable TV from Couch Launcher, as an app of its own.</p>' +
        '<p class="field-note" style="margin-top:1.4rem;font-size:1.6rem">' + (S.info.sharedWithLauncher
          ? 'Your addons, your list, what you’ve watched and your Cable TV channels are the same ones Couch Launcher uses' + (S.info.sharedSignIn ? ', and so is your Stremio sign-in.' : '. Your Stremio sign-in is kept separately here.')
          : 'Couch Launcher isn’t set up on this ' + PCW + '. If you install it later, it will use the same addons, list and history.') + '</p>' +
        '<div class="btn-row" style="margin-top:3rem"><button class="btn big primary" data-nav data-key="ab-update" data-zone="body" data-action="update-check">' + icon('refresh') + 'Check for update</button>' +
        '<button class="btn big" data-nav data-key="ab-report" data-zone="body" data-action="tv-report">Copy player report</button></div>' +
        '<p class="field-note" style="margin-top:1.6rem;font-size:1.5rem">Couch TV and Couch Launcher share one version and one update; each installs it for itself.</p>';
    }
    return '<div class="sect-h about-h"><img class="about-logo" src="logo.png" alt=""><div><h2>Couch Launcher</h2><p>Version ' + esc(S.info.version || '') + '</p></div></div><dl class="kv">' +
      '<dt>Games</dt><dd>' + games().length + '</dd><dt>Controllers</dt><dd>' + padCount() + ' connected</dd>' +
      '<dt>Full screen</dt><dd>' + (S.info.windowed ? 'Off (windowed mode)' : 'On') + '</dd></dl>' +
      '<div class="btn-row" style="margin-top:3rem"><button class="btn big primary" data-nav data-key="ab-update" data-zone="body" data-action="update-check">' + icon('refresh') + 'Check for update</button>' +
      '<button class="btn big" data-nav data-key="ab-rescan" data-zone="body" data-action="rescan">' + icon('refresh') + 'Rescan games</button></div>' +
      '<p class="field-note" style="margin-top:2rem;font-size:1.5rem">YouTube’s ad blocker is adapted from VacuumTube by shy (github.com/elytraVIII/VacuumTube), MIT License. Thank you!</p>' +
      '<p class="field-note" style="margin-top:2rem;font-size:1.5rem">To update: put the CouchLauncher-update zip from the chat in your Downloads folder or G:\\launcher. The launcher finds it there.</p>';
  }
  function padKind(id) {
    if (/045e|xbox|xinput/i.test(id)) return 'xbox';
    // Sony pads report vendor 054c; a DualShock 4 may just call itself "Wireless Controller".
    if (/054c|playstation|dualsense|dualshock|^wireless controller/i.test(id)) return 'ps';
    if (/057e|nintendo|pro controller|joy-?con/i.test(id)) return 'nin';
    return 'xbox';
  }
  // Which controller is in each Xbox-style (XInput) slot. The app core reads the maker from the
  // slot itself; Steam Input and DS4Windows put a stand-in there for a PlayStation or Switch pad,
  // so for those the real controller is found here: the one the launcher reads directly whose
  // face button went down at the same moment the slot pressed A.
  const directPress = new Map(); // gamepad key -> { at, id }
  const directFace = new Map();  // gamepad key -> face buttons down last frame
  let directPads = [];           // ids of the controllers read directly (not through XInput)
  const slotDevice = {};         // slot -> { kind, name } found that way
  function directType(id) {
    const m = /vendor:\s*([0-9a-f]{4}).*product:\s*([0-9a-f]{4})/i.exec(id) || [];
    const v = (m[1] || '').toLowerCase(), p = (m[2] || '').toLowerCase();
    if (v === '054c' || padKind(id) === 'ps') {
      if (p === '0ce6') return { kind: 'ps', name: 'DualSense controller' };
      if (p === '0df2') return { kind: 'ps', name: 'DualSense Edge controller' };
      if (p === '05c4' || p === '09cc' || p === '0ba0') return { kind: 'ps', name: 'DualShock 4 controller' };
      return { kind: 'ps', name: 'PlayStation controller' };
    }
    if (v === '057e' || padKind(id) === 'nin') {
      if (p === '2009' || /pro controller/i.test(id)) return { kind: 'nin', name: 'Switch Pro Controller' };
      if (/joy-?con/i.test(id) || p === '2006' || p === '2007' || p === '200e') return { kind: 'joycon', name: 'Joy-Con' };
      return { kind: 'nin', name: 'Nintendo controller' };
    }
    const brands = { '2dc8': '8BitDo', '046d': 'Logitech', '20d6': 'PowerA', '0e6f': 'PDP', '0f0d': 'HORI', '0738': 'Mad Catz', '1532': 'Razer' };
    if (brands[v]) return { kind: 'other', name: brands[v] + ' controller' };
    const bare = String(id).replace(/\s*\(.*$/, '').trim();
    return { kind: 'other', name: bare && bare.length < 40 ? bare : 'Controller' };
  }
  // The launcher's own virtual controllers (Steady players): never counted as real ones.
  const isVirtualPad = (id) => /vendor:\s*1532\b.*product:\s*1000\b/i.test(String(id || ''));
  function noteDirect(pads, now) {
    const ids = [];
    for (const p of pads) {
      if (!p || !p.connected || /xinput/i.test(p.id) || isVirtualPad(p.id)) continue;
      ids.push(p.id);
      const k = p.index + '|' + p.id;
      let face = 0;
      for (let i = 0; i < 4; i++) { const b = p.buttons[i]; if (b && (b.pressed || b.value > 0.5)) face |= 1 << i; }
      if (face & ~(directFace.get(k) || 0)) directPress.set(k, { at: now, id: p.id });
      directFace.set(k, face);
    }
    directPads = ids;
  }
  // The slot just pressed A: was a directly read controller pressed with it?
  // at: when the slot's A press came in. A direct press counts once (it's used up).
  function learnSlot(slot, at) {
    const pd = Array.isArray(S.pads) ? S.pads.find((p) => p.slot === slot) : null;
    // Only a stand-in can be another controller: Steam Input's, or an Xbox 360 / unknown one
    // (DS4Windows shows up as an Xbox 360 controller). An Xbox Series or 8BitDo pad stays that.
    if (pd && pd.name && pd.kind !== 'steam' && !/360|style/i.test(pd.name)) return false;
    let best = null, bestKey = null;
    for (const [k, v] of directPress) {
      const d = Math.abs(v.at - at);
      if (d < 350 && (!best || d < Math.abs(best.at - at))) { best = v; bestKey = k; }
    }
    if (!best) return false;
    directPress.delete(bestKey);
    slotDevice[slot] = directType(best.id);
    return true;
  }
  // { kind, name } for a slot (kind: xbox, ps, nin, steam, other).
  function slotInfo(slot) {
    if (slotDevice[slot]) return slotDevice[slot];
    const pd = Array.isArray(S.pads) ? S.pads.find((p) => p.slot === slot) : null;
    if (pd && pd.kind === 'steam') {
      // One stand-in and one directly read controller: that's the one.
      const steam = S.pads.filter((p) => p.kind === 'steam' && !slotDevice[p.slot]);
      if (steam.length === 1 && directPads.length === 1) return directType(directPads[0]);
      return { kind: 'steam', name: 'Controller via Steam' };
    }
    if (pd && pd.name) return { kind: pd.kind || 'xbox', name: pd.name };
    return { kind: 'xbox', name: 'Controller ' + (slot + 1) };
  }
  // Switch-style player lights: player 1 lights one, player 2 two, and so on.
  const padLights = (n) => '<span class="pp-leds">' + [0, 1, 2, 3].map((i) => '<i class="' + (i < n ? 'on' : '') + '"></i>').join('') + '</span>';
  // Re-render only the right side of Library/Settings (focus stays where it is).
  function refreshContent() {
    const c = $('#content');
    if (!c) return;
    const scroll = c.scrollTop;
    const focusedKey = currentFocus() ? currentFocus().dataset.key : null;
    c.innerHTML = S.view === 'library' ? libraryContentHTML() : settingsContentHTML();
    c.scrollTop = scroll;
    if (S.downloads && S.downloads.length) paintDownloads();
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
    onFocusChanged(el, opts);
  }
  function ensureVisible(el, instant) {
    const sc = el.closest('.row, .hf-row, .fp-games, .content, .fb-list, .side, .flist, .gbody, .home-news, .fprof');
    if (!sc) return;
    const r = el.getBoundingClientRect(), c = sc.getBoundingClientRect();
    const rem = remPx();
    const behavior = instant || reduce() ? 'auto' : 'smooth';
    if (sc.classList.contains('row') || sc.classList.contains('hf-row') || sc.classList.contains('fp-games')) {
      const pad = 5.6 * rem;
      let dx = 0;
      if (r.left < c.left + pad) dx = r.left - (c.left + pad);
      else if (r.right > c.right - pad) dx = r.right - (c.right - pad);
      if (Math.abs(dx) > 1) sc.scrollBy({ left: dx, behavior });
      // Home's lower part (friends, deals, news) scrolls as one: show the whole row, heading too.
      const hn = sc.closest('.home-news'), block = el.closest('.home-friends, .home-deals');
      if (hn && block) {
        const b = block.getBoundingClientRect(), h = hn.getBoundingClientRect();
        let dy = 0;
        if (b.top < h.top) dy = b.top - h.top;
        else if (r.bottom > h.bottom - 3.5 * rem) dy = Math.min(r.bottom - (h.bottom - 3.5 * rem), b.top - h.top);
        if (dy < 0 && hn.scrollTop + dy < 6 * rem) dy = -hn.scrollTop;
        if (Math.abs(dy) > 1) hn.scrollBy({ top: dy, behavior });
      }
    } else {
      const tight = sc.classList.contains('fb-list') || sc.classList.contains('flist') || sc.classList.contains('gbody');
      const top = (tight ? 1 : 4) * rem, bottom = (tight ? 1 : 3.5) * rem;
      // Music controls: keep the whole card (cover and song) in view, not just the buttons.
      const card = el.closest('.gmusic');
      let rTop = card ? card.getBoundingClientRect().top : r.top;
      // The first row of news: its heading comes into view with it.
      const nl = !card && el.closest('.news-list');
      if (nl && nl.previousElementSibling && r.top - nl.getBoundingClientRect().top < 4 * rem) rTop = nl.previousElementSibling.getBoundingClientRect().top + rem;
      let dy = 0;
      if (rTop < c.top + top) dy = rTop - (c.top + top);
      else if (r.bottom > c.bottom - bottom) dy = r.bottom - (c.bottom - bottom);
      // At the top of a list, show its heading too.
      if (dy < 0 && sc.scrollTop + dy < 6 * rem) dy = -sc.scrollTop;
      // Items pinned under the music card (Home): going there shows the whole card again.
      if (el.hasAttribute('data-top') && sc.scrollTop > 0) dy = -sc.scrollTop;
      if (Math.abs(dy) > 1) sc.scrollBy({ top: dy, behavior });
      // A guide laid out sideways (the Spotlight style): bring the item in from the side too.
      if (sc.classList.contains('gbody') && sc.scrollWidth > sc.clientWidth + 1) {
        const pad = 6 * rem;
        let dx = 0;
        if (r.left < c.left + pad) dx = r.left - (c.left + pad);
        else if (r.right > c.right - pad) dx = r.right - (c.right - pad);
        if (dx < 0 && sc.scrollLeft + dx < 8 * rem) dx = -sc.scrollLeft;
        if (Math.abs(dx) > 1) sc.scrollBy({ left: dx, behavior });
      }
    }
  }

  let tabTimer = null;
  function onFocusChanged(el, opts) {
    const newsMode = !layers.length && S.view === 'home' && !!(el && el.closest && el.closest('.home-news'));
    if (!newsMode && $('#app').classList.contains('news-mode') && !layers.length) { const hn = $$('.home-news').pop(); if (hn) hn.scrollTop = 0; } // back up: start at the top next time
    $('#app').classList.toggle('news-mode', newsMode);
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
    if (top && top.onFocus) top.onFocus(el, opts);
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
    noteActivity();
    const top = topLayer();
    if (top && top.onMove && top.onMove(dir, currentFocus())) return true;
    const els = navEls();
    if (!els.length) return false;
    const cur = currentFocus();
    if (!cur) { setFocus(els[0]); return true; }
    // Home's lower part scrolls, so rows above can be out of sight: up stays inside it while
    // there's somewhere to go (instead of jumping to the dock).
    if (dir === 'up' && cur.closest('.home-news')) {
      const inner = findNext(cur, dir, els.filter((e) => e.closest('.home-news')));
      if (inner) { setFocus(inner); return true; }
    }
    // The Shelf style has the dock between the games and the cards: it's the next stop from
    // either, wherever on the row you are.
    if (!top && S.view === 'home' && document.documentElement.classList.contains('style-shelf') && !$('#app').classList.contains('news-mode')) {
      const z = cur.dataset.zone;
      if ((dir === 'down' && z === 'tiles') || (dir === 'up' && z === 'cards')) {
        const dock = els.filter((e) => e.closest('.navpill'));
        const to = dock.find((e) => e.dataset.key === S.zoneMemory.dock) || dock.find((e) => e.classList.contains('active')) || dock[0];
        if (to) { setFocus(to); return true; }
      }
      if (cur.closest('.navpill')) {
        S.zoneMemory.dock = cur.dataset.key;
        if (dir === 'up' || dir === 'down') {
          const zone = dir === 'up' ? 'tiles' : 'cards';
          const row = els.filter((e) => e.dataset.zone === zone);
          const to = row.find((e) => e.dataset.key === S.zoneMemory[zone]) || row[0];
          if (to) { setFocus(to); return true; }
        }
      }
    }
    const next = findNext(cur, dir, els);
    if (next) { setFocus(next); return true; }
    // The sideways guide (Spotlight style): at the end of a row of controls, left / right carry
    // on to the nearest thing in the next column.
    if ((dir === 'left' || dir === 'right') && cur.closest('.gbody') && document.documentElement.classList.contains('style-spotlight')) {
      const c = rectOf(cur);
      let best = null, bestD = Infinity;
      for (const e of els) {
        if (e === cur || !e.closest('.gbody')) continue;
        const r = rectOf(e);
        const gap = dir === 'right' ? r.l - c.r : c.l - r.r;
        if (gap < -1) continue;
        const d = gap * 3 + Math.abs(r.cy - c.cy);
        if (d < bestD) { bestD = d; best = e; }
      }
      if (best) { setFocus(best); return true; }
    }
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
  // opts.email: an @ / .com row · opts.secret: hides what you type (passwords).
  // Shift also turns the number row into symbols.
  const SHIFTED = { 1: '!', 2: '@', 3: '#', 4: '$', 5: '%', 6: '^', 7: '&', 8: '*', 9: '(', 0: ')', '-': '_', '.': ',', "'": '"' };
  const shiftOf = (k) => (SHIFTED[k] != null ? SHIFTED[k] : k.length === 1 ? k.toUpperCase() : k);
  // On-screen keyboard. Console style: letters / symbols pages, one-tap Shift (double-tap for
  // caps lock), rows wrap around at the ends, and button shortcuts:
  //   X delete (hold to keep deleting) · Y space · LB/RB move the cursor · LT Shift · RT symbols · ☰ done.
  // opts: { email, secret, suggest(text) -> [strings] (picking one finishes) }
  function osk(title, value, placeholder, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      let result = null;
      let shift = false, caps = false, sym = false, lastShiftAt = 0;
      const LETTERS = ['1234567890'.split(''), 'qwertyuiop'.split(''), "asdfghjkl'".split(''), ['SHIFT'].concat('zxcvbnm'.split(''), ['-', '.'])];
      const SYMBOLS = ['1234567890'.split(''), '!@#$%^&*()'.split(''), ['-', '_', '=', '+', ':', ';', '"', "'", '/', '?'], ['SHIFT', '[', ']', '{', '}', '<', '>', '\\', ',', '.']];
      const special = {
        SHIFT: () => '<button class="key wide' + (caps ? ' on lock' : shift ? ' on' : '') + '" data-nav data-key="k-shift" data-k="SHIFT" aria-label="Shift">' + icon('shift') + '</button>',
        SYM: () => '<button class="key w2' + (sym ? ' on' : '') + '" data-nav data-key="k-sym" data-k="SYM"><small>' + (sym ? 'abc' : '&amp;123') + '</small></button>',
        BKSP: () => '<button class="key w2" data-nav data-key="k-bksp" data-k="BKSP" aria-label="Backspace">' + icon('bksp') + '</button>',
        SPACE: () => '<button class="key w5" data-nav data-key="k-space" data-k="SPACE"><small>Space</small></button>',
        LEFT: () => '<button class="key" data-nav data-key="k-left" data-k="LEFT" aria-label="Cursor left">‹</button>',
        RIGHT: () => '<button class="key" data-nav data-key="k-right" data-k="RIGHT" aria-label="Cursor right">›</button>',
        DONE: () => '<button class="key w2 done" data-nav data-key="k-done" data-k="DONE"><small>Done</small></button>'
      };
      const label = (k) => (shift || caps ? shiftOf(k) : k);
      function rows() {
        const r = (sym ? SYMBOLS : LETTERS).map((row) => row.slice());
        if (opts.email && !sym) r.push(['@', '.com', '_', '+', '/', ':']);
        r.push(['SYM', 'LEFT', 'SPACE', 'RIGHT', 'BKSP', 'DONE']);
        return r;
      }
      const keysHTML = () => rows().map((row, ri) => '<div class="krow">' + row.map((k, ci) => special[k] ? special[k]()
        : '<button class="key" data-nav data-key="k-' + ri + '-' + ci + '" data-k="' + esc(k) + '">' + esc(label(k)) + '</button>').join('') + '</div>').join('');
      const layer = openLayer({
        className: 'osk-layer',
        html: '<div class="dialog osk"><div class="osk-top"><h2>' + esc(title) + '</h2><span class="osk-count"></span></div>' +
          '<input class="osk-input" type="' + (opts.secret ? 'password' : 'text') + '" spellcheck="false" autocomplete="off" maxlength="200" placeholder="' + esc(placeholder || '') + '" aria-label="' + esc(title) + '">' +
          '<div class="osk-sugg"></div><div class="keys">' + keysHTML() + '</div>' +
          '<div class="osk-help">' + glyph('X') + 'Delete ' + glyph('Y') + 'Space ' + glyph('LB') + glyph('RB') + 'Cursor ' + glyph('LT') + 'Shift ' + glyph('RT') + 'Symbols ' + glyph('MENU') + 'Done</div></div>',
        focus: 'k-1-0',
        repeat: ['X', 'LB', 'RB'],
        onActivate: (el) => { if (el.dataset.sugg != null) return pick(el.dataset.sugg); press(el.dataset.k); },
        onBack: () => closeLayer(layer),
        // Rows wrap around: left from the first key goes to the last one, and the other way.
        onMove: (dir, el) => {
          if (!el || !el.classList.contains('key') || (dir !== 'left' && dir !== 'right')) return false;
          const row = Array.from(el.parentElement.children);
          const i = row.indexOf(el);
          if (dir === 'left' && i === 0) { setFocus(row[row.length - 1]); return true; }
          if (dir === 'right' && i === row.length - 1) { setFocus(row[0]); return true; }
          return false;
        },
        onButton: (b) => {
          if (b === 'X') { press('BKSP'); return true; }
          if (b === 'Y') { press('SPACE'); return true; }
          if (b === 'MENU') { press('DONE'); return true; }
          if (b === 'LB') { press('LEFT'); return true; }
          if (b === 'RB') { press('RIGHT'); return true; }
          if (b === 'VIEW' || b === 'LT') { press('SHIFT'); return true; }
          if (b === 'RT') { press('SYM'); return true; }
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
          if (e.target === input) setTimeout(changed, 0);
          return false;
        },
        onClose: () => resolve(result),
        prompts: () => S.input === 'pad'
          ? [['A', 'Type'], ['B', 'Cancel']]
          : [['A', 'Done'], ['B', 'Cancel']]
      });
      const input = $('.osk-input', layer.el);
      const keysEl = $('.keys', layer.el), suggEl = $('.osk-sugg', layer.el), countEl = $('.osk-count', layer.el);
      input.value = value || '';
      const caretEnd = () => { const n = input.value.length; try { input.setSelectionRange(n, n); } catch (_) { /* ignore */ } };
      caretEnd();
      setTimeout(() => { input.focus({ preventScroll: true }); caretEnd(); }, 30);
      input.addEventListener('input', () => changed());
      let sugTimer = null;
      function changed() {
        countEl.textContent = opts.secret || input.value.length < 150 ? '' : input.value.length + ' / 200'; // only near the limit
        if (!opts.suggest) return;
        clearTimeout(sugTimer);
        sugTimer = setTimeout(() => {
          const list = (opts.suggest(input.value) || []).slice(0, 5);
          const f = currentFocus();
          const keep = f && f.dataset.sugg != null ? f.dataset.key : null;
          suggEl.innerHTML = list.map((t, i) => '<button class="osk-chip" data-nav data-key="sg-' + i + '" data-sugg="' + esc(t) + '">' + icon('search') + '<span>' + esc(t) + '</span></button>').join('');
          if (keep) { const el = $('[data-key="' + keep + '"]', suggEl) || $('[data-nav]', suggEl) || $('[data-key="k-1-0"]', keysEl); if (el) setFocus(el, { instant: true }); }
        }, 60);
      }
      changed();
      function redrawKeys() {
        const f = currentFocus();
        const key = f && f.dataset.key;
        keysEl.innerHTML = keysHTML();
        const el = key && $('[data-key="' + cssEsc(key) + '"]', layer.el);
        if (el) setFocus(el, { instant: true });
        else if (f && keysEl.contains(f) === false && f.dataset.sugg == null) setFocus($('[data-key="k-1-0"]', keysEl), { instant: true });
      }
      function insert(text) {
        const s0 = input.selectionStart == null ? input.value.length : input.selectionStart;
        const e0 = input.selectionEnd == null ? s0 : input.selectionEnd;
        if ((input.value.length - (e0 - s0) + text.length) > 200) return;
        input.value = input.value.slice(0, s0) + text + input.value.slice(e0);
        const p2 = s0 + text.length;
        try { input.setSelectionRange(p2, p2); } catch (_) { /* ignore */ }
        changed();
      }
      function bump(el) { if (!el || reduce()) return; el.classList.remove('hit'); void el.offsetWidth; el.classList.add('hit'); }
      function pick(text) { input.value = text; result = text.trim(); closeLayer(layer); }
      function press(k) {
        bump($('[data-k="' + cssEsc(k) + '"]', layer.el));
        if (k === 'DONE') { result = input.value.trim(); closeLayer(layer); return; }
        if (k === 'SHIFT') {
          const t = Date.now();
          if (caps) { caps = false; shift = false; }
          else if (shift && t - lastShiftAt < 450) { caps = true; } // double tap: caps lock
          else shift = !shift;
          lastShiftAt = t;
          redrawKeys();
          return;
        }
        if (k === 'SYM') { sym = !sym; redrawKeys(); return; }
        const pos = () => (input.selectionStart == null ? input.value.length : input.selectionStart);
        if (k === 'LEFT' || k === 'RIGHT') {
          const n = Math.max(0, Math.min(input.value.length, pos() + (k === 'LEFT' ? -1 : 1)));
          try { input.focus({ preventScroll: true }); input.setSelectionRange(n, n); } catch (_) { /* ignore */ }
          return;
        }
        if (k === 'BKSP') {
          const s0 = pos();
          const e0 = input.selectionEnd == null ? s0 : input.selectionEnd;
          if (s0 !== e0) { input.value = input.value.slice(0, s0) + input.value.slice(e0); try { input.setSelectionRange(s0, s0); } catch (_) { /* ignore */ } }
          else if (s0 > 0) { input.value = input.value.slice(0, s0 - 1) + input.value.slice(s0); try { input.setSelectionRange(s0 - 1, s0 - 1); } catch (_) { /* ignore */ } }
          changed();
          return;
        }
        if (k === 'SPACE') { insert(' '); return; }
        insert(shift || caps ? shiftOf(k) : k);
        // Shift is for one letter (unless caps lock is on).
        if (shift && !caps) { shift = false; redrawKeys(); }
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
  // Mac: apps (Name.app) and shell scripts are the programs you pick.
  const PICK_EXTS = IS_MAC ? ['.app', '.exe', '.command', '.sh'] : ['.exe', '.lnk', '.url', '.bat'];
  function targetFromFile(p) {
    const ext = extOf(p);
    const E = S.info.emulators || {};
    if (baseName(p).toUpperCase() === 'EBOOT.BIN') return { launch: { type: 'emu', emu: 'rpcs3', file: p }, source: 'rpcs3', title: ps3Title(p) };
    if (ext === '.exe' || (IS_MAC && ext === '.app')) return { launch: { type: 'exe', exe: p }, source: 'custom', title: cleanTitle(baseName(p).replace(/\.app$/i, '')) };
    if (IS_MAC && ['.command', '.sh'].includes(ext)) return { launch: { type: 'open', path: p }, source: 'custom', title: cleanTitle(baseName(p)) };
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

  // ---- "Who's playing?": each friend presses A on their controller, in player order.
  async function setUpPlayers(g) {
    let mode = S.lib.settings.pickPlayers || 'saved';
    if (mode === 'auto' || mode === 'always') mode = 'ask'; // older names
    if (mode === 'off' || IS_MAC) return true; // Mac: emulators keep their own controller setup
    const pads = Array.isArray(S.pads) ? S.pads : null;
    const n = pads ? pads.length : padCount();
    if (mode === 'saved') {
      // The players from Settings › Controllers, minus any controller that isn't connected now.
      const saved = (S.lib.settings.playerSlots || []).filter((sl) => !pads || pads.some((p) => p.slot === sl));
      if (saved.length) { try { await api.playersSet(g.id, saved); } catch (e) { toast(e.message, true); } }
      else if (n === 1) { try { await api.playersSolo(g.id); } catch (_) { /* leave as is */ } }
      return true;
    }
    if (n < 2) {
      if (n === 1) { try { await api.playersSolo(g.id); } catch (_) { /* leave as is */ } }
      return true;
    }
    const slots = await whoIsPlaying(g, pads);
    if (slots === null) return false;
    if (slots.length) {
      try { const k = await api.playersSet(g.id, slots); toast(k + (k === 1 ? ' player' : ' players') + ' set up'); }
      catch (e) { toast(e.message, true); }
    }
    return true;
  }
  function playersLabel() {
    const sl = S.lib.settings.playerSlots || [];
    if (!sl.length) return 'Not set up yet: everyone presses A once, and emulator games use those players';
    return sl.map((x, i) => {
      const on = Array.isArray(S.pads) && S.pads.some((p) => p.slot === x);
      const nm = on ? slotInfo(x).name : '';
      return 'P' + (i + 1) + ': Controller ' + (x + 1) + (nm && !/^Controller \d/.test(nm) ? ' (' + nm.replace(/ controller$/i, '') + ')' : '');
    }).join(' · ');
  }
  // Settings › Controllers › Players (also in the guide): pick once, used for every emulator game.
  async function setUpPlayersNow() {
    const pads = Array.isArray(S.pads) ? S.pads : null;
    const slots = await whoIsPlaying({ title: 'Saved for every emulator game', setup: true }, pads);
    if (!slots || !slots.length) return;
    S.lib.settings.playerSlots = slots;
    save();
    if (S.view === 'settings') refreshContent();
    toast(slots.length + (slots.length === 1 ? ' player' : ' players') + ' saved');
  }
  // Settings › Controllers › Phone remote: the QR code to scan, on / off, a new link.
  async function phoneRemote() {
    let info;
    try { info = await api.phoneInfo(); } catch (e) { toast(e.message, true); return; }
    const body = () => {
      if (!info.on) return '<p class="hint">Turn it on, then scan the code with your phone’s camera. Your phone has to be on the same Wi-Fi as this PC. The first time, Windows may ask whether Couch Launcher can use the network: choose <b>Private networks</b> and Allow.</p>';
      if (!info.url) return '<p class="hint">' + (info.running ? 'This PC doesn’t seem to be on a home network right now (no Wi-Fi or cable address found).' : 'The remote couldn’t start. Try turning it off and on.') + '</p>';
      let qr = '';
      try { qr = window.CouchQR.qrSVG(info.url); } catch (_) { qr = ''; }
      return '<div class="phone-qr">' + qr + '<div class="phone-side"><p>Scan with your phone’s camera, or open this on your phone:</p><div class="phone-url">' + esc(info.url) + '</div>' +
        '<p class="hint">Keep the page on your phone’s home screen for next time (Share › Add to Home Screen). Anyone with this link on your Wi-Fi can use it: make a new link to lock old ones out.</p></div></div>';
    };
    const html = () => '<div class="dialog phone-remote"><h2>Phone remote</h2>' + body() + '<div class="dialog-foot">' +
      (info.on ? '<button class="btn big" data-nav data-key="pr-new" data-act="new">' + icon('refresh') + 'New link</button><button class="btn big" data-nav data-key="pr-off" data-act="off">Turn off</button>'
        : '<button class="btn big primary" data-nav data-key="pr-on" data-act="on">Turn on</button>') +
      '<button class="btn big" data-nav data-key="pr-close" data-act="close">Close</button></div></div>';
    const layer = openLayer({
      html: html(), focus: info.on ? 'pr-close' : 'pr-on',
      onActivate: async (el) => {
        const act = el.dataset.act;
        if (act === 'close') return closeLayer(layer);
        try {
          if (act === 'on') info = await api.phoneSet(true);
          else if (act === 'off') info = await api.phoneSet(false);
          else if (act === 'new') { info = await api.phoneNewLink(); toast('New link made. Scan the new code on your phone'); }
        } catch (e) { toast(e.message, true); return; }
        S.lib.settings.phoneRemote = info.on;
        layer.el.innerHTML = html();
        setFocus($('[data-key="' + (info.on ? (act === 'new' ? 'pr-new' : 'pr-close') : 'pr-on') + '"]', layer.el) || $('[data-nav]', layer.el), { instant: true });
      },
      onBack: () => closeLayer(layer),
      onClose: () => { if (S.view === 'settings') refreshContent(); },
      prompts: () => [['A', 'Select'], ['B', 'Close']]
    });
  }
  // Settings › Controllers › Steady players in Ryujinx.
  async function steadyMenu() {
    let st;
    try { st = await api.vpadsStatus(); } catch (e) { toast(e.message, true); return; }
    const s = S.lib.settings;
    const items = [];
    if (!st.installed) items.push({ id: 'install', label: 'Install ViGEmBus (free driver; Windows asks once)', icon: 'download' });
    else {
      if (st.ryujinx) items.push({ id: 'learn', label: st.learned ? 'Set up with Ryujinx again' : 'Set up with Ryujinx (once, about a minute)', icon: 'gear' });
      items.push({ id: 'test', label: 'Try the virtual controllers', icon: 'pad' });
      if (st.learned) items.push({ id: 'toggle', label: s.steadyPlayers ? 'Turn off' : 'Turn on', icon: s.steadyPlayers ? 'x' : 'check' });
    }
    const pick = await openMenu('Steady players' + (st.installed ? (st.learned ? (s.steadyPlayers ? ' · On' : ' · Off') : ' · Not set up with Ryujinx') : ''), items);
    if (pick === 'install') {
      toast('Downloading ViGEmBus… Windows will ask for permission: say Yes and follow the setup');
      try { const ok = await api.vpadsInstall(); toast(ok ? 'ViGEmBus is installed' : 'ViGEmBus setup closed without installing', !ok); if (ok) steadyMenu(); }
      catch (e) { toast(e.message, true); }
    } else if (pick === 'toggle') {
      s.steadyPlayers = !s.steadyPlayers; save(); refreshContent();
      toast(s.steadyPlayers ? 'Steady players on: used for Ryujinx games with your saved players' : 'Steady players off');
    } else if (pick === 'test') steadyLive(false);
    else if (pick === 'learn') steadyLive(true);
  }
  // The virtual controllers plugged in until this closes. learn: the Ryujinx steps.
  async function steadyLive(learn) {
    const slots = (S.lib.settings.playerSlots || []).filter((sl) => !Array.isArray(S.pads) || S.pads.some((p) => p.slot === sl));
    const use = slots.length ? slots : (Array.isArray(S.pads) && S.pads.length ? [S.pads[0].slot] : [null]);
    try { await api.vpadsTest(learn ? use.slice(0, 1) : use); } catch (e) { toast(e.message, true); return; }
    let state = [];
    const rows = () => (state.length ? state : use.map((sl, i) => ({ p: i + 1, slot: sl, on: sl != null }))).map((x) =>
      '<div class="prow"><div class="picon" style="background:var(--accent);color:var(--on-accent)">P' + x.p + '</div><div class="pinfo"><div class="t">Couch Player ' + x.p + '</div><div class="p">' +
      (x.slot != null ? esc(slotInfo(x.slot).name) + ' · Controller ' + (x.slot + 1) : 'No controller') + '</div></div><span class="status ' + (x.on ? 'ok' : '') + '">' + (x.on ? 'Connected' : 'Waiting for a controller') + '</span></div>').join('');
    const body = learn
      ? '<ol class="steps"><li>Open Ryujinx › Options › Settings › Input.</li><li>For Player 1, pick the controller that just appeared (a <b>PS4-style controller</b>). Press a button: Ryujinx shows it moving.</li><li>Click Save, close Ryujinx, then come back and choose <b>Done</b>.</li></ol>'
      : '<p class="hint">Turn a player’s controller off and on: it comes back to the same player. A controller nobody is using joins a free spot by pressing A.</p>';
    const html = () => '<div class="dialog steady"><h2>' + (learn ? 'Set up with Ryujinx' : 'Virtual controllers') + '</h2>' + body + '<div class="pad-list">' + rows() + '</div>' +
      '<div class="dialog-foot"><button class="btn big" data-nav data-key="vs-stop" data-act="stop">' + (learn ? 'Cancel' : 'Unplug them') + '</button>' +
      (learn ? '<button class="btn big primary" data-nav data-key="vs-done" data-act="done">' + icon('check') + 'Done</button>' : '') + '</div></div>';
    const layer = openLayer({
      html: html(), focus: learn ? 'vs-done' : 'vs-stop',
      onActivate: async (el) => {
        if (el.dataset.act === 'done') {
          try { await api.vpadsLearn(); S.lib.settings.steadyPlayers = true; save(); toast('Ryujinx is set up. Steady players is on'); closeLayer(layer); }
          catch (e) { toast(e.message, true); }
          return;
        }
        closeLayer(layer);
      },
      onBack: () => closeLayer(layer),
      onClose: () => { S.onVpads = null; api.vpadsStop().catch(() => {}); if (S.view === 'settings') refreshContent(); },
      prompts: () => (learn ? [['A', 'Select'], ['B', 'Cancel']] : [['A', 'Select'], ['B', 'Unplug them']])
    });
    S.onVpads = (st) => { state = st || []; const list = $('.steady .pad-list', layer.el); if (list) list.innerHTML = rows(); };
  }
  function whoIsPlaying(g, pads) {
    return new Promise((resolve) => {
      const joined = [];
      let result = null, startTimer = null;
      const card = (i) => {
        const slot = joined[i];
        const pd = pads && slot != null ? pads.find((p) => p.slot === slot) : null;
        const info = slot != null ? slotInfo(slot) : null;
        return '<div class="pp' + (slot != null ? ' in' : '') + '"><div class="pp-n">Player ' + (i + 1) + '</div>' +
          (slot != null ? padLights(i + 1) + '<div class="pp-c pp-dev k-' + info.kind + '" data-slot="' + slot + '"><span class="pp-d"><b>' + esc(info.name) + '</b>' + (/^Controller \d/.test(info.name) ? '' : '<small>Controller ' + (slot + 1) + '</small>') + '</span>' + (pd ? batteryHTML(pd) : '') + '</div>'
            : '<div class="pp-c wait"><span>Press</span>' + glyph('A') + '<span>to join</span></div>') + '</div>';
      };
      const html = () => '<div class="dialog whoplays"><h2>Who’s playing?</h2><p class="hint">' + esc(g.title) +
        ' · Everyone presses <b>A</b> on their controller, in player order.' + (pads ? ' ' + pads.length + ' controller' + (pads.length === 1 ? '' : 's') + ' connected.' : '') + '</p>' +
        '<div class="pp-grid">' + [0, 1, 2, 3].map(card).join('') + '</div>' +
        '<div class="dialog-foot">' + (g.setup ? '<button class="btn big" data-nav data-key="wp-keep" data-act="cancel">Cancel</button>' : '<button class="btn big" data-nav data-key="wp-keep" data-act="keep">Keep usual setup</button>') +
        '<button class="btn big primary" data-nav data-key="wp-go" data-act="go">' + icon(g.setup ? 'check' : 'play') + (g.setup ? 'Save' : 'Start') + '</button></div></div>';
      const draw = () => { $('.whoplays', layer.el).outerHTML = html(); setFocus($('[data-key="wp-go"]', layer.el), { instant: true }); };
      const done = (r) => { result = r; clearTimeout(startTimer); closeLayer(layer); };
      const join = (slot) => {
        if (joined.includes(slot) || joined.length >= 4) return;
        joined.push(slot);
        // Which controller it is: the one pressed with it may only show up a moment later.
        const at = performance.now();
        if (!learnSlot(slot, at)) setTimeout(() => { if (!result && joined.includes(slot) && learnSlot(slot, at)) draw(); }, 360);
        draw();
        // Everyone's in: start on its own.
        if (pads && joined.length >= pads.length) { clearTimeout(startTimer); startTimer = setTimeout(() => done(joined.slice()), 900); }
      };
      const layer = openLayer({
        html: html(),
        focus: 'wp-go',
        // Controller buttons are handled here: A presses come from the app core, which knows
        // which controller pressed them.
        onButton: (b) => {
          if (b === 'A') { if (!pads) join(joined.length); return true; }
          if (b === 'MENU') { if (joined.length) done(joined.slice()); return true; }
          if (b === 'Y') { if (!g.setup) done([]); return true; }
          if (b === 'X') { joined.length = 0; clearTimeout(startTimer); draw(); return true; }
          if (b === 'B') { done(null); return true; }
          return true;
        },
        onActivate: (el) => { if (el.dataset.act === 'cancel') done(null); else if (el.dataset.act === 'keep') done([]); else if (el.dataset.act === 'go') { if (joined.length) done(joined.slice()); else toast('Press A on a controller to join first'); } },
        onBack: () => done(null),
        onClose: () => { S.onPadA = null; api.playersListen(false).catch(() => {}); resolve(result); },
        prompts: () => (g.setup ? [['A', 'Join'], ['MENU', 'Save'], ['X', 'Start over'], ['B', 'Cancel']] : [['A', 'Join'], ['MENU', 'Start'], ['Y', 'Keep usual setup'], ['X', 'Start over'], ['B', 'Cancel']])
      });
      S.onPadA = join;
      api.playersListen(true).catch(() => {});
    });
  }

  async function play(id, extra) {
    extra = extra || {};
    const g = byId(id);
    if (!g) return;
    if (S.playing) {
      if (S.playing.id === id && !layers.some((l) => l.className === 'launching')) { resumeGame(); return; }
      let st = null;
      try { st = await api.gameStatus(); } catch (_) { /* treat as nothing running */ }
      if (st && st.canClose) { await switchTo(id, extra); return; }
      try { await api.cancelLaunch(); } catch (_) { /* ignore */ }
      S.playing = null;
    }
    if (g.launch && g.launch.type === 'emu' && !(await setUpPlayers(g))) return; // cancelled on "Who's playing?"
    // Dolphin, RetroArch, DuckStation, PCSX2: offer the state saved when you last closed it.
    const opts = {};
    if (extra.join) opts.join = extra.join; // straight into a friend's lobby
    if (g.launch && g.launch.type === 'emu' && ['dolphin', 'retroarch', 'duckstation', 'pcsx2'].includes(g.launch.emu) && S.lib.settings.saveStates !== false) {
      let info = null;
      try { info = await api.savedState(id); } catch (_) { info = null; }
      if (info) opts.resume = await confirmBox('Pick up where you left off?', 'There’s a save from when you closed ' + g.title + (info.at ? ' (' + fmtWhen(info.at).replace(/^Played /, '').toLowerCase() + ')' : '') + '. Start over loads your normal in-game save instead.', 'Resume', false, { cancelLabel: 'Start over', focusOk: true });
    }
    S.playing = { id, tracked: null, at: Date.now() };
    // Where the game's tile is, so the boot screen can grow out of it.
    const fromEl = currentFocus();
    const fromRect = fromEl && fromEl.dataset.game === id && !reduce() ? fromEl.getBoundingClientRect() : null;
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
    if (fromRect && fromRect.width) {
      const W = window.innerWidth, H = window.innerHeight, r = fromRect;
      layer.el.animate([
        { clipPath: 'inset(' + r.top + 'px ' + (W - r.right) + 'px ' + (H - r.bottom) + 'px ' + r.left + 'px round 1.6rem)' },
        { clipPath: 'inset(0px 0px 0px 0px round 0px)' }
      ], { duration: 480, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
    async function cancelLaunch() {
      // Always leave the boot screen right away; the app core closes whatever had started.
      if (S.playing && S.playing.id === id) S.playing = null;
      closeLayer(layer);
      try { await api.cancelLaunch(); } catch (_) { /* ignore */ }
    }
    await wait(reduce() ? 0 : 600);
    if (!S.playing || S.playing.id !== id) return;
    try {
      const r = await enqueue(() => api.launch(id, opts));
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
    if (payload && payload.wrongMonitor && g) offerMainMonitor(g);
  }
  // A game played on Windows' main monitor instead of the chosen one: offer the fix for next time.
  async function offerMainMonitor(g) {
    await new Promise((r) => setTimeout(r, 700));
    const ok = await confirmBox(g.title + ' opened on your other monitor', 'It wouldn’t move to this screen. Next time, the launcher can make this screen the main monitor while ' + g.title + ' runs, so it opens here (your screens blink once when it starts and once when it ends).', 'Do that for this game', false, { cancelLabel: 'No thanks', focusOk: true });
    if (ok) { g.display = Object.assign({}, g.display || {}, { main: true }); save(); toast('Done. ' + g.title + ' will open on this screen'); }
    else { g.display = Object.assign({}, g.display || {}, { main: false }); save(); }
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

  // ----- Settings › Controllers › Test the Share button (Medal)
  function shareTest() {
    let d = null, err = null, timer = null, pressed = false, msg = '', learning = false;
    const hex = (a) => (a || []).map((x) => (x | 0).toString(16).padStart(2, '0')).join(' ');
    const pidHex = (n) => (n | 0).toString(16).toUpperCase().padStart(4, '0');
    const body = () => {
      if (err) return '<p class="hint">' + esc(err) + '</p>';
      if (!d) return '<p class="hint">Looking for your controller…</p>';
      const x = d.xbox[0];
      let h = '<dl class="kv">';
      h += '<dt>Share button for Medal</dt><dd>' + (d.on ? 'On' : 'Off (Settings › Controllers)') + ' · ' + esc({ auto: 'Share and View combo', share: 'Share button', combo: 'View + RB / LB' }[d.mode] || d.mode) + '</dd>';
      h += '<dt>Xbox controller over Bluetooth</dt><dd>' + (x ? 'Found (model ' + pidHex(x.pid) + ', ' + x.size + '-byte reports, ' + x.reports + ' read)' : 'Not found' + (d.otherMicrosoft.length ? ' (other Xbox controllers seen: ' + d.otherMicrosoft.map(pidHex).join(', ') + ')' : '') + '. Over USB or the Xbox adapter, Windows doesn’t share the Share button: use View + RB.') + '</dd>';
      if (x) {
        if (x.buttons) h += '<dt>Last button change</dt><dd class="mono">' + esc(ago(x.buttons.at) + ' · from byte ' + x.buttons.from + ': ' + x.buttons.bytes.join(' ')) + '</dd>';
        const L = d.learn;
        const known = x.windowsReport ? x.learned : (x.shareAt != null ? { byte: x.shareAt } : null);
        let state;
        if (x.share) state = 'Pressed';
        else if (L && L.waiting) state = 'Press and hold Share now, and only Share…';
        else if (known) state = 'Not pressed (found at byte ' + known.byte + ')';
        else if (x.windowsReport) state = 'Not found yet: choose Find Share below';
        else state = 'Press it once, with no other buttons held, so the launcher can find it';
        h += '<dt>Share button</dt><dd class="' + (x.share ? 'st-yes' : '') + '">' + esc(state) + '</dd>';
        const changed = x.first && x.last ? x.last.map((v, i) => (v !== x.first[i] ? i + ': ' + v : null)).filter(Boolean) : [];
        h += '<dt>Report</dt><dd class="mono">' + esc(hex(x.last)) + '</dd><dt>Changed since start</dt><dd class="mono">' + esc(changed.join(' · ') || 'nothing yet') + '</dd>';
      }
      h += '<dt>Medal keys</dt><dd>Clip ' + esc(d.clipKey) + ' · Screenshot ' + esc(d.shotKey || 'not set') + (d.lastPress ? ' · last sent: ' + esc(d.lastPress.kind) + ' ' + ago(d.lastPress.at) : '') + '</dd>';
      if (d.shotKey && d.shotKey === d.clipKey) h += '<dt></dt><dd class="bk-why">' + esc('The clip and screenshot keys are both ' + d.clipKey + ', so a tap saves a clip too. Give Medal’s screenshot a different key, then pick it here.') + '</dd>';
      // The last press outside this screen (in a game), and what happened to it.
      const c = d.lastCapture;
      if (c) {
        const WHY = { off: 'not sent: Share button for Medal is off', guide: 'not sent: the guide was open', launcher: 'not sent: the launcher was in front' };
        const front = c.front && c.front.exe ? ' (in ' + c.front.exe + ')' : '';
        let res = c.why ? WHY[c.why] || c.why : c.sent ? 'sent the ' + c.sent + ' key' : (c.what === 'Share' ? 'held too briefly for a clip, or no screenshot key' : 'not sent');
        h += '<dt>Last press</dt><dd>' + esc(c.what + front + (c.via === 'background' ? ' via the background reader' : '') + ', ' + ago(c.at) + ': ' + res) + '</dd>';
        if (c.hid) h += '<dt></dt><dd class="mono">' + esc('Bluetooth data at that moment: ' + (c.hid.age == null ? 'none' : 'last report ' + (c.hid.age < 1000 ? c.hid.age + ' ms' : Math.round(c.hid.age / 1000) + ' s') + ' before') + (c.hid.buttons ? ' · last button change ' + ago(c.hid.buttons.at) + ' (from byte ' + c.hid.buttons.from + '): ' + c.hid.buttons.bytes.join(' ') : '')) + '</dd>';
        if (c.front && c.front.elevated && !c.front.selfElevated) h += '<dt></dt><dd class="bk-why">' + esc(c.front.exe + ' runs as administrator, so Windows doesn’t let the launcher press keys in it (Medal never sees them). Start the game normally, or run Couch Launcher as administrator too.') + '</dd>';
      } else h += '<dt>Last press</dt><dd>' + esc('None yet: hold Share in a game, then come back here') + '</dd>';
      // The background reader (reads Share while a game is in front).
      const R = d.raw;
      if (R) {
        const rs = R.off ? (R.wanted ? 'Starting…' : 'Off: it starts once Share has been found (Find Share), with Share on for Medal')
          : R.error ? 'Couldn’t start: ' + R.error
          : !R.running ? 'Not running (restarts by itself)'
          : !R.ready ? 'Starting…'
          : R.share ? 'Running · Share pressed'
          : 'Running · ' + R.reports + ' reports' + (R.pad ? ' · ' + R.pad.size + '-byte, last ' + ago(R.pad.at) : ' · no Xbox controller seen yet: move a stick');
        h += '<dt>Background reader</dt><dd class="' + (R.share ? 'st-yes' : '') + '">' + esc(rs) + '</dd>';
      }
      // What the controller sent while a game was in front (moving the sticks sends dozens of
      // reports a second, so a handful means Windows held the data back).
      const a = d.away;
      if (a && a.secs >= 3) {
        const rate = a.reports / a.secs;
        let what;
        if (!a.reports) what = 'nothing came from the controller';
        else if (a.blanks >= a.reports * 0.95) what = 'only blank data (sticks centered, nothing pressed)';
        else what = (rate < 1 ? 'less than 1' : Math.round(rate)) + ' a second' + (rate < 5 ? ': if you were moving the sticks, Windows held the controller back from the launcher' : '');
        h += '<dt>While a game was in front</dt><dd>' + esc(a.exe + ' for ' + (a.secs < 120 ? a.secs + ' s' : Math.round(a.secs / 60) + ' min') + ', ' + ago(a.at) + ': ' + a.reports + ' reports, ' + what) + '</dd>';
        if (d.raw && !d.raw.off) h += '<dt></dt><dd class="mono">' + esc('Background reader in that time: ' + (a.raw || 0) + ' reports' + (a.raw ? '' : ' (Windows held it back too)')) + '</dd>';
      }
      h += '</dl>';
      if (msg) h += '<p class="hint">' + esc(msg) + '</p>';
      return h;
    };
    const layer = openLayer({
      html: '<div class="dialog sharetest"><h2>Test the Share button</h2><div class="st-body">' + body() + '</div>' +
        '<div class="dialog-foot"><button class="btn big" data-nav data-key="t-close" data-act="close">Close</button>' +
        '<button class="btn big" data-nav data-key="t-learn" data-act="learn">' + icon('search') + 'Find Share</button>' +
        '<button class="btn big primary" data-nav data-key="t-clip" data-act="clip">' + icon('film') + 'Send Medal a test clip in 3 s</button></div></div>',
      focus: 't-clip',
      onActivate: async (el) => {
        if (el.dataset.act === 'close') return closeLayer(layer);
        if (el.dataset.act === 'learn') {
          learning = true;
          try { await api.captureLearn(); } catch (e) { msg = e.message; draw(); return; }
          msg = 'Press and hold Share now, and nothing else (15 seconds).';
          draw();
          return;
        }
        msg = 'Sending in 3 seconds… switch to a game if you like (Alt+Tab). Medal should show its “Clip saved” pop-up.';
        draw();
        setTimeout(async () => { try { const ok = await api.captureTest('clip'); msg = ok ? 'Sent ' + (d ? d.clipKey : 'the clip key') + '. If Medal didn’t save a clip, its clip key isn’t ' + (d ? d.clipKey : 'that') + ' (Medal › Settings › Capture Hotkeys), or Medal isn’t running.' : 'Couldn’t send the key on this ' + PCW + '.'; } catch (e) { msg = e.message; } draw(); }, 3000);
      },
      onBack: () => closeLayer(layer),
      onClose: () => clearInterval(timer),
      prompts: () => [['A', 'Select'], ['B', 'Close']]
    });
    function draw() { const b = $('.st-body', layer.el); if (b) b.innerHTML = body(); }
    async function poll() {
      try { d = await api.captureDebug(); err = null; } catch (e) { err = e.message; }
      if (layers.indexOf(layer) < 0) return;
      const x = d && d.xbox && d.xbox[0];
      if (learning && d && d.learn) {
        if (d.learn.found) { learning = false; msg = 'Found Share and saved it. In a game, hold it for a clip (tap for a screenshot).'; }
        else if (d.learn.timedOut) { learning = false; msg = 'Nothing came through when Share was pressed: on this ' + PCW + ', Windows keeps the Share button for itself over Bluetooth. Use View + RB for a clip and View + LB for a screenshot (they always work in Auto).'; }
      }
      if (x && x.share && !pressed) { pressed = true; msg = 'Share seen. In a game, hold it for a clip (tap for a screenshot).'; }
      draw();
    }
    poll();
    timer = setInterval(poll, 200);
  }
  // Why a backup didn't happen, in words.
  function backupWhy(r) {
    if (!r) return '';
    if (r.error) return 'it didn’t work (' + r.error + ')';
    return { off: 'backups are off', 'no-saves': 'its save folder wasn’t found', empty: 'its save folder is empty', 'too-big': 'its saves are over 3 GB', unchanged: 'nothing changed since the last copy' }[r.skipped] || String(r.skipped || '');
  }
  // ----- Playtime stats
  async function openStats() {
    let st = null, err = null;
    const fmtH = (h) => (h >= 100 ? Math.round(h).toLocaleString() : h >= 10 ? (Math.round(h * 10) / 10).toString() : h > 0 ? (Math.round(h * 10) / 10).toString() : '0');
    const mins = (h) => (h < 1 ? Math.round(h * 60) + ' min' : fmtH(h) + ' h');
    const date = (t) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
    const html = () => {
      if (err) return '<div class="stats"><h1>' + icon('chart') + 'Play time</h1><p class="hint">' + esc(err) + '</p></div>';
      if (!st) return '<div class="stats"><h1>' + icon('chart') + 'Play time</h1><p class="hint">Loading…</p></div>';
      const max = Math.max(1, ...st.weeks.map((w) => w.hours));
      const diff = st.week - st.lastWeek;
      const tile = (label, value, sub) => '<div class="st-tile"><small>' + label + '</small><b>' + value + '</b>' + (sub ? '<span>' + sub + '</span>' : '') + '</div>';
      const y = st.year;
      const part = { morning: 'Mornings', afternoon: 'Afternoons', evening: 'Evenings', night: 'Late nights' }[y.topPart] || '';
      let h = '<div class="stats"><div class="st-head"><h1>' + icon('chart') + 'Play time</h1><span class="st-since">' + (st.since ? 'Sessions counted since ' + esc(new Date(st.since).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })) : 'Sessions are counted from now on') + '</span></div>' +
        '<div class="st-tiles">' +
        tile('Today', mins(st.today)) +
        tile('This week', mins(st.week), st.lastWeek || st.week ? (diff === 0 ? 'Same as last week' : (diff > 0 ? '▲ ' : '▼ ') + mins(Math.abs(diff)) + ' vs last week') : '') +
        tile('Streak', st.streak + (st.streak === 1 ? ' day' : ' days'), 'Best: ' + st.bestStreak + (st.bestStreak === 1 ? ' day' : ' days')) +
        tile('All time', fmtH(st.total) + ' h', st.games + (st.games === 1 ? ' game' : ' games')) + '</div>' +
        '<div class="st-cols"><section class="st-card"><h2>Last 12 weeks</h2><div class="st-bars">' + st.weeks.map((w, i) =>
          '<div class="st-bar' + (i === 11 ? ' now' : '') + '" title="' + esc(date(w.start)) + '"><span style="height:' + Math.max(w.hours ? 3 : 0, Math.round((w.hours / max) * 100)) + '%"></span><em>' + (w.hours ? fmtH(w.hours) : '') + '</em><i>' + esc(date(w.start)) + '</i></div>').join('') + '</div></section>' +
        '<section class="st-card"><h2>Most played</h2>' + (st.top.length ? st.top.map((g, i) => {
          const gg = byId(g.gameId);
          return '<button class="st-game" data-nav data-key="stg-' + i + '" data-zone="stg" data-act="game" data-id="' + esc(g.gameId) + '">' + (gg ? '<span class="mthumb" style="background-color:' + tileColor(gg) + (gg.art && gg.art.tile ? ';background-image:url(&quot;' + esc(fileUrl(gg.art.tile)) + '&quot;)' : '') + '"></span>' : '<span class="mthumb"></span>') +
            '<span class="st-gt"><b>' + esc(g.title) + '</b><span class="st-gbar"><i style="width:' + Math.max(2, Math.round((g.hours / st.top[0].hours) * 100)) + '%"></i></span></span><span class="st-gh">' + fmtH(g.hours) + ' h</span></button>';
        }).join('') : '<p class="hint">Play something and it shows up here.</p>') + '</section></div>' +
        '<section class="st-card st-year"><h2>Your ' + y.year + ' so far</h2>' + (y.sessions ? '<div class="st-ytiles">' +
          tile('Hours played', fmtH(y.hours)) + tile('Days you played', y.days) + tile('Games', y.games) + tile('Sessions', y.sessions) +
          (y.longest ? tile('Longest session', mins(y.longest.hours), esc(y.longest.title) + ' · ' + esc(date(y.longest.at))) : '') +
          (y.topDay ? tile('Favorite day', y.topDay, part ? part + ' are your time' : '') : '') + '</div>' +
          (y.top.length ? '<div class="st-ytop">' + y.top.map((g, i) => '<span><em>' + (i + 1) + '</em>' + esc(g.title) + '<small>' + fmtH(g.hours) + ' h</small></span>').join('') + '</div>' : '')
          : '<p class="hint">Your year shows up here as you play.</p>') + '</section></div>';
      return h;
    };
    const layer = openLayer({
      className: 'stats-layer',
      html: html(),
      onActivate: async (el) => {
        if (el.dataset.act === 'game') { const g = byId(el.dataset.id); if (g) { closeLayer(layer); for (const l of layers.slice().reverse()) if (l.isGuide) closeLayer(l); return S.playing ? switchTo(g.id) : play(g.id); } }
      },
      onBack: () => closeLayer(layer),
      prompts: () => [['A', 'Play'], ['B', 'Back']]
    });
    try { st = await api.stats(); } catch (e) { err = e.message; }
    if (layers.indexOf(layer) < 0) return;
    layer.el.innerHTML = html();
    const f = $('[data-nav]', layer.el);
    if (f) setFocus(f, { instant: true });
  }
  // Leaving whatever is open over the launcher's pages (Movies & TV, Clips, a friend's profile,
  // the Friends panel…), for the guide's "go to" choices. The guide and the boot screen stay.
  function leaveApps() {
    for (const l of layers.slice().reverse()) if (!l.isGuide && l.className !== 'launching') closeLayer(l);
  }
  // The launcher's own apps (Movies & TV, YouTube): remembered so the guide's Recent list has them.
  const APPS = { tv: { title: 'Movies & TV', icon: 'tv' }, youtube: { title: 'YouTube', icon: 'playc' } };
  function openApp(id) {
    if (!APPS[id]) return;
    const s = S.lib.settings;
    s.lastApps = Object.assign({}, s.lastApps, { [id]: Date.now() });
    save();
    if (id === 'tv') return TV().open();
    toast('Opening YouTube… press the Xbox button to come back');
    return api.youtubeOpen().catch((e) => toast(e.message, true));
  }
  async function switchTo(id, extra) {
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
    if (closed) play(id, extra);
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
    let friends = null, friendsErr = null, xboxOn = false, ach = null;
    const TABS_G = [['games', 'grid', 'Games'], ['clips', 'film', 'Clips'], ['friends', 'users', 'Friends'], ['system', 'user', 'Profile & system']].filter((x) => !(IS_MAC && x[0] === 'clips'));
    let gclips = null, gclipsErr = null;
    let music = null, musicErr = null, musicTimer = null;
    let joinables = [];
    // Sound output and volume (Windows' default device), loaded when Profile & system opens.
    let snd = null, sndErr = null, sndBusy = false;
    const kindIcon = (o) => ({ headset: 'headset', tv: 'tv', soundbar: 'speaker', speaker: 'speaker' }[o && o.kind] || 'speaker');
    function soundHTML() {
      if (sndErr) return '';
      if (!snd) return '<div class="glabel">Sound</div><p class="hint gpad">Checking your sound outputs…</p>';
      const cur = snd.current;
      let h = '<div class="glabel">Sound</div>' +
        item('s-out', kindIcon(cur), 'Plays on: ' + esc(cur ? cur.label : 'nothing') + (snd.outputs.length > 1 ? '<small>' + (snd.outputs.length - 1) + ' more · press to switch</small>' : ''), 'data-act="audio-out"', 'gsound');
      if (snd.volume >= 0) {
        const v = snd.muted ? 0 : snd.volume;
        h += '<div class="mvol"><button class="mvbtn" data-nav data-key="s-vdown" data-zone="gbody" data-lock="svol" data-act="sv-down" aria-label="Volume down">' + icon('minus') + '</button>' +
          '<div class="mvbar" role="meter" aria-label="Volume" aria-valuenow="' + v + '" aria-valuemin="0" aria-valuemax="100"><span style="width:' + v + '%"></span></div>' +
          '<button class="mvbtn' + (snd.muted ? ' on' : '') + '" data-nav data-key="s-mute" data-zone="gbody" data-lock="svol" data-act="sv-mute" aria-label="' + (snd.muted ? 'Unmute' : 'Mute') + '">' + icon(snd.muted ? 'x' : 'volume') + '</button>' +
          '<span class="mvpct">' + (snd.muted ? 'Muted' : snd.volume + '%') + '</span>' +
          '<button class="mvbtn" data-nav data-key="s-vup" data-zone="gbody" data-lock="svol" data-act="sv-up" aria-label="Volume up">' + icon('plus') + '</button></div>';
      }
      return h;
    }
    function loadSound() {
      Promise.resolve().then(() => api.audioState()).then((st) => { snd = st; sndErr = null; }, (e) => { sndErr = e.message; })
        .then(() => { if (layers.indexOf(layer) >= 0 && tab === 'system') redraw(); });
    }
    async function soundCmd(fn) {
      if (sndBusy) return;
      sndBusy = true;
      try { snd = await fn(); } catch (e) { toast(e.message, true); } finally { sndBusy = false; }
      if (layers.indexOf(layer) >= 0 && tab === 'system') redraw();
    }
    const item = (key, ic, label, attrs, cls) => '<button class="mitem' + (cls ? ' ' + cls : '') + '" data-nav data-key="' + key + '" data-zone="gbody" ' + attrs + '>' + icon(ic) + '<span>' + label + '</span></button>';
    const thumb = (g) => '<span class="mthumb" style="background-color:' + tileColor(g) + (g.art && g.art.tile ? ';background-image:url(&quot;' + esc(fileUrl(g.art.tile)) + '&quot;)' : '') + '"></span>';
    const spot = () => document.documentElement.classList.contains('style-spotlight');
    function body() {
      if (tab === 'games') {
        // (In the Spotlight style Home is a button on the guide's bottom bar instead.)
        let h = spot() ? '' : item('g-home', 'home', 'Home', 'data-act="home" data-top') + '<div class="gsep"></div>';
        // Watching something (Movies & TV): it's paused while the guide is open.
        const tvn = OVERLAY && S.tvNow;
        if (tvn) {
          const pct = tvn.dur ? Math.min(100, Math.round(tvn.pos / tvn.dur * 100)) : 0;
          const left = tvn.dur ? Math.max(0, Math.round((tvn.dur - tvn.pos) / 60)) : 0;
          h += '<div class="glabel">Paused</div><div class="gnow">' +
            (tvn.yt ? '<span class="mthumb appthumb app-youtube">' + icon('playc') + '</span>' : '<span class="mthumb tvthumb"' + (tvn.poster ? ' style="background-image:url(&quot;' + esc(tvn.poster) + '&quot;)"' : '') + '></span>') +
            '<div class="gnow-t">' + esc(tvn.title) + '<small>' + esc([tvn.subtitle, left ? left + ' min left' : ''].filter(Boolean).join(' · ')) + '</small>' +
            (pct ? '<span class="gprog"><i style="width:' + pct + '%"></i></span>' : '') + '</div></div>' +
            item('g-tvresume', 'resume', tvn.yt ? 'Back to YouTube' : 'Resume watching', 'data-act="tv-resume"') +
            item('g-tvstop', 'x', tvn.yt ? 'Close YouTube' : 'Stop watching', 'data-act="tv-stop"', 'danger') + '<div class="gsep"></div>';
        }
        // The game you're in comes first, right under Home: opening the guide shows it and
        // Resume without scrolling (Home used to be scrolled out of view).
        const cur = S.playing && byId(S.playing.id);
        if (cur) {
          h += '<div class="glabel">Now playing</div><div class="gnow">' + thumb(cur) + '<div class="gnow-t">' + esc(cur.title) +
            (ach && ach.id === cur.id && ach.v ? '<small class="ach">' + icon('trophy') + ach.v.got + '/' + ach.v.total + ' achievements' + (ach.v.recent.length ? ' · latest: ' + esc(ach.v.recent[0]) : '') + '</small>' : '') +
            // Anti-cheat games aren't paused (or touched at all) while the guide is open.
            (status && status.protected ? '<small>' + icon('shield') + 'Anti-cheat game: it keeps running while you’re here</small>' : '') + '</div></div>' +
            item('g-resume', 'resume', 'Resume game', 'data-act="resume"') +
            (status && status.canClose ? item('g-close', 'x', 'Close game', 'data-act="close"', 'danger') : '') + '<div class="gsep"></div>';
        }
        // Friends who started a game you can join (Steam lobbies / servers).
        if (joinables.length) h += '<div class="glabel">Join a friend</div>' + joinables.slice(0, 3).map((f) =>
          '<button class="mitem gjoin" data-nav data-key="gj-' + esc(f.id) + '" data-zone="gbody" data-act="friend" data-friend="' + esc(f.id) + '">' +
          '<span class="fpic small">' + esc(f.gamertag.charAt(0).toUpperCase()) + (f.pic ? '<img src="' + esc(f.pic) + '" alt="">' : '') + '</span>' +
          '<span>Join ' + esc(f.gamertag) + '<small>' + esc(f.game || 'Steam game') + '</small></span></button>').join('') + '<div class="gsep"></div>';
        h += musicHTML();
        const recentGames = games().filter((g) => !cur || g.id !== cur.id).sort((a, b) => (b.lastPlayed - a.lastPlayed) || (b.addedAt - a.addedAt)).slice(0, 6);
        // Movies & TV and YouTube sit in Recent too, by when you last used them.
        const lastApps = S.lib.settings.lastApps || {};
        const recent = recentGames.map((g) => ({ g, at: g.lastPlayed || 0 }))
          .concat(Object.keys(APPS).filter((k) => lastApps[k] && !(tvn && (k === 'youtube') === !!tvn.yt)).map((k) => ({ app: k, at: lastApps[k] })))
          .sort((a, b) => b.at - a.at).slice(0, 7);
        if (recent.length) {
          h += '<div class="glabel">' + (cur ? 'Switch to' : 'Recent') + '</div>' + recent.map((r) => r.app
            ? '<button class="mitem gitem2" data-nav data-key="ga-' + r.app + '" data-zone="gbody" data-act="open-app" data-app="' + r.app + '"><span class="mthumb appthumb app-' + r.app + '">' + icon(APPS[r.app].icon) + '</span><span>' + APPS[r.app].title + '</span></button>'
            : '<button class="mitem gitem2" data-nav data-key="g-' + esc(r.g.id) + '" data-zone="gbody" data-act="play" data-id="' + esc(r.g.id) + '">' + thumb(r.g) + '<span>' + esc(r.g.title) + '</span></button>').join('');
          h += '<div class="gsep"></div>';
        }
        h += item('g-lib', 'grid', 'My library', 'data-act="library"') + item('g-add', 'plus', 'Add a game', 'data-act="add"');
        return h;
      }
      if (tab === 'friends') return discordHTML() + friendSectionsHTML(friends, 'gbody') + playedWithHTML(friends, 'gbody');
      if (tab === 'clips') {
        if (gclipsErr) return '<p class="hint gpad">' + esc(gclipsErr) + '</p>';
        if (!gclips) { loadClips(false).then((v) => { gclips = v; if (layers.indexOf(layer) >= 0 && tab === 'clips') redraw(); }, (e) => { gclipsErr = e.message; redraw(); }); return '<p class="hint gpad">Loading your Medal clips…</p>'; }
        const recent = gclips.clips.filter((c) => c.kind === 'clip').slice(0, 8);
        return '<div class="glabel">Latest clips · Medal</div>' + (recent.length ? '<div class="gclips">' + recent.map((c, i) => '<button class="gclip" data-nav data-key="gc-' + i + '" data-zone="gbody" data-act="clip" data-i="' + i + '">' + clipThumbHTML(c) + '<span class="cname">' + esc(c.game) + '</span><span class="cwhen">' + esc(ago(c.at)) + '</span></button>').join('') + '</div>'
          : '<p class="hint gpad">' + (gclips.folder ? 'No clips yet.' : 'Medal’s clips folder wasn’t found.') + '</p>') +
          item('gc-all', 'film', 'All clips', 'data-act="clips-all"');
      }
      const s = S.lib.settings;
      return '<button class="gprofile" data-nav data-key="s-profile" data-zone="gbody" data-act="profile">' + avatarHTML('avatar') +
        '<span><span class="gp-name">' + esc(displayName()) + '</span><span class="gp-sub">' +
        (s.xbox ? icon('trophy') + Number(s.xbox.gamerscore || 0).toLocaleString() : 'Edit profile') + '</span></span></button>' +
        (s.xbox ? '' : item('s-connect', 'link', 'Connect Xbox account', 'data-act="connect"')) +
        (Array.isArray(S.pads) && S.pads.length ? '<div class="glabel">Controllers</div><div class="gpads">' + padsHTML() + '</div>' : '') +
        soundHTML() +
        '<div class="gsep"></div>' +
        item('s-stats', 'chart', 'Play time', 'data-act="stats"') +
        item('s-players', 'users', 'Set up players', 'data-act="players-setup"') +
        item('s-settings', 'gear', 'Settings', 'data-act="settings"') +
        item('s-themes', 'palette', 'Themes', 'data-act="themes"') +
        item('s-platforms', 'refresh', 'Platforms & rescan', 'data-act="platforms"') +
        '<div class="gsep"></div>' + item('s-sleep', 'moon', 'Sleep timer', 'data-act="sleep"') + item('s-power', 'power', 'Power', 'data-act="power"');
    }
    function html() {
      const t = TABS_G.find((x) => x[0] === tab);
      return '<aside class="guide"><div class="gtabs">' +
        (spot() ? '<button class="gtab ghome" data-nav data-key="g-home" data-zone="gtabs" data-lock="gtabs" data-act="home" aria-label="Home">' + icon('home') + '</button><span class="gtab-gap"></span>' : '') + TABS_G.map(([k, ic, label]) =>
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
      if (tab === 'clips') lazyThumbs(layer.el, $('.gbody', layer.el));
    }
    function setTab(t) {
      if (t === tab) return;
      tab = t;
      redraw('tab-' + t);
      const first = $('.gbody [data-nav]', layer.el);
      if (first) setFocus(first, { instant: true });
      if (tab === 'friends' && !friends) loadFriends();
      if (tab === 'friends') loadDiscord();
      if (tab === 'system') loadSound();
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
    // With Discord connected (Discord's own connection, set up once), the card also shows
    // who's in your call and in each pinned voice channel, and joins / mutes for real.
    let dc = null, dcCfg = null, rpc = null, rpcErr = null, rpcTimer = null, rpcSig = '';
    const pinChannel = (p) => (/\/channels\/\d+\/(\d{5,25})/.exec((p && p.url) || '') || [])[1] || null;
    const voiceIds = () => (S.lib.settings.discordPins || []).filter((p) => p.voice).map(pinChannel).filter(Boolean);
    const personHTML = (p) => '<div class="dcp"><span class="dcav">' + esc((p.name || '?').charAt(0).toUpperCase()) + (p.pic ? '<img src="' + esc(p.pic) + '" alt="">' : '') + '</span>' +
      '<span class="dcn">' + esc(p.name) + '</span>' + (p.deaf ? '<span class="dcst" title="Deafened">' + icon('deaf') + '</span>' : p.muted ? '<span class="dcst" title="Muted">' + icon('micoff') + '</span>' : '') + '</div>';
    function discordHTML() {
      const pins = S.lib.settings.discordPins || [];
      const live = !!rpc;
      const pill = (key, ic, label, attrs, on) => '<button class="pill gpill' + (on ? ' on' : '') + '" data-nav data-key="' + key + '" data-zone="gbody" data-lock="dcrow" ' + attrs + '>' + icon(ic) + '<span>' + label + '</span></button>';
      const note = live ? (rpc.call ? 'In a call' : 'Connected') : !dc ? '' : !dc.installed && !dc.running ? 'Not installed' : dc.running ? 'Open' : 'Not open';
      let h = '<div class="gdiscord"><div class="gm-head">' + icon('chat') + '<span>Discord</span><span class="gm-note">' + note + '</span></div>' +
        '<div class="gmrow">' + pill('dc-open', 'link', dc && dc.running ? 'Show' : 'Open', 'data-act="dc-open"') + (IS_MAC ? '' : pill('dc-msg', 'chat', 'Message', 'data-act="dc-msg"')) +
        // Mac: muting from here goes through Discord's own connection (no key presses).
        (IS_MAC && !live ? '' : pill('dc-mute', live && rpc.muted ? 'micoff' : 'mic', live && rpc.muted ? 'Unmute' : 'Mute', 'data-act="dc-mute"', live && rpc.muted) +
        pill('dc-deaf', live && rpc.deaf ? 'deaf' : 'headset', live && rpc.deaf ? 'Undeafen' : 'Deafen', 'data-act="dc-deaf"', live && rpc.deaf)) + '</div>';
      if (live && rpc.call) {
        h += '<div class="glabel">In ' + esc(rpc.call.name) + ' · ' + rpc.call.people.length + '</div><div class="dcpeople">' + rpc.call.people.map(personHTML).join('') + '</div>' +
          '<button class="mitem danger" data-nav data-key="dc-leave" data-zone="gbody" data-act="dc-leave">' + icon('exit') + '<span>Leave call</span></button>';
      }
      h += pins.map((p, i) => {
        const ch = p.voice ? pinChannel(p) : null;
        const who = live && ch && rpc.pins ? rpc.pins[ch] : null;
        const here = live && rpc.call && ch === rpc.call.id;
        const sub = !p.voice || !live ? '' : here ? 'You’re in' : who ? (who.length ? who.length + ' in call' : 'Empty') : '';
        return '<button class="mitem dcpin" data-nav data-key="dc-pin-' + i + '" data-zone="gbody" data-act="dc-pin" data-i="' + i + '">' + icon(p.voice ? 'headset' : p.kind === 'channel' ? 'chat' : 'users') +
          '<span>' + esc(p.name) + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span>' +
          (who && who.length && !here ? '<span class="dcstack">' + who.slice(0, 4).map((x) => '<span class="dcav">' + esc(x.name.charAt(0).toUpperCase()) + (x.pic ? '<img src="' + esc(x.pic) + '" alt="">' : '') + '</span>').join('') + '</span>' : '') + '</button>';
      }).join('');
      h += '<button class="mitem" data-nav data-key="dc-add" data-zone="gbody" data-act="dc-add">' + icon('plus') + '<span>' + (pins.length ? 'Pins: add or remove' : 'Pin a server, channel or call') + '</span></button>';
      if (dcCfg && !live) {
        h += '<button class="mitem" data-nav data-key="dc-setup" data-zone="gbody" data-act="dc-setup">' + icon('link') + '<span>' +
          (dcCfg.configured ? 'Reconnect Discord' + (rpcErr && rpcErr !== 'NEED_APPROVAL' ? '<small>' + esc(rpcErr) + '</small>' : '') : 'Connect Discord for calls<small>See who’s in, join, mute</small>') + '</span></button>';
      }
      return h + '</div><div class="gsep"></div>';
    }
    async function pollRpc() {
      try { rpc = await api.dcRpcState(voiceIds()); rpcErr = null; }
      catch (e) { rpc = null; rpcErr = e.message; }
      const sig = JSON.stringify([rpc, rpcErr]);
      if (sig !== rpcSig) { rpcSig = sig; if (layers.indexOf(layer) >= 0 && tab === 'friends') redraw(); }
    }
    async function loadDiscord() {
      try { dc = await api.discordStatus(); } catch (_) { dc = null; }
      try { dcCfg = await api.dcRpcStatus(); } catch (_) { dcCfg = null; }
      clearInterval(rpcTimer);
      if (dcCfg && dcCfg.configured) { await pollRpc(); rpcTimer = setInterval(() => { if (tab === 'friends' && layers.indexOf(layer) >= 0) pollRpc(); else clearInterval(rpcTimer); }, 3000); }
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
        // Which app each button opens, by name ("Open app" didn't say which).
        '<div class="gmrow">' + pill('m-open-cur', 'link', 'Open ' + (music.app === 'Spotify' ? 'Spotify' : 'Apple Music'), 'data-act="m-open" data-app="' + esc(music.app === 'Spotify' ? 'Spotify' : 'Apple Music') + '"') +
        pill('m-open-other', 'music', other, 'data-act="m-open" data-app="' + other + '" aria-label="Open ' + other + '"') +
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
      clearInterval(rpcTimer);
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
      focus: OVERLAY && S.tvNow ? 'g-tvresume' : 'g-resume',
      onActivate: async (el) => {
        const act = el.dataset.act;
        if (act === 'tab') return setTab(el.dataset.tab);
        if (act === 'friend') return friendMenu(el.dataset.friend);
        if (act === 'tv-resume') return resumeGame();
        if (act === 'stats') return openStats();
        if (act === 'audio-out' && snd) {
          const pick = await openMenu('Play sound on', snd.outputs.map((o) => ({ id: o.id, label: o.label + (o.isDefault ? ' · now' : ''), icon: o.isDefault ? 'check' : kindIcon(o) })));
          if (!pick || (snd.current && pick === snd.current.id)) return;
          const name = (snd.outputs.find((o) => o.id === pick) || {}).label;
          await soundCmd(() => api.audioOutput(pick));
          if (snd && snd.current && snd.current.id === pick) toast('Sound now plays on ' + name);
          return;
        }
        if (act === 'sv-down' && snd) return soundCmd(() => api.audioVolume(Math.max(0, snd.volume - 5)));
        if (act === 'sv-up' && snd) return soundCmd(() => (snd.muted ? api.audioMute(false) : api.audioVolume(Math.min(100, snd.volume + 5))));
        if (act === 'sv-mute' && snd) return soundCmd(() => api.audioMute(!snd.muted));
        if (act === 'open-app') {
          const id = el.dataset.app;
          closeLayer(layer);
          if (OVERLAY) { try { await api.overlayAction({ action: 'goto', target: id }); } catch (e) { toast(e.message, true); } return; }
          return openApp(id);
        }
        if (act === 'tv-stop') { closeLayer(layer); try { await (S.tvNow && S.tvNow.yt ? api.ytGuideClose() : api.tvGuideStop()); } catch (e) { toast(e.message, true); } return; }
        if (act === 'friend-recent') return openFriendProfile(el.dataset.friend);
        if (act === 'm-bal') { if (S.input !== 'mouse') setBalance(0); return; } // A: back to the middle
        // Over the game: anything that needs the full launcher is handed to it.
        if (act === 'dc-leave') { try { await api.dcRpcLeave(); toast('Left the call'); } catch (e) { toast(e.message, true); } return pollRpc(); }
        if (act === 'dc-pin' && rpc) {
          const pin = (S.lib.settings.discordPins || [])[Number(el.dataset.i)];
          const ch = pin && pin.voice ? pinChannel(pin) : null;
          if (ch) {
            if (rpc.call && rpc.call.id === ch) { toast('You’re already in ' + pin.name); return; }
            try { await api.dcRpcJoin(ch); toast('Joined ' + pin.name); } catch (e) { toast(e.message, true); }
            return pollRpc();
          }
        }
        if (act === 'dc-open' || act === 'dc-pin') {
          const pin = act === 'dc-pin' ? (S.lib.settings.discordPins || [])[Number(el.dataset.i)] : null;
          try {
            await api.discordOpen(pin ? pin.url : null, !!(pin && pin.voice));
            if (pin && pin.voice) toast('Press A to join the call');
            else if (!OVERLAY) toast(pin ? 'Opening ' + pin.name : 'Opening Discord');
          } catch (e) { toast(e.message, true); }
          return;
        }
        if ((act === 'dc-mute' || act === 'dc-deaf') && rpc) {
          try { const on = await api.dcRpcToggle(act === 'dc-deaf' ? 'deafen' : 'mute'); toast(act === 'dc-deaf' ? (on ? 'Deafened' : 'Undeafened') : (on ? 'Muted' : 'Unmuted')); }
          catch (e) { toast(e.message, true); }
          return pollRpc();
        }
        if (act === 'dc-mute' || act === 'dc-deaf') {
          let keysOk = false;
          try { keysOk = await api.discordSetup(null); } catch (_) { keysOk = false; }
          if (!keysOk) {
            const ok = await confirmBox('One-time Discord setup', 'Discord only listens to mute/deafen shortcuts from other programs once you add them: in Discord open Settings › Keybinds › Add a Keybind, choose Toggle Mute and press Ctrl+Shift+M, then add Toggle Deafen with Ctrl+Shift+D. Done that?', 'Done, it’s set up', false, { cancelLabel: 'Not yet', focusOk: true });
            if (!ok) return;
            try { await api.discordSetup(true); } catch (_) { /* asks again next time */ }
          }
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
        if (OVERLAY && !['resume', 'friend', 'friend-recent', 'friends-retry', 'm-toggle', 'm-next', 'm-prev', 'm-shuffle', 'm-pref', 'm-open', 'm-voldown', 'm-volup', 'clip', 'clips-all'].includes(act)) {
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
        if (act === 'play') { const id = el.dataset.id; if (S.playing) { await switchTo(id); return; } leaveApps(); closeLayer(layer); return play(id); }
        if (act === 'library') { leaveApps(); closeLayer(layer); return go('library'); }
        if (act === 'home') {
          leaveApps();
          closeLayer(layer);
          for (const l of layers.slice().reverse()) if (l.className === 'launching') closeLayer(l);
          try { await api.goHome(); } catch (_) { /* still go Home */ }
          return go('home', S.playing ? 'h-' + S.playing.id : null);
        }
        if (act === 'add') { leaveApps(); closeLayer(layer); return openEdit(null); }
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
        if (act === 'dc-setup') { closeLayer(layer); return discordConnect(); }
        if (act === 'players-setup') { leaveApps(); closeLayer(layer); return setUpPlayersNow(); }
        if (act === 'clip') {
          const list = gclips.clips.filter((c) => c.kind === 'clip').slice(0, 8);
          let dirty = false;
          return openClipPlayer(list, Number(el.dataset.i), (c) => { gclips.clips = gclips.clips.filter((x) => x.file !== c.file); dirty = true; },
            () => { if (dirty) setTimeout(() => { if (layers[layers.length - 1] === layer && tab === 'clips') redraw(); }, 0); });
        }
        if (act === 'clips-all') { leaveApps(); closeLayer(layer); return openClips(); }
        if (act === 'profile') { openProfile(); return; }
        if (act === 'settings') { leaveApps(); closeLayer(layer); S.setTab = 'platforms'; return go('settings', 't-platforms'); }
        if (act === 'themes') { leaveApps(); closeLayer(layer); S.setTab = 'themes'; return go('settings', 't-themes'); }
        if (act === 'platforms') { leaveApps(); closeLayer(layer); S.setTab = 'platforms'; return go('settings', 'p-all'); }
        if (act === 'power') { closeLayer(layer); return powerMenu(); }
        if (act === 'sleep') return sleepMenu();
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
    { const f0 = $('[data-key="g-tvresume"]', layer.el) || $('[data-key="g-resume"]', layer.el) || $('.gbody [data-act="play"]', layer.el) || $('.gbody [data-nav]', layer.el); if (f0) setFocus(f0, { instant: true }); }
    // Fill in what needs the app core: can the game be closed, is Xbox connected.
    try { status = await api.gameStatus(); } catch (_) { status = null; }
    try { xboxOn = await api.xboxStatus(); } catch (_) { xboxOn = false; }
    if (S.playing) { try { const v = await api.balance(null); bal = balLevels(v.balance); } catch (_) { bal = null; } }
    if (S.playing) {
      const pg = byId(S.playing.id);
      steamAch(pg).then((v) => { if (v && pg) { ach = { id: pg.id, v }; if (layers.indexOf(layer) >= 0 && tab === 'games') redraw(); } });
    }
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
    if (tab === 'system') loadSound();
    if (tab === 'games') { musicCmd('state'); clearInterval(musicTimer); musicTimer = setInterval(() => musicCmd('state'), 2000); }
    Promise.resolve().then(() => api.friendJoinable()).then((l) => {
      if (!Array.isArray(l) || !l.length || layers.indexOf(layer) < 0) return;
      joinables = l; rememberFriends(l);
      if (tab === 'games') redraw();
    }, () => {});
  }

  async function loadAllFriends() {
    const out = { xbox: { on: false }, steam: { on: false } };
    try { out.xbox.on = await api.xboxStatus(); } catch (_) { /* not connected */ }
    try { out.steam.on = await api.steamStatus(); } catch (_) { /* not connected */ }
    await Promise.all([
      out.xbox.on ? api.xboxFriends().then((l) => { out.xbox.list = l; }, (e) => { out.xbox.err = e.message; }) : null,
      out.steam.on ? api.steamFriends().then((l) => { out.steam.list = l; }, (e) => { out.steam.err = e.message; }) : null,
      Promise.resolve().then(() => api.friendRecent()).then((l) => { out.recent = Array.isArray(l) ? l : []; }, () => { out.recent = []; })
    ]);
    rememberFriends([].concat(out.xbox.list || [], out.steam.list || []));
    return out;
  }
  // ----- friends: join, play the same game, store, profiles
  S.friendMap = new Map();
  function rememberFriends(list) { for (const f of list || []) if (f && (f.id || f.xuid)) S.friendMap.set(f.id || f.xuid, Object.assign({ id: f.id || f.xuid }, f)); }
  function playedWithHTML(fr, zone) {
    const list = (fr && fr.recent) || [];
    if (!list.length) return '';
    const z = zone ? ' data-zone="' + zone + '"' : '';
    return '<div class="gsep"></div><div class="glabel">Played with recently</div>' + list.slice(0, 8).map((p) =>
      '<button class="friend pw" data-nav data-key="pw-' + esc(p.id) + '"' + z + ' data-act="friend-recent" data-friend="' + esc(p.id) + '">' +
      '<div class="fpic">' + esc(String(p.name || '?').charAt(0).toUpperCase()) + (p.pic ? '<img src="' + esc(p.pic) + '" alt="">' : '') + '</div>' +
      '<div class="finfo"><div class="fname">' + esc(p.name || 'Friend') + '</div><div class="fstatus">' + esc(p.games.slice(0, 2).map((x) => x.title).join(', ')) + ' · ' + esc(ago(p.last)) + '</div></div></button>').join('');
  }
  // What you can do with a friend: join them, play the same game, find it, see their profile.
  function friendItems(f) {
    const items = [];
    const mine = f.owned && byId(f.owned);
    const what = f.game || (mine && mine.title) || 'their game';
    if (f.joinable) items.push({ id: 'join', label: 'Join ' + f.gamertag + ' in ' + what, icon: 'play' });
    if (mine && !(S.playing && S.playing.id === mine.id)) items.push({ id: 'play', label: (f.joinable ? 'Just play ' : 'Play ') + mine.title, icon: f.joinable ? 'pad' : 'play' });
    if (!mine && f.store && (f.game || f.gameid)) items.push({ id: 'store', label: (f.service === 'steam' ? 'See ' + what + ' on Steam' : 'Find ' + what + ' in the Store'), icon: 'store' });
    items.push({ id: 'profile', label: 'View profile', icon: 'user' });
    return items;
  }
  function closeGuides() { for (const l of layers.slice().reverse()) if (l.isGuide || l.className === 'side-layer' || l.className === 'fp-layer') closeLayer(l); }
  async function friendAct(f, pick) {
    if (!f || !pick) return;
    if (pick === 'profile') return openFriendProfile(f.id);
    if (pick === 'store') { try { await api.friendStore(f.id); } catch (e) { toast(e.message, true); } return; }
    const mine = f.owned && byId(f.owned);
    if (pick === 'join') {
      // Already in that game, or not in your library: Steam's own join link does it.
      if (!mine || (S.playing && S.playing.id === mine.id)) {
        try { await api.friendJoin(f.id); toast('Joining ' + f.gamertag + '…'); closeGuides(); } catch (e) { toast(e.message, true); }
        return;
      }
      if (OVERLAY) { closeGuides(); try { await api.overlayAction({ action: 'join', id: mine.id, friend: f.id }); } catch (e) { toast(e.message, true); } return; }
      closeGuides();
      return S.playing ? switchTo(mine.id, { join: f.id }) : play(mine.id, { join: f.id });
    }
    if (pick === 'play' && mine) {
      if (OVERLAY) { closeGuides(); try { await api.overlayAction({ action: S.playing ? 'switch' : 'goto', id: mine.id, target: 'library' }); } catch (e) { toast(e.message, true); } return; }
      closeGuides();
      return S.playing ? switchTo(mine.id) : play(mine.id);
    }
  }
  async function friendMenu(id) {
    const f = S.friendMap.get(id);
    if (!f) return openFriendProfile(id);
    const sub = f.online ? (f.status || 'Online') : 'Offline';
    const pick = await openMenu(f.gamertag + ' · ' + sub, friendItems(f));
    return friendAct(f, pick);
  }
  // A game's achievements on a friend's profile: theirs (bar) and yours next to them.
  function achLine(r) {
    let got = null, total = null, txt = '';
    if (r.ach && r.ach.total) { got = r.ach.got; total = r.ach.total; txt = got + '/' + total + ' achievements' + (r.mine ? ' · you ' + r.mine.got + '/' + r.mine.total : ''); }
    else if (r.total) { got = r.gamerscore; total = r.total; txt = Number(r.gamerscore).toLocaleString() + '/' + Number(r.total).toLocaleString() + ' G' + (r.achievements ? ' · ' + r.achievements + ' achievements' : ''); }
    if (total == null) return '';
    const pc = Math.round(got / total * 100);
    return '<span class="fp-ach">' + icon('trophy') + '<span>' + esc(txt) + '</span></span><span class="fp-bar"><span style="width:' + Math.max(pc ? 2 : 0, pc) + '%"></span></span>' +
      (r.ach && r.ach.recent && r.ach.recent[0] ? '<span class="fp-gs">Latest: ' + esc(r.ach.recent[0]) + '</span>' : '');
  }
  // 1 decimal under 10 hours (8.4 h), whole hours above; never the raw number (8.41666 h).
  function fmtHours(h) { h = Number(h) || 0; return h >= 1 ? (h >= 10 ? Math.round(h) : Math.round(h * 10) / 10) + ' h' : h > 0 ? Math.max(1, Math.round(h * 60)) + ' min' : ''; }
  async function openFriendProfile(id) {
    let p = null, err = null, lastAct = null;
    const known = S.friendMap.get(id) || null;
    const html = () => {
      const f = p || known || { gamertag: 'Friend', id };
      const name = f.name || f.gamertag;
      const steam = (f.service || (String(id).startsWith('steam-') ? 'steam' : 'xbox')) === 'steam';
      const stats = [];
      const num = (n) => Number(n).toLocaleString();
      if (p && steam) {
        if (p.games != null) stats.push(['Games', num(p.games)]);
        if (p.friends != null) stats.push(['Friends', num(p.friends)]);
        if (p.badges != null) stats.push(['Badges', num(p.badges)]);
        if (p.since) stats.push(['Member since', new Date(p.since).getFullYear()]);
      } else if (p) {
        if (p.games != null) stats.push(['Games played', num(p.games)]);
        if (p.achievements != null) stats.push(['Achievements', num(p.achievements)]);
        if (p.completed != null) stats.push(['Completed', num(p.completed)]);
        if (p.tenure) stats.push(['On Xbox', p.tenure + (p.tenure === 1 ? ' year' : ' years')]);
      }
      if (p && p.together && p.together.length) stats.push(['Played together', p.together.length + (p.together.length === 1 ? ' game' : ' games')]);
      const acts = p || known ? friendItems(Object.assign({}, known || {}, p || {}, { id })).filter((x) => x.id !== 'profile') : [];
      const pic = f.picBig || f.pic;
      const recent = ((p && p.recent) || []).map((r) => {
        if (r.img || !r.owned || !byId(r.owned)) return r;
        const a = byId(r.owned).art || {};
        return Object.assign({}, r, { img: a.hero || a.tile ? fileUrl(a.hero || a.tile) : null });
      });
      const pctOf = (r) => r.ach && r.ach.total ? Math.round(r.ach.got / r.ach.total * 100) : r.total ? Math.round(r.pct || (r.gamerscore / r.total * 100)) : null;
      const lineBits = [steam ? 'Steam' : 'Xbox'];
      if (p && p.realName && p.realName !== name) lineBits.push(esc(p.realName));
      if (p && (p.location || p.country)) lineBits.push(esc(p.location || p.country));
      const color = p && /^#[0-9a-f]{6}$/i.test(p.color || '') ? p.color : null;
      // Badges: level (Steam) or years on Xbox, account extras, then their latest games with how far they've got.
      const badges = [];
      if (p && steam && p.level != null) badges.push('<span class="fp-badge lvl" title="Steam level"><b>' + esc(String(p.level)) + '</b></span>');
      if (p && !steam && p.tenure) badges.push('<span class="fp-badge lvl" title="Years on Xbox"><b>' + esc(String(p.tenure)) + '</b></span>');
      if (p && !steam && p.tier === 'Gold') badges.push('<span class="fp-badge txt" title="Account">Gold member</span>');
      if (p && p.rep) badges.push('<span class="fp-badge txt" title="Reputation">' + esc(p.rep) + '</span>');
      for (const r of recent.slice(0, 6)) {
        const pc = pctOf(r);
        // The game's picture (the letter shows if it doesn't load).
        badges.push('<span class="fp-badge game" title="' + esc(r.title + (pc != null ? ' · ' + pc + '% of achievements' : '')) + '"' + (pc != null ? ' style="--pct:' + pc + '"' : '') + '><i>' + esc(r.title.charAt(0).toUpperCase()) + (r.img ? '<img src="' + esc(r.img) + '" alt="">' : '') + '</i></span>');
      }
      let xpBar = '';
      if (p && steam && p.xp && p.xp.toNext) {
        const span = p.xp.total - p.xp.thisLevel + p.xp.toNext, done = p.xp.total - p.xp.thisLevel;
        xpBar = '<div class="fp-xp"><div class="fp-xpbar"><span style="width:' + Math.max(2, Math.min(100, Math.round(done / span * 100))) + '%"></span></div><small>' + num(p.xp.toNext) + ' XP to level ' + (p.level + 1) + ' · ' + num(p.xp.total) + ' XP total</small></div>';
      }
      // Their game's artwork behind the header, tinted with their colour.
      const art = (p && p.art) || [];
      const artHTML = '<div class="fp-art"' + (art.length ? ' style="background-image:' + art.map((u) => 'url(&quot;' + esc(u) + '&quot;)').join(', ') + '"' : '') + '></div><div class="fp-shade"></div>';
      // Right column: what they're playing, and you two.
      const nowGame = f.game ? { title: f.game, label: 'Now playing', sub: f.joinable ? 'You can join' : (f.owned && byId(f.owned) ? 'In your library' : '') }
        : recent[0] ? { title: recent[0].title, label: 'Last played', sub: recent[0].hours2w ? fmtHours(recent[0].hours2w) + ' past 2 weeks' : recent[0].last ? ago(recent[0].last) : '' } : null;
      const nowImg = (recent.find((r) => nowGame && r.title === nowGame.title) || {}).img || (art.length ? art[art.length - 1] : null);
      const nowHTML = nowGame ? '<div class="fp-now"><span class="fp-now-img"' + (nowImg ? ' style="background-image:url(&quot;' + esc(nowImg) + '&quot;)"' : '') + '>' + (nowImg ? '' : icon('pad')) + '</span>' +
        '<span class="fp-now-t"><small>' + nowGame.label + '</small><b>' + esc(nowGame.title) + '</b>' + (nowGame.sub ? '<span>' + esc(nowGame.sub) + '</span>' : '') + '</span></div>' : '';
      const togMins = ((p && p.together) || []).reduce((n, t) => n + (t.mins || 0), 0);
      const you = [];
      if (p && p.commonCount != null) you.push([num(p.commonCount), p.commonCount === 1 ? 'game you both have' : 'games you both have']);
      if (p && p.together && p.together.length) you.push([String(p.together.length), p.together.length === 1 ? 'game played together' : 'games played together']);
      if (togMins) you.push([fmtHours(togMins / 60), 'together']);
      const youHTML = you.length ? '<div class="fp-you"><div class="fp-you-h">You &amp; ' + esc(name) + '</div><div class="fp-you-s">' + you.map(([v, k]) => '<span><b>' + esc(v) + '</b><small>' + esc(k) + '</small></span>').join('') + '</div></div>' : '';
      let h = '<div class="fprof ' + (steam ? 'steam' : 'xbox') + '"' + (color ? ' style="--band:' + color + ';--band2:color-mix(in srgb, ' + color + ' 62%, #000)"' : '') + '><section class="fp-hero">' + artHTML +
        '<div class="fp-left"><div class="fp-line">' + lineBits.join(' · ') +
        (!steam && f.gamerscore ? '<span class="fp-g">G</span>' + num(f.gamerscore) : '') +
        (steam && p && p.level != null ? ' · Level ' + esc(String(p.level)) : '') + '</div>' +
        '<h1>' + esc(name) + '</h1>' +
        '<div class="fp-status' + (f.online ? ' on' : '') + '">' + esc(f.online ? (f.status || 'Online') : (p && p.lastOnline ? 'Last online ' + ago(p.lastOnline) : 'Offline')) + '</div>' +
        (p && p.bio ? '<div class="fp-bio">' + esc(p.bio) + '</div>' : '') +
        (stats.length ? '<div class="fp-stats">' + stats.map(([k, v]) => '<span><small>' + esc(k) + '</small><b>' + esc(String(v)) + '</b></span>').join('') + '</div>' : '') +
        xpBar +
        (badges.length ? '<div class="fp-badges">' + badges.join('') + '</div>' : '') +
        '</div>' +
        '<div class="fp-center"><div class="fp-av">' + esc(String(name).charAt(0).toUpperCase()) + (pic ? '<img src="' + esc(pic) + '" alt="">' : '') + '</div><div class="fp-floor"></div></div>' +
        '<div class="fp-right"><div class="fp-acts">' + acts.map((x) => '<button class="fp-act" data-nav data-key="fpa-' + x.id + '" data-zone="fpacts" data-act="do" data-do="' + x.id + '">' + icon(x.icon) + '<span>' + esc(x.label) + '</span></button>').join('') + '</div>' +
        nowHTML + youHTML + '</div>' +
        '</section><section class="fp-below"><div class="fp-sec"><h2 class="fp-h">Recent activity</h2>';
      if (err) h += '<p class="hint fp-note">' + esc(err) + '</p>';
      else if (!p) h += '<p class="hint fp-note">Loading profile…</p>';
      else {
        if (p.private) h += '<p class="hint fp-note">' + esc(name) + '’s game details are private on Steam, so only their name and status show.</p>';
        const cards = recent.map((r, i) =>
          '<button class="fp-game" data-nav data-key="fpg-' + i + '" data-zone="fpgames" data-act="game" data-i="' + i + '">' +
          '<span class="fp-img">' + icon('pad') + (r.img ? '<img src="' + esc(r.img) + '" alt="">' : '') + (r.owned ? '<span class="fp-have">In your library</span>' : '') + '</span>' +
          '<span class="fp-gt">' + esc(r.title) + '</span><span class="fp-gs">' +
          esc(r.hours != null ? [r.hours2w ? fmtHours(r.hours2w) + ' past 2 weeks' : '', fmtHours(r.hours) ? fmtHours(r.hours) + ' total' : ''].filter(Boolean).join(' · ') : (r.last ? 'Played ' + ago(r.last) : '')) + '</span>' +
          achLine(r) + '</button>').join('');
        const localArt = (gid) => { const g = byId(gid); const a = g && g.art && (g.art.hero || g.art.tile); return a ? ' style="background-image:url(&quot;' + esc(fileUrl(a)) + '&quot;)"' : ''; };
        const tog = (p.together || []).map((t) =>
          '<button class="fp-game tog" data-nav data-key="fpt-' + esc(t.gameId) + '" data-zone="fpgames" data-act="tog" data-id="' + esc(t.gameId) + '">' +
          '<span class="fp-img tog"' + localArt(t.gameId) + '>' + (localArt(t.gameId) ? '' : icon('users')) + '<span class="fp-have">Played together</span></span>' +
          '<span class="fp-gt">' + esc(t.title) + '</span><span class="fp-gs">' + esc(ago(t.last)) + (t.mins ? ' · about ' + fmtHours(t.mins / 60) + ' together' : '') + '</span></button>').join('');
        h += cards || tog ? '<div class="fp-games">' + tog + cards + '</div>' : '<p class="hint fp-note">Nothing played lately.</p>';
        h += '</div>';
        if (p.common && p.common.length) {
          h += '<div class="fp-sec"><h2 class="fp-h">Games you both have<span class="fp-hn">' + num(p.commonCount) + '</span></h2><div class="fp-games common">' + p.common.map((c) =>
            '<button class="fp-game small" data-nav data-key="fpc-' + esc(c.gameId) + '" data-zone="fpcommon" data-act="tog" data-id="' + esc(c.gameId) + '">' +
            '<span class="fp-img"' + localArt(c.gameId) + '>' + (localArt(c.gameId) ? '' : icon('pad')) + '</span>' +
            '<span class="fp-gt">' + esc(c.title) + '</span><span class="fp-gs">' + esc(c.hours ? fmtHours(c.hours) + ' played by ' + name : c.pct != null ? c.pct + '% of achievements' : '') + '</span></button>').join('') + '</div></div>';
        }
        return h + '</section></div>';
      }
      return h + '</div></section></div>';
    };
    let peek = false;
    function scrollToRow(el) {
      const sc = el && el.closest && el.closest('.fprof');
      if (!sc) return;
      const sec = el.closest('.fp-sec');
      let top = !sec ? 0 : sec === $('.fp-sec', sc) ? sec.closest('.fp-below').offsetTop - remPx() * 6 : sc.scrollHeight;
      // Without buttons in the header, keep as much of it in view as the row allows.
      if (sec && sec === $('.fp-sec', sc) && !$('.fp-hero [data-nav]', sc)) {
        const r = el.getBoundingClientRect(), cr = sc.getBoundingClientRect();
        top = Math.max(0, Math.min(top, r.bottom - cr.top + sc.scrollTop - sc.clientHeight + remPx() * 4));
      }
      sc.scrollTo({ top, behavior: reduce() ? 'auto' : 'smooth' });
    }
    const layer = openLayer({
      className: 'fp-layer',
      html: html(),
      // Down from the header always goes to the first row below, and up from there back to the
      // button you were on (the rows below are wider than the header's columns).
      onMove: (dir, el) => {
        if (!el || !el.closest) return false;
        const root = el.closest('.fprof');
        if (!root) return false;
        const inHeroBelow = () => $$('.fp-hero [data-nav]', root).some((e) => e !== el && e.getBoundingClientRect().top >= el.getBoundingClientRect().bottom - 2);
        if (dir === 'down' && el.closest('.fp-hero') && !inHeroBelow()) { lastAct = el.dataset.key; const t = $('.fp-below [data-nav]', root); if (t) { setFocus(t); return true; } return false; }
        const first = el.closest('.fp-sec') === $('.fp-sec', root);
        if (dir === 'up' && first) {
          const t = (lastAct && $('[data-key="' + cssEsc(lastAct) + '"]', root)) || $('.fp-hero [data-nav]', root);
          if (t) { setFocus(t); return true; }
          // No buttons in the header (nothing to join, play or buy): up shows the header, down
          // goes back to the row.
          peek = true; root.scrollTo({ top: 0, behavior: reduce() ? 'auto' : 'smooth' }); return true;
        }
        if (dir === 'down' && first && peek) { peek = false; scrollToRow(el); return true; }
        peek = false;
        return false;
      },
      // Down to Recent activity scrolls the page up to it; back up shows the whole header again.
      onFocus: (el) => scrollToRow(el),
      onActivate: async (el) => {
        const act = el.dataset.act;
        if (act === 'do') { const f = Object.assign({}, known || {}, p || {}, { id }); if (!f.gamertag) f.gamertag = f.name || 'Friend'; return friendAct(f, el.dataset.do); }
        if (act === 'tog') { const g = byId(el.dataset.id); if (g) { closeGuides(); return S.playing ? switchTo(g.id) : play(g.id); } return; }
        if (act === 'game') {
          const r = p && p.recent[Number(el.dataset.i)];
          if (!r) return;
          const items = [];
          let line = '';
          if (p.service === 'steam' && r.appid) {
            const c = await api.friendCompare(id, r.appid).catch(() => null);
            if (c) line = 'Achievements: you ' + (c.mine ? c.mine.got + '/' + c.mine.total : 'none yet') + ' · ' + (p.name || 'them') + ' ' + (c.theirs ? c.theirs.got + '/' + c.theirs.total : 'private');
          } else if (r.total) line = (p.name || 'They') + ' has ' + r.gamerscore + ' of ' + r.total + ' gamerscore (' + Math.round(r.pct) + '%)';
          if (r.owned && byId(r.owned)) items.push({ id: 'play', label: 'Play ' + byId(r.owned).title, icon: 'play' });
          else items.push({ id: 'store', label: p.service === 'steam' ? 'See it on Steam' : 'Find it in the Store', icon: 'store' });
          const pick = await openMenu(r.title + (line ? ' · ' + line : ''), items);
          if (pick === 'play') { closeGuides(); const g = byId(r.owned); return OVERLAY ? api.overlayAction({ action: S.playing ? 'switch' : 'goto', id: g.id, target: 'library' }).catch((e) => toast(e.message, true)) : S.playing ? switchTo(g.id) : play(g.id); }
          if (pick === 'store') { try { await api.friendStore(id, p.service === 'steam' ? { appid: r.appid } : { title: r.title }); } catch (e) { toast(e.message, true); } }
        }
      },
      onBack: () => closeLayer(layer),
      prompts: () => [['A', 'Select'], ['B', 'Back']]
    });
    try { p = await api.friendProfile(id); if (p) rememberFriends([p]); } catch (e) { err = e.message; }
    if (layers.indexOf(layer) < 0) return;
    const key = layer.focusKey;
    layer.el.innerHTML = html();
    const el = (key && $('[data-key="' + cssEsc(key) + '"]', layer.el)) || $('[data-nav]', layer.el);
    if (el && topLayer() === layer) setFocus(el, { instant: true });
  }
  // Home: friends in a game right now.
  let friendsNowTimer = null;
  function friendsNowHTML(list) {
    if (!list || !list.length) return '';
    return '<div class="news-head hf-head">' + icon('users') + '<h2>Friends playing now</h2><span class="news-sub">' + list.length + ' in a game</span></div>' +
      '<div class="hf-row"><div class="hf-inner">' + list.slice(0, 16).map((f) => {
        const mine = f.owned && byId(f.owned);
        const tag = f.joinable ? '<span class="hf-tag join">Join</span>' : mine ? '<span class="hf-tag have">You have it</span>' : '';
        return '<button class="hf-card" data-nav data-key="hf-' + esc(f.id) + '" data-zone="hfriends" data-action="friend" data-friend="' + esc(f.id) + '">' +
          '<span class="fpic">' + esc(f.gamertag.charAt(0).toUpperCase()) + (f.pic ? '<img src="' + esc(f.pic) + '" alt="">' : '') + '<span class="fdot"></span></span>' +
          '<span class="hf-t"><span class="hf-name">' + esc(f.gamertag) + '</span><span class="hf-game">' + esc(f.game || (mine && mine.title) || 'In a game') + '</span></span>' + tag + '</button>';
      }).join('') + '</div></div>';
  }
  async function paintFriendsNow() {
    clearTimeout(friendsNowTimer);
    if (OVERLAY) return;
    friendsNowTimer = setTimeout(paintFriendsNow, 2 * 60 * 1000);
    if (S.view !== 'home' || S.playing) return;
    let list = [];
    try { list = await api.friendPlaying(); } catch (_) { list = []; }
    if (!Array.isArray(list)) list = [];
    rememberFriends(list);
    const hosts = $$('#home-friends'), host = hosts[hosts.length - 1]; // the new view (the old one may still be fading out)
    if (!host || S.view !== 'home') return;
    const sig = JSON.stringify(list.map((f) => [f.id, f.game, f.joinable, f.owned, f.pic]));
    if (host.dataset.sig === sig) return;
    host.dataset.sig = sig;
    const f = currentFocus(), key = f && f.closest('.home-friends') ? f.dataset.key : null;
    host.innerHTML = friendsNowHTML(list);
    if (key) { const el = $('[data-key="' + cssEsc(key) + '"]', host) || $('[data-nav]', host) || $('.ncard', $('#news-list')) || $('[data-key="c-lib"]'); if (el) setFocus(el, { instant: true }); }
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
    return fr.map((f) => '<button class="friend' + (f.online ? ' online' : '') + '" data-nav data-key="fr-' + esc(f.xuid || f.gamertag) + '"' + (zone ? ' data-zone="' + zone + '"' : '') + ' data-act="friend" data-friend="' + esc(f.id || f.xuid) + '">' +
      '<div class="fpic">' + esc(f.gamertag.charAt(0).toUpperCase()) + (f.pic ? '<img src="' + esc(f.pic) + '" alt="">' : '') + '<span class="fdot"></span></div>' +
      '<div class="finfo"><div class="fname">' + esc(f.gamertag) + (f.favorite ? ' <span class="fstar">' + starIcon + '</span>' : '') + '</div>' +
      '<div class="fstatus">' + esc(f.status || (f.online ? 'Online' : 'Offline')) + '</div></div>' +
      (f.joinable ? '<span class="hf-tag join">Join</span>' : '') + '</button>').join('');
  }

  async function gameMenu(g) {
    const items = [
      { id: 'play', label: 'Play', icon: 'play' },
      { id: 'edit', label: 'Edit game', icon: 'edit' },
      { id: 'fav', label: g.favorite ? 'Remove from favorites' : 'Add to favorites', icon: 'star' },
      { id: 'pin', label: g.pinned ? 'Unpin from Home' : 'Pin to Home', icon: 'pin' },
      { id: 'coop', label: g.coop ? 'Not a co-op game' : 'Mark as co-op', icon: 'users' },
      { id: 'cols', label: 'Collections' + ((g.collections || []).length ? ' (' + g.collections.join(', ') + ')' : ''), icon: 'grid' },
      { id: 'tv', label: 'TV settings for this game' + (g.display ? ' (' + displayLabel(g.display) + ')' : ''), icon: 'monitor' }
    ];
    const alts = g.launch && Array.isArray(g.launch.alts) ? g.launch.alts : null;
    const REG = { usa: 'USA', world: 'World', europe: 'Europe', japan: 'Japan', other: 'Other' };
    if (alts && alts.length > 1) { const cur = alts.find((x) => x.file === (g.altFile || g.launch.file)) || alts[0]; items.splice(1, 0, { id: 'region', label: 'Version: ' + (REG[cur.region] || cur.region), icon: 'refresh' }); }
    // Friends who were in this game while you played it.
    let mates = [];
    try { mates = await api.friendPlayedWith(g.id); } catch (_) { mates = []; }
    if (Array.isArray(mates) && mates.length) items.splice(1, 0, { id: 'mates', label: 'Played with ' + mates.slice(0, 2).map((m) => m.name).join(', ') + (mates.length > 2 ? ' +' + (mates.length - 2) : ''), icon: 'users' });
    items.push(g.hidden ? { id: 'unhide', label: 'Unhide', icon: 'refresh' } : { id: 'hide', label: 'Hide from library', icon: 'x' });
    if (g.source === 'custom') items.push({ id: 'remove', label: 'Remove from library', icon: 'trash', danger: true });
    const pick = await openMenu(g.title, items);
    if (!pick) return;
    if (pick === 'play') return play(g.id);
    if (pick === 'edit') return openEdit(g);
    if (pick === 'cols') return editCollections(g);
    if (pick === 'mates') {
      const who = await openMenu('Played ' + g.title + ' with', mates.map((m) => ({ id: m.id, label: m.name + ' · ' + ago(m.last) + (m.mins ? ' · about ' + fmtHours(m.mins / 60) : ''), icon: 'user' })));
      if (who) openFriendProfile(who);
      return;
    }
    if (pick === 'tv') return displaySettings(g);
    if (pick === 'region') {
      const REG = { usa: 'USA', world: 'World', europe: 'Europe', japan: 'Japan', other: 'Other' };
      const cur = g.altFile || g.launch.file;
      const v = await openMenu('Which version?', alts.map((x, i) => ({ id: String(i), label: (REG[x.region] || x.region) + ' · ' + baseName(x.file), icon: x.file === cur ? 'check' : 'play' })));
      if (v == null) return;
      g.altFile = alts[Number(v)].file === g.launch.file ? null : alts[Number(v)].file;
      save(); toast('Plays the ' + (REG[alts[Number(v)].region] || alts[Number(v)].region) + ' version');
      return;
    }
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
      rows.push('<button class="mitem" data-nav data-key="pf-stats" data-act="stats">' + icon('chart') + '<span>Play time</span></button>');
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
        if (act === 'stats') return openStats();
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
          '<p class="hint">xbl.io (OpenXBL) is a free service that reads your Xbox profile and friends for apps like this one. Your key stays on this ' + PCW + ', encrypted.</p>' +
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
          '<p class="hint">Your friends list on Steam must be public (Profile › Edit Profile › Privacy Settings). The key stays on this ' + PCW + ', encrypted.</p>' +
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
  // all = true: "Find all art" replaces the tile and background of every game.
  async function autoArt(loud, all) {
    if (OVERLAY || S.artRunning) return;
    try { S.artOn = await api.artStatus(); } catch (_) { S.artOn = false; }
    if (!S.artOn) return;
    const todo = all ? games().slice() : games().filter((g) => (!g.art || !g.art.tile || !g.art.hero) && !g.artTried);
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
          const want = all ? { tile: true, hero: true } : { tile: !(g.art && g.art.tile), hero: !(g.art && g.art.hero) };
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
    if (loud || found) toast(found ? (all ? 'New art for ' : 'Added art for ') + found + ' game' + (found === 1 ? '' : 's') : 'No new art found');
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
        if (el.dataset.act === 'friend') return friendMenu(el.dataset.friend);
        if (el.dataset.act === 'friend-recent') return openFriendProfile(el.dataset.friend);
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
      list.innerHTML = friendSectionsHTML(fr) + playedWithHTML(fr);
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
      const ok = await confirmBox('New version available · ' + r.version, (r.notes ? r.notes + ' ' : '') + 'Update now? ' + (TVAPP ? 'Couch TV' : 'The launcher') + ' restarts by itself; it only takes a few seconds.', 'Update now', false, { cancelLabel: 'Later', focusOk: true });
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
    let cfg = null;
    try { cfg = await api.dcRpcStatus(); } catch (_) { cfg = null; }
    const pick = await openMenu('Discord pins', [{ id: 'add', label: 'Paste a copied Discord link', icon: 'plus' }]
      .concat(pins.map((p, i) => ({ id: 'rm' + i, label: 'Remove “' + p.name + '”', icon: 'trash', danger: true })))
      .concat(cfg && cfg.configured ? [{ id: 'unlink', label: 'Disconnect Discord calls', icon: 'exit', danger: true }] : [{ id: 'link', label: 'Connect Discord for calls', icon: 'link' }]));
    if (!pick) return;
    if (pick === 'link') return discordConnect();
    if (pick === 'unlink') { try { await api.dcRpcDisconnect(); } catch (_) { /* gone */ } toast('Discord calls disconnected'); return; }
    if (pick.startsWith('rm')) { pins.splice(Number(pick.slice(2)), 1); save(); toast('Removed'); return; }
    let url = '';
    try { url = await api.discordClipboard(); } catch (_) { /* empty */ }
    let kind;
    try { kind = await api.discordCheck(url); }
    catch (_) {
      await confirmBox('Copy a link in Discord first', 'In Discord, right-click a text channel, voice channel or server and choose Copy Link (or copy an invite link). Then come back and choose Paste again.', 'OK');
      return;
    }
    let voice = false;
    if (kind === 'channel') {
      const t = await openMenu('What is this channel?', [{ id: 'voice', label: 'Voice channel (call)', icon: 'headset' }, { id: 'text', label: 'Text chat', icon: 'chat' }]);
      if (!t) return;
      voice = t === 'voice';
    }
    const name = await osk('Name this pin', kind === 'invite' ? 'Invite' : kind === 'server' ? 'Server' : voice ? 'Voice' : 'Channel', 'like Squad voice');
    if (!name || !name.trim()) return;
    pins.push({ name: name.trim().slice(0, 40), url, kind, voice });
    save();
    toast('Pinned ' + name.trim());
  }

  async function storesMenu() {
    const pick = await openMenu('Stores', [
      { id: 'steam', label: 'Steam Store (Big Picture)', icon: 'store' },
      { id: 'xbox', label: 'Xbox app (Game Pass)', icon: 'store' },
      { id: 'msstore', label: 'Microsoft Store', icon: 'store' },
      { id: 'epic', label: 'Epic Games Store', icon: 'store' }
    ].filter((x) => !(IS_MAC && (x.id === 'xbox' || x.id === 'msstore'))));
    if (!pick) return;
    try { await api.openStore(pick); toast('Opening ' + { steam: 'the Steam Store', xbox: 'the Xbox app', msstore: 'the Microsoft Store', epic: 'the Epic Games Store' }[pick]); }
    catch (e) { toast(e.message, true); }
  }

  // One-time setup of Discord's own connection, through your own Discord app.
  function discordConnect() {
    return new Promise((resolve) => {
      let appId = '', ok = false;
      const layer = openLayer({
        html: '<div class="dialog confirm dc-connect"><h2>Connect Discord for calls</h2>' +
          '<ol class="steps"><li>Choose <b>Open developer page</b>, sign in to Discord, press <b>New Application</b>, call it <b>Couch Launcher</b> and create it.</li>' +
          '<li>Copy the <b>Application ID</b>, come back and choose <b>Paste App ID</b>.</li>' +
          '<li>Open <b>OAuth2</b>: under Redirects add <b>http://127.0.0.1</b> and save. Then <b>Reset Secret</b>, copy it, come back and choose <b>Paste secret</b>.</li>' +
          '<li>Discord pops up <b>Authorize</b>: approve it.</li></ol>' +
          '<p class="hint dc-status">Your app’s ID and secret stay on this ' + PCW + ', encrypted. If Discord says the app isn’t allowed, add yourself under <b>App Testers</b> on the developer page.</p>' +
          '<div class="dialog-foot"><button class="btn big" data-nav data-key="dk-cancel" data-act="cancel">Cancel</button>' +
          '<button class="btn big" data-nav data-key="dk-site" data-act="site">' + icon('link') + 'Open developer page</button>' +
          '<button class="btn big" data-nav data-key="dk-id" data-act="id">' + icon('key') + 'Paste App ID</button>' +
          '<button class="btn big primary" data-nav data-key="dk-secret" data-act="secret">' + icon('key') + 'Paste secret</button></div></div>',
        focus: 'dk-site',
        onActivate: async (el) => {
          const act = el.dataset.act;
          const status = (t, bad) => { const p = $('.dc-status', layer.el); if (p) { p.textContent = t; p.classList.toggle('bad', !!bad); } };
          if (act === 'cancel') return closeLayer(layer);
          if (act === 'site') { try { await api.openDiscordDevPage(); } catch (e) { toast(e.message, true); } return; }
          let clip = '';
          try { clip = (await api.discordClipboard()).trim(); } catch (_) { clip = ''; }
          if (act === 'id') {
            if (!/^\d{15,25}$/.test(clip)) return status('Copy the Application ID first (a long number), then choose Paste App ID.', true);
            appId = clip; status('App ID saved ✓  Now copy the Client Secret and choose Paste secret.');
            return setFocus($('[data-key="dk-secret"]', layer.el));
          }
          if (act === 'secret') {
            if (!appId) return status('Paste the App ID first.', true);
            if (!clip || /^\d+$/.test(clip)) return status('Copy the Client Secret (OAuth2 › Reset Secret), then choose Paste secret.', true);
            status('Check Discord: approve “Couch Launcher” in the box it shows…');
            try {
              const me = await api.dcRpcConnect(appId, clip);
              ok = true; toast('Discord connected as ' + me.name); closeLayer(layer);
            } catch (e) { status(e.message, true); }
          }
        },
        onBack: () => closeLayer(layer),
        onClose: () => resolve(ok),
        prompts: () => [['A', 'Select'], ['B', 'Cancel']]
      });
    });
  }

  // Is "make it the main monitor while playing" on for this game (its own choice, or all games')?
  const mainFor = (g) => (g && g.display && typeof g.display.main === 'boolean' ? g.display.main : !!S.lib.settings.mainWhilePlaying);
  // Per-game resolution / refresh rate / HDR on the chosen display (put back when the game ends).
  const displayLabel = (d) => [d.main ? 'main monitor' : '', d.w ? d.w + '×' + d.h : '', d.hz ? d.hz + ' Hz' : '', d.hdr === 'on' ? 'HDR on' : d.hdr === 'off' ? 'HDR off' : ''].filter(Boolean).join(', ') || 'Normal';
  async function displaySettings(g) {
    let info = null;
    try { info = await api.displayModes(); } catch (_) { info = null; }
    if (!info || !info.modes || !info.modes.length) { toast('Display settings need Windows', true); return; }
    for (;;) {
      const d = g.display || {};
      const pick = await openMenu('TV settings · ' + g.title, [
        // For games that only open on Windows' main monitor: the launcher's monitor becomes the
        // main one while this game runs (the screens blink once at the start and once at the end).
        { id: 'main', label: 'Make it the main monitor while playing: ' + (mainFor(g) ? 'On' : 'Off') + (typeof d.main === 'boolean' ? '' : ' (like all games)'), icon: 'monitor' },
        { id: 'res', label: 'Resolution: ' + (d.w ? d.w + '×' + d.h : 'Normal (' + info.current.w + '×' + info.current.h + ')'), icon: 'monitor' },
        { id: 'hz', label: 'Refresh rate: ' + (d.hz ? d.hz + ' Hz' : 'Normal (' + info.current.hz + ' Hz)'), icon: 'refresh' }
      ].concat(info.hdr && info.hdr.supported ? [{ id: 'hdr', label: 'HDR: ' + (d.hdr === 'on' ? 'On' : d.hdr === 'off' ? 'Off' : 'Normal (' + (info.hdr.enabled ? 'on' : 'off') + ')'), icon: 'palette' }] : [])
        .concat(g.display ? [{ id: 'reset', label: 'Back to normal for this game', icon: 'x' }] : []));
      if (!pick) return;
      const nd = Object.assign({}, d);
      if (pick === 'reset') { delete g.display; save(); toast('This game uses your normal display settings'); return; }
      if (pick === 'main') {
        const all = !!S.lib.settings.mainWhilePlaying;
        if (mainFor(g)) { if (all) nd.main = false; else delete nd.main; }
        else {
          const ok = await confirmBox('Open ' + g.title + ' on this monitor?', 'For games that only open on Windows’ main monitor. While it runs, the launcher’s monitor becomes the main one (your taskbar moves there too). Your screens blink once when the game starts and once when it ends.', 'Turn on', false);
          if (!ok) continue;
          if (all) delete nd.main; else nd.main = true;
        }
      }
      if (pick === 'res') {
        const sizes = []; for (const m of info.modes) if (!sizes.some((x) => x.w === m.w && x.h === m.h)) sizes.push({ w: m.w, h: m.h });
        const r = await openMenu('Resolution', [{ id: 'n', label: 'Normal', icon: 'check' }].concat(sizes.slice(0, 14).map((x) => ({ id: x.w + 'x' + x.h, label: x.w + ' × ' + x.h, icon: 'monitor' }))));
        if (!r) continue;
        if (r === 'n') { delete nd.w; delete nd.h; } else { const [w, h] = r.split('x').map(Number); nd.w = w; nd.h = h; if (nd.hz && !info.modes.some((m) => m.w === w && m.h === h && m.hz === nd.hz)) delete nd.hz; }
      }
      if (pick === 'hz') {
        const w = nd.w || info.current.w, h = nd.h || info.current.h;
        const rates = [...new Set(info.modes.filter((m) => m.w === w && m.h === h).map((m) => m.hz))].sort((a, b) => b - a);
        const r = await openMenu('Refresh rate', [{ id: 'n', label: 'Normal', icon: 'check' }].concat(rates.map((hz) => ({ id: String(hz), label: hz + ' Hz', icon: 'refresh' }))));
        if (!r) continue;
        if (r === 'n') delete nd.hz; else nd.hz = Number(r);
      }
      if (pick === 'hdr') {
        const r = await openMenu('HDR', [{ id: 'n', label: 'Normal', icon: 'check' }, { id: 'on', label: 'On for this game', icon: 'palette' }, { id: 'off', label: 'Off for this game', icon: 'x' }]);
        if (!r) continue;
        if (r === 'n') delete nd.hdr; else nd.hdr = r;
      }
      if (Object.keys(nd).length) g.display = nd; else delete g.display;
      save();
      toast('Saved. It switches when ' + g.title + ' starts and goes back when it ends.');
    }
  }

  // Sleep timer: closes the game the normal way (so it saves), then sleeps or turns off the PC.
  async function sleepMenu() {
    let cur = null;
    try { cur = await api.sleepGet(); } catch (_) { cur = null; }
    const left = cur ? Math.max(1, Math.round((cur.at - Date.now()) / 60000)) : 0;
    const act = S.lib.settings.sleepAction === 'sleep' ? 'sleep' : 'shutdown';
    const len = (m) => (m < 60 ? m + ' minutes' : m / 60 + (m === 60 ? ' hour' : ' hours'));
    const items = [15, 30, 45, 60, 90, 120].map((m) => ({ id: 'm' + m, label: len(m), icon: 'moon' }));
    items.push({ id: 'action', label: 'When it ends: ' + (act === 'sleep' ? 'put the PC to sleep' : 'turn off the PC'), icon: 'power' });
    if (cur) items.unshift({ id: 'off', label: 'Turn the timer off (' + left + ' min left)', icon: 'x' });
    const c = await openMenu(cur ? 'Sleep timer · ' + left + ' min left' : 'Sleep timer', items);
    if (!c) return;
    try {
      if (c === 'off') { await api.sleepSet(0); toast('Sleep timer off'); return; }
      if (c === 'action') { S.lib.settings.sleepAction = act === 'sleep' ? 'shutdown' : 'sleep'; save(); return sleepMenu(); }
      const m = Number(c.slice(1));
      await api.sleepSet(m, act);
      toast((act === 'sleep' ? 'The PC sleeps' : 'The PC turns off') + ' in ' + len(m) + '. Your game closes first so it can save.');
    } catch (e) { toast(e.message, true); }
  }
  async function powerMenu() {
    const pick = await openMenu('Power', [
      { id: 'settings', label: 'Settings', icon: 'gear' },
      { id: 'rescan', label: 'Rescan games', icon: 'refresh' },
      { id: 'exit', label: 'Exit to desktop', icon: 'exit' },
      { id: 'sleep', label: 'Sleep', icon: 'moon' },
      { id: 'restart', label: IS_MAC ? 'Restart…' : 'Restart PC', icon: 'restart' },
      { id: 'shutdown', label: IS_MAC ? 'Shut Down…' : 'Shut down PC', icon: 'power', danger: true }
    ]);
    if (!pick) return;
    if (pick === 'settings') return go('settings');
    if (pick === 'rescan') return rescan(null, false);
    return power(pick);
  }
  async function power(action) {
    if (action === 'restart' && !(await confirmBox(IS_MAC ? 'Are you sure you want to restart your Mac now?' : 'Restart the PC?', IS_MAC ? 'Apps will be asked to quit; anything unsaved may be lost.' : 'Anything unsaved in other programs will be lost.', 'Restart', true))) return;
    if (action === 'shutdown' && !(await confirmBox(IS_MAC ? 'Are you sure you want to shut down your Mac now?' : 'Shut down the PC?', IS_MAC ? 'Apps will be asked to quit; anything unsaved may be lost.' : 'Anything unsaved in other programs will be lost.', IS_MAC ? 'Shut Down' : 'Shut down', true))) return;
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
        if (to === 'clips') return openClips();
        if (to === 'tv' || to === 'youtube') return openApp(to);
        if (to === 'search') { if (S.view !== 'library') go('library', 's-search'); return searchPrompt(); }
        return go(to);
      }
      case 'add': return openEdit(null);
      case 'profile': return openProfile();
      case 'stores': return storesMenu();
      case 'news': { const it = S.news && S.news.items[Number(el.dataset.i)]; if (it) openNews(it); return; }
      case 'deal': return dealMenu(dealItems()[Number(el.dataset.i)]);
      case 'steam-install': {
        const g = ((S.notInst && S.notInst.list) || []).find((x) => x.appid === el.dataset.app);
        if (!g) return;
        const pick = await openMenu(g.title + (g.hours ? ' · ' + fmtHours(g.hours) + ' played' : ''), [{ id: 'install', label: 'Install with Steam', icon: 'download' }, { id: 'store', label: 'Open its Steam store page', icon: 'store' }]);
        try {
          if (pick === 'install') { await api.steamInstall(g.appid); toast('Steam is opening the install screen for ' + g.title); }
          if (pick === 'store') await api.friendStore(null, { appid: g.appid });
        } catch (e) { toast(e.message, true); }
        return;
      }
      case 'friend': return friendMenu(el.dataset.friend);
      case 'steady': return steadyMenu();
      case 'phone-remote': return phoneRemote();
      case 'pops-test': try { await api.popsTest(); } catch (_) { /* nothing to show */ } return;
      case 'dc-msgs': return dcMessagesMenu();
      case 'pick-mode': {
        const m = await openMenu('Players in emulator games', [{ id: 'saved', label: 'Use my saved players (no screen)', icon: 'check' }, { id: 'ask', label: 'Ask “Who’s playing?” every time', icon: 'users' }, { id: 'off', label: 'Leave as set in the emulator', icon: 'x' }]);
        if (m) { s.pickPlayers = m; save(); refreshContent(); }
        return;
      }
      case 'players-setup': return setUpPlayersNow();
      case 'medal-key': {
        const which = el.dataset.which;
        const keys = ['F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'Shift+F8', 'Ctrl+F8', 'Alt+F8', 'Shift+F9', 'Ctrl+F9', 'Alt+F9'];
        const cur = which === 'clip' ? (s.medalClipKey || 'F8') : s.medalShotKey;
        const items = keys.map((k) => ({ id: k, label: k, icon: k === cur ? 'check' : 'key' }));
        if (which === 'shot') items.unshift({ id: '-', label: 'None (hold Share for clips only)', icon: cur ? 'x' : 'check' });
        const k = await openMenu(which === 'clip' ? 'Medal’s clip key' : 'Medal’s screenshot key', items);
        if (!k) return;
        if (which === 'clip') s.medalClipKey = k; else s.medalShotKey = k === '-' ? '' : k;
        save(); return refreshContent();
      }
      case 'share-test': return shareTest();
      case 'medal-xbox': {
        const m = await openMenu('Xbox controllers', [
          { id: 'auto', label: 'Share button when it can be read, else View combo', icon: (s.medalXbox || 'auto') === 'auto' ? 'check' : 'pad' },
          { id: 'share', label: 'Share button only (Bluetooth)', icon: s.medalXbox === 'share' ? 'check' : 'pad' },
          { id: 'combo', label: 'Hold View + RB (clip) / LB (screenshot)', icon: s.medalXbox === 'combo' ? 'check' : 'pad' }]);
        if (m) { s.medalXbox = m; save(); refreshContent(); }
        return;
      }
      case 'bk-to': {
        let b = S.backupInfo;
        if (!b) { try { b = S.backupInfo = await api.backupStatus(); } catch (_) { b = {}; } }
        const has = (id) => (b.dests || []).find((d) => d.id === id);
        const c = await openMenu('Back up saves to', [
          { id: 'gdrive', label: has('gdrive') ? 'Google Drive (' + has('gdrive').path + ')' : 'Google Drive (needs Google Drive for desktop)', icon: s.backupTo === 'gdrive' ? 'check' : 'folder' },
          { id: 'onedrive', label: has('onedrive') ? 'OneDrive (' + has('onedrive').path + ')' : 'OneDrive (not set up on this ' + PCW + ')', icon: s.backupTo === 'onedrive' ? 'check' : 'folder' },
          { id: 'folder', label: 'A folder…' + (s.backupFolder ? ' (' + s.backupFolder + ')' : ''), icon: s.backupTo === 'folder' ? 'check' : 'folder' },
          { id: 'off', label: 'Don’t back up', icon: (s.backupTo || 'off') === 'off' ? 'check' : 'x' }]);
        if (!c) return;
        if (c === 'gdrive' && !has('gdrive')) { toast('Install Google Drive for desktop and sign in, then choose this again. Backups go to My Drive › Couch Launcher.', true); return; }
        if (c === 'onedrive' && !has('onedrive')) { toast('Sign in to OneDrive on this ' + PCW + ' first, then choose this again.', true); return; }
        if (c === 'folder') { const p = await browse({ title: 'Where should save backups go?', folder: true, hint: 'A drive or folder (a USB drive works too)' }); if (!p) return; s.backupFolder = p; }
        s.backupTo = c; save(); S.backupInfo = undefined; refreshContent();
        if (c !== 'off') toast('Backups on. Your saves are copied before and after each game.');
        return;
      }
      case 'bk-keep': { const k = await openMenu('Copies to keep (per emulator)', [5, 10, 20, 30].map((n) => ({ id: String(n), label: n + ' copies', icon: (Number(s.backupKeep) || 10) === n ? 'check' : 'refresh' }))); if (k) { s.backupKeep = Number(k); save(); refreshContent(); } return; }
      case 'bk-now': {
        const id = el.dataset.src || null;
        toast('Backing up…');
        try {
          const r = await api.backupNow(id);
          const bad = (r.results || []).filter((x) => x.result && !x.result.done);
          if (r.done && !bad.length) toast('Backed up ' + (id ? (r.results[0] || {}).name || '' : r.done + ' emulator' + (r.done === 1 ? '' : 's')));
          else if (bad.length) toast((r.done ? 'Backed up ' + r.done + '. ' : '') + bad.slice(0, 2).map((x) => x.name + ': ' + backupWhy(x.result)).join(' · ') + (bad.length > 2 ? ' · +' + (bad.length - 2) + ' more' : ''), !r.done);
          else toast('Nothing to back up');
        } catch (e) { toast(e.message, true); }
        S.backupInfo = undefined; return refreshContent();
      }
      case 'bk-restore': {
        const id = el.dataset.src;
        let list = [];
        try { list = await api.backupList(id); } catch (e) { toast(e.message, true); return; }
        const WHY = { before: 'before playing', after: 'after playing', manual: 'backed up by hand', 'before-restore': 'before a restore' };
        const pick = await openMenu('Restore which copy?', list.map((x) => ({ id: x.id, label: new Date(x.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) + ' · ' + (WHY[x.why] || x.why), icon: 'refresh' })));
        if (!pick) return;
        if (!(await confirmBox('Put this copy back?', 'Your current saves are copied first, so you can undo this from the same list.', 'Restore', true))) return;
        try { await api.backupRestore(id, pick); toast('Saves restored'); } catch (e) { toast(e.message, true); }
        S.backupInfo = undefined; return refreshContent();
      }
      case 'ra-on': {
        const user = await osk('RetroAchievements username', S.raUser || '', 'Your username');
        if (!user) return;
        const key = await osk('Web API key (retroachievements.org › Settings › Keys)', '', '', { secret: true });
        if (!key) return;
        try { await api.raConnect(user, key); await refreshRa(); toast('RetroAchievements connected'); } catch (e) { toast(e.message, true); }
        return refreshContent();
      }
      case 'ra-off': { try { await api.raDisconnect(); await refreshRa(); toast('RetroAchievements disconnected'); } catch (e) { toast(e.message, true); } return refreshContent(); }
      case 'emu-updates': {
        toast('Checking for emulator updates…');
        try { S.emuUpdates = await api.checkEmuUpdates(); } catch (e) { toast(e.message, true); return; }
        const n = Object.values(S.emuUpdates).filter((u) => u.status === 'update').length;
        toast(n ? n + ' update' + (n === 1 ? '' : 's') + ' available' : 'Your emulators are up to date');
        return refreshContent();
      }
      case 'emu-update': {
        const id = el.dataset.src;
        try {
          const r = await api.updateEmu(id);
          if (r && r.lib) S.lib.platforms = r.lib.platforms;
          if (S.emuUpdates) S.emuUpdates[id] = { status: 'current' };
          toast(S.info.emulators[id].name + ' updated' + (r.tag ? ' to ' + r.tag : ''));
        } catch (e) { toast(e.message, true); }
        return refreshContent();
      }
      case 'emu-page': S.setTab = 'emulators'; S.emuFound = undefined; refreshContent(); $('#content').scrollTop = 0; { const f = $('#content [data-nav]'); if (f) setFocus(f); } return;
      case 'emu-back': S.setTab = 'platforms'; refreshContent(); { const f = $('[data-key="p-emus"]'); if (f) setFocus(f); } return;
      case 'emu-more': S.emuShowAll = true; return refreshContent();
      case 'emu-toggle': { const c = S.lib.platforms[el.dataset.src]; c.enabled = c.enabled === false; save(); refreshContent(); return rescan(el.dataset.src, true); }
      case 'emu-find': case 'emu-setup': {
        const only = a === 'emu-setup' ? el.dataset.src || null : null;
        toast(only ? 'Setting up ' + S.info.emulators[only].name + '…' : 'Looking for emulators…');
        try {
          const r = await api.setupFoundEmulators(only);
          adoptScan(r);
          S.emuFound = undefined;
          toast(r.done.length ? 'Set up ' + r.done.join(', ') : 'Nothing new found. Set a program by hand under “Show more emulators”.');
        } catch (e) { toast(e.message, true); }
        if (S.setTab !== 'emulators') { S.setTab = 'emulators'; }
        return refreshContent();
      }
      case 'tv-open': return TVAPP ? TV().open() : openApp('tv');
      case 'tv-report': try { await api.tvReport(); toast('Copied. Paste it where you’re asked for it (start a video first, so it shows how that looks).'); } catch (e) { toast(e.message, true); } return;
      case 'tvapp-full': try { S.tvFull = !!(await api.tvFullscreen()); } catch (e) { toast(e.message, true); } return refreshContent();
      case 'yt-reset': {
        if (!(await confirmBox('Sign out of YouTube?', 'YouTube forgets your account and settings on this ' + PCW + '.', 'Sign out', true))) return;
        try { await api.youtubeReset(); toast('Signed out of YouTube'); } catch (e) { toast(e.message, true); }
        return;
      }
      case 'tv-mode': s.tvMode = el.dataset.mode === 'light' ? 'light' : 'dark'; if (TVAPP) { tvAppTheme(); S.theme = window.applyTheme(s, true); } save(); return refreshContent();
      case 'tv-signin': return TV().signIn();
      case 'tv-signout': {
        if (!(await confirmBox('Sign out of Stremio?', 'Movies & TV goes back to Cinemeta and OpenSubtitles. Nothing is deleted from your account.', 'Sign out', true))) return;
        try { await api.tvLogout(); toast('Signed out of Stremio'); } catch (e) { toast(e.message, true); }
        return loadTvSettings();
      }
      case 'tv-quality': { const q = await openMenu('Preferred quality', [{ id: '4K', label: '4K', icon: 'star' }, { id: '1080p', label: '1080p (Full HD)', icon: 'monitor' }, { id: '720p', label: '720p (smaller, starts faster)', icon: 'monitor' }]); if (q) { s.tvQuality = q; save(); refreshContent(); } return; }
      case 'tv-subs': {
        const l = await openMenu('Subtitles', [['off', 'Off'], ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese'], ['it', 'Italian']].map(([id, label]) => ({ id, label, icon: (s.tvSubLang || 'en') === id ? 'check' : 'chat' })));
        if (l) { s.tvSubLang = l; save(); refreshContent(); }
        return;
      }
      case 'tv-mpv': { if (await TV().mpvSetup()) loadTvSettings(); return; }
      case 'collections': return collectionsMenu();
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
        let p = await browse({ title: 'Find the ' + e.name + ' program', exts: IS_MAC ? ['.app'] : ['.exe', '.ps1', '.bat', '.cmd'], hint: IS_MAC ? 'Pick ' + e.name + ' in Applications' : 'Pick ' + (src === 'dolphin' ? 'Dolphin.exe' : src === 'rpcs3' ? 'rpcs3.exe' : src === 'ryujinx' ? 'Ryujinx.exe' : (e.exe || 'the emulator .exe')) + ', or an EmuDeck .ps1 launcher' });
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
      case 'ui-style': s.uiStyle = el.dataset.id; return themeChanged();
      case 'main-mon': {
        const r = await openMenu('Games that open on the main monitor', [
          { id: 'move', label: 'Move them to this screen (works for most games)', icon: s.mainWhilePlaying ? 'monitor' : 'check' },
          { id: 'main', label: 'Make this the main monitor while playing (every game)', icon: s.mainWhilePlaying ? 'check' : 'monitor' }
        ]);
        if (!r) return;
        s.mainWhilePlaying = r === 'main'; save(); refreshContent();
        toast(r === 'main' ? 'Every game: this screen becomes the main monitor while you play' : 'Games are moved to this screen');
        return;
      }
      case 'idle-time': {
        const opts = [2, 5, 10, 30, 0];
        const r = await openMenu('Idle screen', opts.map((m) => ({ id: String(m), label: m ? 'After ' + m + ' minutes' : 'Off', icon: m === idleMinutes() ? 'check' : (m ? 'moon' : 'x') })));
        if (r == null) return;
        s.idleMinutes = Number(r); save(); refreshContent();
        if (s.idleMinutes) { const k = $('[data-key="d-idle"]'); if (k) setFocus(k); }
        return;
      }
      case 'full-toggle': {
        const full = !S.info.windowed;
        if (!(await confirmBox(full ? 'Open in a window?' : 'Open full screen?', 'The launcher restarts to switch.', 'Restart', false))) return;
        toast('Restarting…');
        try { await api.setWindowed(full); } catch (e) { toast(e.message, true); }
        return;
      }
      case 'accent': s.accent = el.dataset.c || null; return themeChanged();
      case 'set-toggle': s[el.dataset.k] = el.getAttribute('aria-checked') !== 'true'; if (el.dataset.k === 'useArtBackground') currentBg = undefined; return themeChanged();
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
      case 'art-all': {
        const n = games().length;
        if (!(await confirmBox('Find all art?', 'Gets a new tile and background for all ' + n + ' games from SteamGridDB, replacing the art they have now (including pictures you picked yourself). Games it can’t find keep their art.', 'Replace all art', true))) return;
        return autoArt(true, true);
      }
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
    const titles = games().map((g) => g.title);
    const v = await osk('Search your games', S.libSearch, 'Game name', {
      suggest: (t) => { const q = t.trim().toLowerCase(); if (!q) return []; return titles.filter((x) => x.toLowerCase().includes(q)).sort((a, b) => (b.toLowerCase().startsWith(q) - a.toLowerCase().startsWith(q)) || a.length - b.length); }
    });
    if (v === null) return;
    S.libSearch = v;
    S.baseFocus = 's-search';
    if (S.view !== 'library') go('library', 's-search'); else refreshContent();
    const first = $('#content .grid [data-nav]');
    if (first && v) setFocus(first);
  }
  // Discord's message notifications as the launcher's pop-ups: on / off, and Discord's permission.
  async function dcMessagesMenu() {
    const s = S.lib.settings;
    let st = null;
    try { st = await api.dcRpcStatus(); } catch (_) { st = null; }
    const on = s.dcMessages !== false;
    const items = [{ id: 'toggle', label: on ? 'Turn off' : 'Turn on', icon: on ? 'x' : 'check' }];
    if (st && st.configured && st.connected && !st.messages) items.push({ id: 'allow', label: 'Allow in Discord (it shows a box to approve)', icon: 'link' });
    if (!st || !st.configured) items.push({ id: 'link', label: 'Connect Discord for calls', icon: 'link' });
    const pick = await openMenu('Discord messages as pop-ups', items);
    if (!pick) return;
    if (pick === 'link') { await discordConnect(); refreshContent(); return; }
    if (pick === 'toggle') { s.dcMessages = !on; save(); refreshContent(); if (on || !st || !st.connected || st.messages) return; }
    toast('Check Discord: approve “Couch Launcher” in the box it shows…');
    try {
      const r = await api.dcRpcReapprove();
      toast(r && r.messages ? 'Discord message pop-ups are on' : 'Discord didn’t give that permission', !(r && r.messages));
    } catch (e) { toast(e.message, true); }
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
    noteActivity();
    const top = topLayer();
    if (top && top.onButton && top.onButton(b)) return;
    const el = currentFocus();
    switch (b) {
      case 'A': return activate(el);
      case 'B':
        if (top) return top.onBack ? top.onBack() : closeLayer(top);
        if (TVAPP) return TV().open(); // Couch TV's Settings: back to what you were watching
        if (S.view === 'settings' && S.setTab === 'emulators') return activate({ dataset: { action: 'emu-back' } });
        if (S.view !== 'home') return go('home');
        if (el && el.closest('.home-news')) { const c = $('[data-key="c-lib"]'); if (c) setFocus(c); } // back up from the news
        return;
      case 'Y':
        if (TVAPP) return;
        if (!top && el && el.dataset.game) { const g = byId(el.dataset.game); if (g) openEdit(g); }
        return;
      case 'MENU':
        if (top || TVAPP) return;
        if (el && el.dataset.game) { const g = byId(el.dataset.game); if (g) gameMenu(g); return; }
        return powerMenu();
      case 'LB': case 'RB': {
        if (top || TVAPP) return;
        // Steps through every icon in the dock. Home, My library and Settings slide over to that
        // page; the ones that open something (Search, Clips, Movies & TV, YouTube, Friends) are
        // highlighted, and A opens them.
        const onDock = el && el.closest && el.closest('#topbar') && el.dataset.action === 'nav' ? el.dataset.to : null;
        const i = DOCK.indexOf(onDock || S.view);
        const n = b === 'LB' ? Math.max(0, i - 1) : Math.min(DOCK.length - 1, i + 1);
        if (n === i) return;
        const to = DOCK[n];
        if (!onDock && el && !el.closest('#topbar')) S.pageFocus = { view: S.view, key: el.dataset.key || null };
        if (DOCK_VIEWS.includes(to)) {
          if (to !== S.view) { S.pageFocus = null; return go(to); }
          // Back to the page you're on: where you were before stepping onto the dock.
          const pf = S.pageFocus && S.pageFocus.view === to && S.pageFocus.key;
          const views = $$('#view .view'), cur = views[views.length - 1];
          const back = (pf && cur && $('[data-key="' + cssEsc(pf) + '"]', cur)) || (cur && $('[data-nav]', cur));
          if (back) setFocus(back);
          return;
        }
        const btn = $('#topbar [data-key="nav-' + to + '"]');
        if (btn) setFocus(btn);
        return;
      }
      case 'LT': return page('up');
      case 'RT': return page('down');
      case 'HOME': if (!TVAPP) toggleGuide(!!S.playing); return;
      default: return;
    }
  }

  // ---------------------------------------------------------------- controller input
  // ---------------------------------------------------------------- Idle screen
  // After a few minutes with nothing pressed (and no game, movie or video going), a slow
  // slideshow of your games' art with the time, like a console's. Any button, key or the mouse
  // brings the launcher back (that press does nothing else). Settings › Display › Idle screen.
  let lastActivity = Date.now(), idle = null;
  function noteActivity(mouse) {
    lastActivity = Date.now();
    if (idle && mouse && Date.now() - idle.openedAt > 800) closeIdle();
  }
  const idleMinutes = () => { const m = S.lib && S.lib.settings && S.lib.settings.idleMinutes; return m === 0 ? 0 : Number(m) || 5; };
  function idleArt() {
    const list = games().filter((g) => g.art && (g.art.hero || g.art.tile)).sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
    const pics = list.map((g) => ({ src: fileUrl(g.art.hero || g.art.tile), title: g.title, wide: !!g.art.hero }));
    for (let i = pics.length - 1; i > 3; i--) { const j = 4 + Math.floor(Math.random() * (i - 3)); [pics[i], pics[j]] = [pics[j], pics[i]]; } // newest few first, then mixed
    return pics;
  }
  function openIdle() {
    if (idle || OVERLAY || TVAPP) return;
    const pics = idleArt();
    const layer = openLayer({
      className: 'idle-layer',
      html: '<div class="idle-pics"><div class="idle-pic"></div><div class="idle-pic"></div></div><div class="idle-shade"></div>' +
        '<div class="idle-info"><div class="idle-time"></div><div class="idle-date"></div><div class="idle-game"></div></div>' +
        '<div class="idle-hint">Press any button</div>',
      onButton: () => { closeIdle(); return true; },
      onMove: () => { closeIdle(); return true; },
      onBack: () => closeIdle(),
      onKey: () => { closeIdle(); return true; },
      prompts: () => []
    });
    idle = { layer, pics, i: -1, slot: 0, openedAt: Date.now() };
    const el = layer.el;
    const tick = () => {
      const d = new Date();
      $('.idle-time', el).textContent = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      $('.idle-date', el).textContent = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    };
    const next = () => {
      if (!idle || !pics.length) return;
      idle.i = (idle.i + 1) % pics.length;
      const p = pics[idle.i];
      const slots = $$('.idle-pic', el);
      const cur = slots[idle.slot], other = slots[1 - idle.slot];
      other.style.backgroundImage = "url('" + p.src.replace(/'/g, '%27') + "')";
      other.classList.toggle('tile', !p.wide);
      other.classList.remove('show'); void other.offsetWidth; other.classList.add('show');
      cur.classList.remove('show');
      idle.slot = 1 - idle.slot;
      $('.idle-game', el).textContent = p.title;
    };
    tick(); next();
    idle.timers = [setInterval(tick, 10000), setInterval(next, reduce() ? 15000 : 9000)];
  }
  function closeIdle() {
    if (!idle) return;
    const x = idle; idle = null;
    (x.timers || []).forEach(clearInterval);
    closeLayer(x.layer);
    lastActivity = Date.now();
  }
  if (!OVERLAY && !TVAPP) {
    setInterval(() => {
      const mins = idleMinutes();
      if (idle || !mins || !S.lib) return;
      if (Date.now() - lastActivity < mins * 60e3) return;
      // Only when the launcher is what's on screen and nothing is playing or open.
      if (!document.hasFocus() || S.playing || S.tvPlaying || layers.length || document.querySelector('.tv-layer, .yt-layer')) return;
      openIdle();
    }, 15000);
  }

  const PADMAP = { 0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT', 8: 'VIEW', 9: 'MENU', 16: 'HOME' };
  const DIRS = { 12: 'up', 13: 'down', 14: 'left', 15: 'right' };
  const prevButtons = new Set();
  const held = { dir: null, since: 0, next: 0, count: 0 };
  const heldBtn = { b: null, since: 0, next: 0 };
  let suppressUntilRelease = true; // ignore buttons already held when the app starts / regains focus

  function setInput(kind, padId) {
    const changed = S.input !== kind || (padId && padKind(padId) !== S.glyphs);
    S.input = kind;
    if (padId) S.glyphs = padKind(padId);
    document.body.classList.toggle('hide-cursor', kind !== 'mouse');
    if (changed) updatePrompts();
  }

  let extPads = null, extAt = 0;
  api.on('pad:ext', (list) => { if (Array.isArray(list)) { extPads = list.map((p, i) => ({ id: String(p.id || 'Controller'), index: 'ext' + i, mapping: 'standard', connected: true, buttons: (p.buttons || []).map((on) => ({ pressed: !!on, value: on ? 1 : 0 })), axes: p.axes || [] })); extAt = performance.now(); wakePads(); } });
  // Per controller: the buttons and stick seen let go at least once. A button or stick that has
  // never been let go (a pedal or a stick that rests at one end, a device that reports a button
  // as always held) is left out, so it can't block every other press.
  const padSeen = new Map();
  let suppressAt = 0;
  let tvCheckAt = 0, tvIdle = 0;
  // While this screen isn't the one in use (it doesn't have the focus and the app core isn't
  // sending the controller here: a game is being played, or the guide is hidden) it looks
  // 4 times a second instead of 60. It did nothing with the controller in that state anyway;
  // this only stops it waking up 60 times a second behind a game. It is back at full speed the
  // moment it gets the focus or the controller is sent here, and at the latest a quarter of a
  // second later.
  let slowPoll = null, wasAway = false;
  const wakePads = () => { if (slowPoll) { clearTimeout(slowPoll); slowPoll = null; requestAnimationFrame(pollPads); } };
  window.addEventListener('focus', wakePads);
  document.addEventListener('visibilitychange', wakePads);
  function pollPads(now) {
    // The app core reads the controller too, and sends it here when this window is on top but
    // wasn't given the focus (it can't read the controller itself then).
    const ext = extPads && now - extAt < 400;
    const away = !document.hasFocus() && !ext;
    if (away && !S.tvPlaying) slowPoll = setTimeout(() => { slowPoll = null; pollPads(performance.now()); }, 250);
    else requestAnimationFrame(pollPads);
    if (S.tvPlaying) watchTvPlaying(now);
    if (away || S.tvPlaying) { wasAway = true; prevButtons.clear(); held.dir = null; suppressUntilRelease = true; suppressAt = now; return; }
    // (Just back: buttons still held from the game are ignored from this moment, as before.)
    if (wasAway) { wasAway = false; if (suppressUntilRelease) suppressAt = now; }
    let pads;
    try { pads = Array.from(navigator.getGamepads() || []); } catch (_) { return; }
    noteDirect(pads, now);
    // The app core only sends it while this window isn't really in front: then it's the one to use
    // (Chromium may still think it has the focus and give stale, unchanging readings).
    if (ext) pads = extPads;
    // A real controller (standard layout) is there: ignore other devices (wheels, pedals, remotes).
    const standard = pads.some((p) => p && p.connected && p.mapping === 'standard');
    const live = new Set();
    const down = new Set();
    let dir = null, dirMag = 0, activePad = null;
    for (const p of pads) {
      if (!p || !p.connected) continue;
      if (standard && p.mapping !== 'standard') continue;
      if (S.vpadsOn && isVirtualPad(p.id)) continue;
      const pk = String(p.index) + '|' + p.id;
      live.add(pk);
      let seen = padSeen.get(pk);
      if (!seen) { seen = { off: new Set(), stick: false }; padSeen.set(pk, seen); }
      for (let i = 0; i < p.buttons.length; i++) {
        const bt = p.buttons[i];
        const on = bt && (bt.pressed || bt.value > 0.5);
        if (!on) { seen.off.add(i); continue; }
        if (!seen.off.has(i)) continue;
        if (PADMAP[i]) { down.add(PADMAP[i]); activePad = p; }
        if (DIRS[i]) { dir = DIRS[i]; dirMag = 1; activePad = p; }
      }
      const ax = p.axes[0] || 0, ay = p.axes[1] || 0;
      const mag = Math.max(Math.abs(ax), Math.abs(ay));
      if (mag < 0.3) seen.stick = true;
      if (seen.stick && mag > 0.55 && mag > dirMag) {
        dir = Math.abs(ax) > Math.abs(ay) ? (ax > 0 ? 'right' : 'left') : (ay > 0 ? 'down' : 'up');
        dirMag = mag; activePad = p;
      }
    }
    for (const pk of padSeen.keys()) if (!live.has(pk)) padSeen.delete(pk);
    if (suppressUntilRelease) {
      if (!suppressAt) suppressAt = now;
      // Let go of everything (or 1.5 s passed: whatever is still held simply counts as held, so
      // it won't press anything until it's pressed again).
      if ((!down.size && !dir) || now - suppressAt > 1500) {
        suppressUntilRelease = false; suppressAt = 0;
        if (dir) { held.dir = dir; held.since = now; held.count = 0; held.next = now + 600; }
      }
      prevButtons.clear(); for (const b of down) prevButtons.add(b);
      return;
    }
    if (activePad) setInput('pad', activePad.id);
    for (const b of down) if (!prevButtons.has(b)) { button(b); heldBtn.b = b; heldBtn.next = now + 420; heldBtn.since = now; }
    // Some screens repeat a held button (the keyboard: X keeps deleting, LB/RB keep moving).
    const rl = topLayer();
    if (heldBtn.b && down.has(heldBtn.b) && rl && rl.repeat && rl.repeat.includes(heldBtn.b) && now >= heldBtn.next) {
      button(heldBtn.b);
      heldBtn.next = now + Math.max(45, 110 - (now - heldBtn.since) / 20);
    }
    if (heldBtn.b && !down.has(heldBtn.b)) heldBtn.b = null;
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

  // A movie that ended without the launcher hearing about it would leave the controller with the
  // player for good. Every few seconds while "playing", ask whether something is still playing.
  function watchTvPlaying(now) {
    if (!S.tvPlayingAt) S.tvPlayingAt = now;
    if (now - S.tvPlayingAt < 8000 || now - tvCheckAt < 3000) return;
    tvCheckAt = now;
    Promise.resolve().then(() => api.tvStatus()).then((st) => {
      if (!S.tvPlaying) return;
      if (st && st.playing === false) { if (++tvIdle >= 2) { S.tvPlaying = false; S.tvPlayingAt = 0; tvIdle = 0; suppressUntilRelease = true; } }
      else tvIdle = 0;
    }).catch(() => {});
  }

  // ---------------------------------------------------------------- keyboard & mouse
  const KEYMAP = { Enter: 'A', ' ': 'A', Escape: 'B', Backspace: 'B', y: 'Y', Y: 'Y', F2: 'Y', m: 'MENU', M: 'MENU', ContextMenu: 'MENU', q: 'LB', Q: 'LB', e: 'RB', E: 'RB', PageUp: 'LT', PageDown: 'RT', Delete: 'X', Home: 'HOME' };
  const KEYDIRS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
  document.addEventListener('keydown', (e) => {
    noteActivity();
    if (S.tvPlaying) { if (TVAPP) tvPlayerKey(e); return; } // the player has the keyboard (Couch TV: its window does, and passes the keys on)
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (TVAPP && ['Shift', 'CapsLock', 'NumLock', 'ScrollLock'].includes(e.key)) return; // (Shift + wheel is a mouse gesture: the pointer stays)
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
  // Couch TV, while something plays inside its window: the keys work the player's controls.
  //   Space / K play-pause · ← → scrub · J −10 s · L +30 s · ↑ ↓ (Cable TV: channels) · Enter select
  //   C subtitles · A audio · F full screen · Esc leave full screen, then back
  const PLAYER_KEYS = { ' ': 'TOGGLE', k: 'TOGGLE', Enter: 'A', Escape: 'ESC', Backspace: 'B', ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
    f: 'FULL', c: 'Y', y: 'Y', a: 'X', j: 'LB', l: 'RB', PageUp: 'RB', PageDown: 'LB' };
  const keyDownAt = {};
  function tvPlayerKey(e) {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const name = PLAYER_KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (!name) return;
    e.preventDefault();
    const t = Date.now();
    if (!e.repeat || !keyDownAt[name]) keyDownAt[name] = t;
    try { api.tvKey(name, !!e.repeat, t - keyDownAt[name]).catch(() => {}); } catch (_) { /* older app core */ }
  }
  let mouseTimer = null;
  let lastMouse = null;
  document.addEventListener('mousemove', () => noteActivity(true));
  document.addEventListener('mousemove', (e) => {
    // Menus opening under a still cursor also fire mouse events: only real movement counts.
    const p = [e.screenX, e.screenY];
    const moved = lastMouse && (Math.abs(p[0] - lastMouse[0]) + Math.abs(p[1] - lastMouse[1]) > 6);
    if (!lastMouse || moved) lastMouse = p;
    if (!moved) return;
    setInput('mouse');
    clearTimeout(mouseTimer);
    if (!TVAPP) mouseTimer = setTimeout(() => document.body.classList.add('hide-cursor'), 3000); // (Couch TV is a normal window: its pointer stays)
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
    // Going somewhere in the launcher: leave Movies & TV (and anything else open) first, so you
    // land there and not behind it. Opening Movies & TV again keeps it as it is.
    if (!(r.action === 'goto' && r.target === 'tv')) leaveApps();
    if (r.action === 'switch' && r.id) return switchTo(r.id);
    if (r.action === 'join' && r.id && r.friend) {
      if (S.playing && S.playing.id === r.id) return api.friendJoin(r.friend).catch((e) => toast(e.message, true));
      return S.playing ? switchTo(r.id, { join: r.friend }) : play(r.id, { join: r.friend });
    }
    if (r.action === 'close') {
      const cur = S.playing && byId(S.playing.id);
      if (await confirmBox('Close ' + (cur ? cur.title : 'the game') + '?', 'It will be closed the normal way, like pressing its X. Save first if the game doesn’t save on its own.', 'Close game', true)) await closeCurrentGame();
      return;
    }
    const t = r.target;
    if (t === 'home') return go('home', S.playing ? 'h-' + S.playing.id : null);
    if (t === 'tv' || t === 'youtube') return openApp(t);
    if (t === 'dc-add') return discordPins();
    if (t === 'dc-setup') return discordConnect();
    if (t === 'players-setup') return setUpPlayersNow();
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
  // Steam downloads: progress bars on tiles; a new install shows up in the library by itself.
  S.downloads = [];
  const dlSeen = new Set();
  function paintDownloads() {
    const byApp = new Map((S.downloads || []).map((d) => [d.appid, d]));
    for (const t of $$('.tile[data-game]')) {
      const g = byId(t.dataset.game);
      const d = byApp.get(steamAppId(g));
      let bar = $('.dl', t);
      if (!d) { if (bar) bar.remove(); continue; }
      if (!bar) { bar = document.createElement('span'); bar.className = 'dl'; bar.innerHTML = '<b></b><span><i></i></span>'; t.appendChild(bar); }
      $('b', bar).textContent = (d.installing ? 'Installing ' : 'Updating ') + d.pct + '%';
      $('i', bar).style.width = d.pct + '%';
    }
  }
  api.on('downloads', (list) => {
    S.downloads = Array.isArray(list) ? list : [];
    const known = new Set(allGames().map(steamAppId).filter(Boolean));
    const fresh = S.downloads.filter((d) => !known.has(d.appid) && !dlSeen.has(d.appid));
    for (const d of fresh) dlSeen.add(d.appid);
    if (fresh.length && !OVERLAY) { rescan('steam', true); notInstAt = 0; } // a new install leaves Not installed
    paintDownloads();
  });
  (async () => { if (TVAPP) return; try { S.downloads = await api.downloads(); paintDownloads(); } catch (_) { /* not available */ } })();
  api.on('news', (n) => { if (n && Array.isArray(n.items)) { S.news = n; S.newsErr = null; paintNews(); } });
  api.on('deals', (v) => { if (v && Array.isArray(v.free)) { S.deals = v; dealsAt = Date.now(); paintDeals(); } });
  api.on('pad:a', (slot) => { if (S.onPadA && Number.isInteger(slot)) S.onPadA(slot); });
  // Phone remote presses (Settings › Controllers › Phone remote).
  const PHONE_DIRS = { up: 'up', down: 'down', left: 'left', right: 'right' };
  api.on('phone', (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.launch) { if (!OVERLAY && byId(m.launch)) play(m.launch); return; }
    if (typeof m.text === 'string') {
      const top = topLayer();
      const inp = top && top.className === 'osk-layer' ? $('.osk-input', top.el) : null;
      if (!inp) { toast('Pick a text box on the TV first (like Search), then send your text', true); return; }
      if (m.text) { inp.value = (inp.value + m.text).slice(0, 200); inp.dispatchEvent(new Event('input')); try { const n = inp.value.length; inp.setSelectionRange(n, n); } catch (_) { /* ignore */ } }
      if (m.enter) button('MENU');
      return;
    }
    if (!m.b) return;
    if (S.input !== 'pad') setInput('pad');
    if (PHONE_DIRS[m.b]) move(PHONE_DIRS[m.b]); else button(m.b);
  });
  api.on('vpads', (st) => { S.vpadsOn = Array.isArray(st) && st.length > 0; if (S.onVpads) S.onVpads(st); });
  api.on('pads', (list) => {
    S.pads = Array.isArray(list) ? list : null;
    // A controller left its slot: what was found for it no longer holds.
    for (const k of Object.keys(slotDevice)) if (!S.pads || !S.pads.some((p) => String(p.slot) === k)) delete slotDevice[k];
    const p = $('#padcount'); if (p) p.innerHTML = padsHTML();
    if (S.onPads) S.onPads();
  });
  api.on('notice', (n) => { if (n && n.title && !OVERLAY) toast(n.join ? n.title + ' · open Friends to join' : n.title); });
  api.on('tv:ended', (p) => { suppressUntilRelease = true; TV().ended(p); if (S.view === 'settings' && S.setTab === 'tv' && !layers.length) loadTvSettings(); });
  (async () => { try { S.pads = await api.pads(); tickClock(); } catch (_) { /* not available */ } })();
  api.on('game:started', (p) => { if (S.playing && p && S.playing.id === p.gameId) S.playing.started = true; });
  api.on('update:found', (r) => { if (!S.playing && !(TVAPP && S.tvPlaying)) checkForUpdate(true, r); });
  api.on('overlay', () => { suppressUntilRelease = true; setInput('pad'); openGuide({ fromGame: true }); });
  api.on('guide', () => { suppressUntilRelease = true; setInput('pad'); noteActivity(); if (idle) { closeIdle(); return; } toggleGuide(!!S.playing); });
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
    window.__stage = 'info';
    try { S.info = await api.info(); } catch (_) { /* defaults */ }
    addEmuSources();
    refreshRa();
    window.__stage = 'load';
    S.lib = await api.load();
    window.__stage = 'ready';
    S.theme = window.applyTheme(S.lib.settings, false);
    requestAnimationFrame(pollPads);
    api.on('overlay:open', async (p) => {
      try { S.lib = await api.load(); S.theme = window.applyTheme(S.lib.settings, false); } catch (_) { /* keep last */ }
      for (const l of layers.slice()) { l.el.remove(); layers.splice(layers.indexOf(l), 1); }
      S.playing = p && p.gameId ? { id: p.gameId, tracked: true, started: true, at: 0 } : null;
      S.tvNow = p && p.tv ? p.tv : p && p.yt ? { yt: true, title: 'YouTube', subtitle: '', pos: 0, dur: 0 } : null; // the guide over something you're watching
      suppressUntilRelease = true;
      setInput('pad');
      lastMouse = null;
      openGuide({ fromGame: true });
    });
    api.on('overlay:closed', () => { for (const l of layers.slice()) { l.el.remove(); layers.splice(layers.indexOf(l), 1); } updatePrompts(); });
  }

  // Library filters and badges for the catalog emulators (PS2, PSP, Wii U…).
  function addEmuSources() {
    const NAMES = { retroarch: 'Retro (RetroArch)', yuzufork: 'Switch (Eden / Citron)', ares: 'Retro (ares)', mame: 'Arcade (MAME)', redream: 'Dreamcast (Redream)', scummvm: 'Adventure (ScummVM)' };
    for (const [id, e] of Object.entries(S.info.emulators || {})) {
      if (SOURCES[id] || !e.catalog) continue;
      SOURCES[id] = { name: NAMES[id] || e.system, badge: String(NAMES[id] ? e.name : e.system).toUpperCase().slice(0, 12), color: e.color || '#444A52', letter: e.name.charAt(0).toUpperCase() };
    }
  }
  function refreshRa() { return Promise.resolve().then(() => api.raStatus()).then((r) => { S.raOn = !!(r && r.connected); S.raUser = (r && r.user) || null; }).catch(() => {}); }
  // Couch TV's Settings follow its look: dark or light.
  function tvAppTheme() { const s = S.lib.settings; s.theme = s.tvMode === 'light' ? 'macoslight' : 'macos'; s.accent = null; s.useArtBackground = false; s.customBg = null; }
  // Couch TV: Movies & TV is the whole app. Its Settings page sits underneath (the gear opens it,
  // B or "Back to Couch TV" returns).
  async function initTvApp() {
    window.__stage = 'info';
    try { S.info = Object.assign(S.info, await api.info()); } catch (e) { window.__stage = 'info failed: ' + e.message; }
    window.__stage = 'load';
    S.lib = await api.load();
    window.__stage = 'render';
    tvAppTheme();
    S.theme = window.applyTheme(S.lib.settings, false);
    S.view = 'settings'; S.setTab = 'tv';
    renderView(false);
    TV().open();
    requestAnimationFrame(pollPads);
    window.__stage = 'running';
    try { api.started().catch(() => {}); } catch (_) { /* fine */ }
    if (S.info.updateFailed) toast('The last update couldn’t start, so the previous version is running. Details: ' + S.info.updateFailed, true);
    api.on('tvapp:fullscreen', (on) => { S.tvFull = !!on; document.documentElement.classList.toggle('tvapp-full', !!on); if (!layers.length && S.setTab === 'tv') refreshContent(); });
  }
  async function init() {
    if (OVERLAY) return initOverlay();
    if (TVAPP) return initTvApp();
    window.__stage = 'info';
    try { S.info = await api.info(); } catch (e) { window.__stage = 'info failed: ' + e.message; }
    addEmuSources();
    window.__stage = 'load';
    S.lib = await api.load();
    window.__stage = 'render';
    refreshRa();
    if (typeof S.info.autostart === 'boolean') S.lib.settings.autostart = S.info.autostart;
    S.theme = window.applyTheme(S.lib.settings, false);
    renderView(false);
    requestAnimationFrame(pollPads);
    window.__stage = 'running';
    try { if (api.started) api.started().catch(() => {}); } catch (_) { /* older app core */ } // the update fail-safe: this screen is up
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
  // Movies & TV (tv.js), made on first use.
  let tvUi = null;
  function TV() {
    if (tvUi) return tvUi;
    tvUi = window.CouchTV({
      api, S, $, $$, esc, icon, toast, openLayer, closeLayer, setFocus, currentFocus, cssEsc, openMenu, confirmBox, osk, browse, reduce, save, layers, topLayer,
      standalone: TVAPP, // Couch TV: this is the whole app (nothing to close back to)
      glyphText: (b) => (GLYPHS[S.input === 'pad' ? S.glyphs : 'key'] || {})[b] || b,
      openSettings: () => { S.setTab = 'tv'; go('settings', 't-tv'); loadTvSettings(); },
      refreshSettings: () => { if (S.view === 'settings' && S.setTab === 'tv') loadTvSettings(); }
    });
    return tvUi;
  }
  async function loadTvSettings() {
    try { S.tvStatus = await api.tvStatus(); } catch (_) { S.tvStatus = S.tvStatus || { signedIn: false }; }
    if (S.view === 'settings' && S.setTab === 'tv' && !layers.length) refreshContent();
  }
  // Mistakes on this screen go to errors.log (in the launcher's settings folder).
  const reportError = (what) => { try { if (api.logError) api.logError((OVERLAY ? 'guide: ' : TVAPP ? 'couch tv: ' : 'launcher: ') + what).catch(() => {}); } catch (_) { /* older app core */ } };
  window.addEventListener('error', (e) => { if (e && e.message) reportError(e.message + ' at ' + String(e.filename || '').split('/').pop() + ':' + e.lineno + (e.error && e.error.stack ? '\n' + e.error.stack : '')); });
  window.addEventListener('unhandledrejection', (e) => { const r = e && e.reason; reportError('unhandled: ' + String((r && r.stack) || r)); });
  window.__couch = { S, move, button, setFocus, currentFocus, layers, TV, openIdle, closeIdle, go, osk, slotInfo }; // used by tests
  init().catch((e) => { document.body.innerHTML = '<pre style="color:#fff;padding:40px;font-size:18px">' + (TVAPP ? 'Couch TV' : 'Couch Launcher') + ' couldn’t start:\n' + esc(e && e.stack || e) + '</pre>'; });
})();
