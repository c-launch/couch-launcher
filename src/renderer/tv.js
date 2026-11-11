'use strict';
/* Movies & TV: an Apple TV–style front end for Stremio inside the launcher.
   Pages: Home (featured + Continue Watching + addon rows), Movies, Series, Library, Addons,
   Search, a show/movie page with seasons and episodes, and the stream picker. */
window.CouchTV = function (k) {
  const { api, S, $, $$, esc, icon, toast, openLayer, closeLayer, setFocus, currentFocus, cssEsc, openMenu, confirmBox, osk, browse, reduce, save } = k;
  const SECTIONS = [['home', 'Home'], ['cable', 'Cable TV'], ['movie', 'Movies'], ['series', 'Series'], ['library', 'Library'], ['addons', 'Addons']];
  const T = { layer: null, page: 'home', stack: [], refs: [], status: null, catalogs: null, board: null, lib: null, heroI: 0, heroTimer: null, gen: 0, grid: null, show: null, busy: false };
  const mode = () => (S.lib.settings.tvMode === 'light' ? 'light' : 'dark');
  const behavior = () => (reduce() ? 'auto' : 'smooth');
  const ref = (o) => { T.refs.push(o); return T.refs.length - 1; };
  const got = (el) => (el && el.dataset.ref != null ? T.refs[Number(el.dataset.ref)] : null);
  const metahub = (kind, id) => (/^tt\d+$/.test(String(id || '').split(':')[0]) ? 'https://images.metahub.space/' + kind + '/medium/' + String(id).split(':')[0] + '/img' : null);
  const epOf = (videoId) => { const m = /:(\d+):(\d+)$/.exec(videoId || ''); return m ? { season: Number(m[1]), episode: Number(m[2]) } : null; };
  const minsLeft = (it) => { const s = Math.max(0, (it.duration || 0) - (it.offset || 0)); if (!it.duration) return ''; const m = Math.round(s / 60); return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min left' : Math.max(1, m) + ' min left'; };
  const typeName = (t) => (t === 'series' ? 'Series' : t === 'movie' ? 'Movies' : t === 'channel' ? 'Channels' : t === 'tv' ? 'Live TV' : t ? t.charAt(0).toUpperCase() + t.slice(1) : '');

  // ---------------------------------------------------------------- shell
  function open(page) {
    if (T.layer && k.layers.includes(T.layer)) { if (page) go(page); return; }
    T.page = page || 'home'; T.stack = [];
    T.layer = openLayer({
      className: 'tv-layer tv-' + mode(),
      html: '<div class="tv"><div class="tv-backdrop" aria-hidden="true"></div><header class="tv-top">' +
        (k.standalone ? '<button class="tv-backbtn off" type="button" tabindex="-1" aria-label="Back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.5 5l-7 7 7 7"/></svg></button>' : '') +
        '<nav class="tv-nav" aria-label="Sections"></nav>' +
        '<button class="tv-me" data-nav data-key="tvn-settings" data-lock="tvnav" data-zone="tvnav" data-act="settings" aria-label="' + (k.standalone ? 'Settings' : 'Movies & TV settings') + '">' + icon('gear') + '</button></header>' +
        '<main class="tv-scroll"></main><footer class="tv-hints"></footer>' + introHTML() + '</div>',
      onActivate: activate,
      onButton: (b) => (T.intro ? (endIntro(), true) : buttonPress(b)),
      onMove: () => { if (T.intro) { endIntro(); return true; } return false; },
      onBack: back,
      onFocus: focused,
      onClose: () => {
        clearInterval(T.heroTimer); clearInterval(T.cableTimer); endZooms(); if (T.navWatch) T.navWatch.disconnect(); T.navInd = null; T.layer = null;
        if (T.rowWatch) { T.rowWatch.disconnect(); T.rowWatch = null; }
        if (T.rowResize) { window.removeEventListener('resize', T.rowResize); T.rowResize = null; }
      },
      prompts: prompts
    });
    // Pictures that don't load: try the poster instead (wide art), else show the title.
    T.layer.el.addEventListener('error', (e) => {
      const img = e.target;
      if (!img || img.tagName !== 'IMG') return;
      if (img.dataset.fb) { const fb = img.dataset.fb; delete img.dataset.fb; img.src = fb; return; }
      img.classList.add('broken');
    }, true);
    if (k.standalone) rowArrows(T.layer.el);
    refreshStatus().then(() => { if (isOpen()) render(); });
  }
  // Couch TV: getting along a row without a controller.
  //  - An arrow at each end of every row (shown only on the side that has more) moves it most of
  //    a screen at a time.
  //  - Two fingers sideways on a trackpad (or Shift + the mouse wheel) slides the row under the
  //    pointer.
  // Up and down is the page's own scrolling, as in any window.
  function syncArrows(row) {
    const wrap = row && row.parentElement;
    if (!wrap || !wrap.classList.contains('tv-rowwrap')) return;
    const max = row.scrollWidth - row.clientWidth;
    const l = $('.tv-arrow.l', wrap), r = $('.tv-arrow.r', wrap);
    if (l) l.classList.toggle('off', !(row.scrollLeft > 2));
    if (r) r.classList.toggle('off', !(max > 2 && row.scrollLeft < max - 2));
  }
  function rowArrows(root) {
    const all = () => { for (const row of $$('.tv-rowwrap > .tv-row', root)) syncArrows(row); };
    let t = null;
    const soon = () => { if (!t) t = setTimeout(() => { t = null; if (isOpen()) all(); }, 60); };
    // (Also for the mouse: a Back button at the top left, the mouse's own back button, and
    // the hints at the bottom right can be clicked.)
    root.addEventListener('click', (e) => {
      const bb = e.target.closest && e.target.closest('.tv-backbtn');
      if (bb && root.contains(bb)) { e.preventDefault(); e.stopPropagation(); if (!T.intro) back(); return; }
      const h = e.target.closest && e.target.closest('.tv-hints [data-b]');
      if (h && root.contains(h)) { e.preventDefault(); e.stopPropagation(); if (!T.intro) { if (h.dataset.b === 'B') back(); else buttonPress(h.dataset.b); } return; }
    });
    root.addEventListener('mouseup', (e) => { if (e.button === 3 && !T.intro && k.topLayer() === T.layer) { e.preventDefault(); back(); } });
    root.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('.tv-arrow');
      if (!a || !root.contains(a)) return;
      e.preventDefault(); e.stopPropagation();
      const row = $('.tv-row', a.parentElement);
      if (!row) return;
      const pad = parseFloat(getComputedStyle(row).paddingLeft) || 0;
      row.scrollBy({ left: Number(a.dataset.dir) * Math.max(120, (row.clientWidth - 2 * pad) * 0.85), behavior: behavior() });
    });
    root.addEventListener('scroll', (e) => { const el = e.target; if (el && el.classList && el.classList.contains('tv-row')) syncArrows(el); }, true);
    root.addEventListener('wheel', (e) => {
      if (e.ctrlKey) return;
      const row = e.target.closest && e.target.closest('.tv-row, .tv-chips');
      if (!row) return;
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
      if (!dx || row.scrollWidth - row.clientWidth <= 2) return;
      e.preventDefault();
      row.scrollLeft += e.deltaMode === 1 ? dx * 40 : dx;
    }, { passive: false });
    // Rows fill in as addons answer, pictures arrive and the window is resized.
    if (window.MutationObserver) { T.rowWatch = new MutationObserver(soon); T.rowWatch.observe(root, { childList: true, subtree: true }); }
    T.rowResize = soon;
    window.addEventListener('resize', soon);
    soon();
  }
  // Opening animation (first time each session): the mark with "Movies & TV" beside it fades
  // up; the words slide into the mark as it glides to the middle; then it grows a touch and fades
  // into Home (which loads underneath). Any button skips it.
  function introHTML() {
    T.intro = false;
    if (reduce() || S.lib.settings.tvIntro === false || T.introShown) return '';
    T.introShown = true; T.intro = true;
    T.introTimers = [setTimeout(introMove, 1150), setTimeout(() => introPhase('fade'), 1800), setTimeout(() => endIntro(true), 2400)];
    return '<div class="tv-intro" aria-hidden="true"><div class="tv-intro-lockup"><div class="tv-intro-mark"><svg viewBox="0 0 100 100">' +
      '<defs><linearGradient id="tvIntroG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#7C7C82"/></linearGradient></defs>' +
      '<circle cx="50" cy="50" r="47" fill="#000000"/><circle cx="50" cy="50" r="44" fill="none" stroke="#2C2C30" stroke-width="4.5"/>' +
      '<circle class="tv-intro-ring" cx="50" cy="50" r="44" fill="none" stroke="url(#tvIntroG)" stroke-width="4.5" stroke-linecap="round"/>' +
      '<path class="tv-intro-play" d="M41 33.5c0-2.3 2.5-3.7 4.5-2.5l22 14.2c1.8 1.1 1.8 3.7 0 4.8l-22 14.2c-2 1.3-4.5-.2-4.5-2.5z" fill="#F5F5F7"/></svg></div>' +
      '<div class="tv-intro-word">' + (k.standalone ? 'Couch TV' : 'Movies &amp; TV') + '</div></div></div>';
  }
  const introEl = () => T.layer && $('.tv-intro', T.layer.el);
  // Measured when it moves (after the font has loaded), so the mark lands exactly in the middle.
  function introMove() {
    const el = introEl();
    if (!el) return;
    const mark = $('.tv-intro-mark', el), word = $('.tv-intro-word', el);
    const mr = mark.getBoundingClientRect(), wr = word.getBoundingClientRect();
    const mid = window.innerWidth / 2;
    const shift = mid - (mr.left + mr.width / 2);
    const wshift = mid - (wr.left + wr.width / 2);
    mark.style.transform = 'translateX(' + shift + 'px)';
    word.style.transform = 'translateX(' + wshift + 'px) scale(.18)';
    el.classList.add('move');
  }
  function introPhase(c) { const el = introEl(); if (el) el.classList.add(c); }
  function endIntro(natural) {
    T.intro = false;
    (T.introTimers || []).forEach(clearTimeout);
    const el = introEl();
    if (!el) return;
    if (!natural) el.classList.add('skip');
    setTimeout(() => el.remove(), natural ? 0 : 260);
  }
  const isOpen = () => !!(T.layer && k.layers.includes(T.layer));
  const scroller = () => $('.tv-scroll', T.layer.el);
  function nav() {
    const top = T.page === 'show' || T.page === 'cat' || T.page === 'cableedit' || T.page === 'cableeras' ? (T.stack[0] && T.stack[0].page) || 'home' : T.page;
    $('.tv-nav', T.layer.el).innerHTML = SECTIONS.map(([id, label]) => '<button class="tv-tab' + (top === id ? ' on' : '') + '" data-nav data-key="tvn-' + id + '" data-lock="tvnav" data-zone="tvnav" data-act="section" data-to="' + id + '">' + label + '</button>').join('') +
      '<button class="tv-tab ic' + (top === 'search' ? ' on' : '') + '" data-nav data-key="tvn-search" data-lock="tvnav" data-zone="tvnav" data-act="section" data-to="search" aria-label="Search">' + icon('search') + '</button>';
    // The highlight behind the current section slides over to the new one.
    const bar = $('.tv-nav', T.layer.el);
    const ind = document.createElement('span');
    ind.className = 'tv-nav-ind';
    bar.prepend(ind);
    placeInd(true);
    // Tabs change size when the font arrives or the window does: keep it exactly on the tab.
    if (!T.navWatch && window.ResizeObserver) { T.navWatch = new ResizeObserver(() => placeInd(false)); }
    if (T.navWatch) { T.navWatch.disconnect(); T.navWatch.observe(bar); for (const t of $$('.tv-tab', bar)) T.navWatch.observe(t); }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => placeInd(false));
  }
  // Puts the highlight on the current section: gliding from where it was (animate), or straight there.
  function placeInd(animate) {
    if (!T.layer) return;
    const bar = $('.tv-nav', T.layer.el), ind = bar && $('.tv-nav-ind', bar), on = bar && $('.tv-tab.on', bar);
    if (!ind) return;
    if (!on || !on.offsetWidth) { ind.style.opacity = '0'; return; }
    ind.style.opacity = '';
    const to = { left: on.offsetLeft, width: on.offsetWidth };
    const from = animate && T.navInd && T.navInd.width ? T.navInd : null;
    ind.classList.remove('anim');
    Object.assign(ind.style, from ? { left: from.left + 'px', width: from.width + 'px' } : { left: to.left + 'px', width: to.width + 'px' });
    if (from && (from.left !== to.left || from.width !== to.width) && !reduce()) {
      void ind.offsetWidth;
      ind.classList.add('anim');
      Object.assign(ind.style, { left: to.left + 'px', width: to.width + 'px' });
    } else Object.assign(ind.style, { left: to.left + 'px', width: to.width + 'px' });
    T.navInd = to;
  }
  // Pages slide in from the side you're heading to (Home → Movies slides left, and so on).
  const ORDER = SECTIONS.map((x) => x[0]).concat(['search']);
  function slideIn(dir) {
    const sc = scroller();
    if (!sc || !dir || reduce()) return;
    sc.animate([{ opacity: 0, transform: 'translateX(' + (dir * 4) + 'rem)' }, { opacity: 1, transform: 'none' }], { duration: 340, easing: 'cubic-bezier(.32,.72,0,1)' });
  }
  function go(page) {
    const from = T.page === 'show' || T.page === 'cat' ? (T.stack[0] && T.stack[0].page) || 'home' : T.page;
    const a = ORDER.indexOf(from), b = ORDER.indexOf(page);
    T.page = page; T.stack = [];
    render();
    if (a >= 0 && b >= 0 && a !== b) slideIn(b > a ? 1 : -1);
  }
  function back() {
    if (T.stack.length) {
      const prev = T.stack.pop();
      const fromShow = T.page === 'show' && T.show && T.show.preview;
      const bg = fromShow ? (T.show.preview.background || (T.show.meta && T.show.meta.background) || metahub('background', T.show.preview.id)) : null;
      T.page = prev.page; T.show = prev.show || T.show; T.grid = prev.grid || T.grid;
      T.pendingZoom = fromShow ? bg || '' : null;
      render(prev.focus, prev.scroll);
      if (fromShow && !T.want) zoomBack(bg);
      return;
    }
    if (T.page !== 'home') return go('home');
    if (k.standalone) return; // Couch TV: Home is as far back as it goes
    closeLayer(T.layer);
  }
  function push(page, extra) {
    T.stack.push({ page: T.page, focus: currentFocus() && currentFocus().dataset.key, scroll: scroller().scrollTop, show: T.show, grid: T.grid });
    T.page = page;
    Object.assign(T, extra || {});
    render();
  }
  // Draws the current page, then puts the focus back where it was.
  function render(focusKey, scrollTop) {
    if (!isOpen()) return;
    const gen = ++T.gen;
    clearInterval(T.heroTimer);
    T.refs = [];
    T.layer.el.classList.toggle('tv-light', mode() === 'light');
    T.layer.el.classList.toggle('tv-dark', mode() !== 'light');
    nav();
    { const bb = $('.tv-backbtn', T.layer.el); if (bb) bb.classList.toggle('off', !(T.stack.length || T.page !== 'home')); }
    backdrop(null);
    const sc = scroller();
    sc.className = 'tv-scroll page-' + T.page;
    $('.tv', T.layer.el).classList.toggle('on-show', T.page === 'show');
    const fn = { home: homePage, cable: cablePage, cableedit: cableEditPage, cableeras: cableErasPage, movie: () => browsePage('movie'), series: () => browsePage('series'), library: libraryPage, addons: addonsPage, search: searchPage, show: showPage, cat: catPage }[T.page] || homePage;
    sc.innerHTML = '';
    fn(sc, gen);
    sc.scrollTop = scrollTop || 0;
    // Coming back to a page whose rows are still loading: go back to the same poster (and
    // scroll position) once it's there.
    T.want = focusKey && !$('[data-key="' + cssEsc(focusKey) + '"]', T.layer.el) ? { key: focusKey, scroll: scrollTop || 0, zoom: T.pendingZoom, gen } : null;
    T.pendingZoom = null;
    place(focusKey);
  }
  function settle() {
    const w = T.want;
    if (!w || !isOpen() || w.gen !== T.gen) return;
    const el = $('[data-key="' + cssEsc(w.key) + '"]', scroller());
    if (!el) return;
    T.want = null;
    if (w.scroll) scroller().scrollTop = w.scroll;
    setFocus(el, { instant: true });
    if (w.zoom != null) zoomBack(w.zoom);
  }
  function place(focusKey) {
    const el = (focusKey && $('[data-key="' + cssEsc(focusKey) + '"]', T.layer.el)) || $('.tv-scroll [data-nav]', T.layer.el) || $('[data-nav]', T.layer.el);
    if (el) setFocus(el, { instant: true });
  }
  const stale = (gen) => gen !== T.gen || !isOpen();
  function backdrop(url) {
    const b = $('.tv-backdrop', T.layer.el);
    if (!b) return;
    if (!url) { b.style.backgroundImage = ''; b.classList.remove('on'); return; }
    b.style.backgroundImage = 'url("' + String(url).replace(/"/g, '%22') + '")';
    b.classList.add('on');
  }

  // ---------------------------------------------------------------- data
  async function refreshStatus() {
    try { T.status = await api.tvStatus(); } catch (_) { T.status = T.status || { signedIn: false }; }
    return T.status;
  }
  async function catalogs() {
    if (T.catalogs) return T.catalogs;
    T.catalogs = await api.tvCatalogs();
    return T.catalogs;
  }
  async function library(force) {
    try { T.lib = await api.tvLibrary(!!force); } catch (_) { T.lib = T.lib || { continueWatching: [], items: [] }; }
    return T.lib;
  }
  const cwFor = (id) => T.lib && T.lib.continueWatching.find((x) => x.id === id);

  // ---------------------------------------------------------------- pieces
  function posterHTML(p, key, zone, lock, extra) {
    const img = p.poster || metahub('poster', p.id);
    return '<button class="tv-poster" data-nav data-key="' + esc(key) + '" data-zone="' + zone + '"' + (lock ? ' data-lock="' + lock + '"' : '') + ' data-act="item" data-ref="' + ref(p) + '"' + (extra || '') + ' aria-label="' + esc(p.name) + '">' +
      (img ? '<img src="' + esc(img) + '" alt="" loading="lazy" decoding="async">' : '') + '<span class="tv-pname">' + esc(p.name) + '</span></button>';
  }
  function cwHTML(it, i) {
    const img = metahub('background', it.id) || it.poster;
    const ep = epOf(it.videoId);
    const pct = it.duration ? Math.min(100, Math.round(it.offset / it.duration * 100)) : 0;
    return '<button class="tv-wide" data-nav data-key="cw-' + i + '" data-zone="cw" data-lock="cw" data-act="resume" data-ref="' + ref(it) + '" aria-label="' + esc(it.name) + '">' +
      '<span class="tv-wimg">' + (img ? '<img src="' + esc(img) + '" alt="" loading="lazy"' + (it.poster && it.poster !== img ? ' data-fb="' + esc(it.poster) + '"' : '') + '>' : '') + '<span class="tv-wname">' + esc(it.name) + '</span><span class="tv-prog"><i style="width:' + pct + '%"></i></span></span>' +
      '<span class="tv-wsub">' + esc((ep ? 'S' + ep.season + ':E' + ep.episode : 'Movie') + (minsLeft(it) ? ' · ' + minsLeft(it) : '')) + '</span></button>';
  }
  const sectionHTML = (title, inner, cls) => '<section class="tv-sec' + (cls ? ' ' + cls : '') + '" data-block><h2>' + esc(title) + '</h2>' + inner + '</section>';
  // Couch TV (used with a mouse or trackpad): each row has an arrow at either end, see rowArrows.
  const arrowHTML = (d) => '<button class="tv-arrow ' + (d < 0 ? 'l' : 'r') + ' off" type="button" tabindex="-1" data-dir="' + d + '" aria-label="' + (d < 0 ? 'Scroll back' : 'Scroll on') + '">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + (d < 0 ? 'M15.5 5l-7 7 7 7' : 'M8.5 5l7 7-7 7') + '"/></svg></button>';
  const rowHTML = (inner) => (k.standalone ? '<div class="tv-rowwrap">' + arrowHTML(-1) + '<div class="tv-row">' + inner + '</div>' + arrowHTML(1) + '</div>' : '<div class="tv-row">' + inner + '</div>');
  const empty = (text, btn) => '<div class="tv-empty"><p>' + text + '</p>' + (btn || '') + '</div>';

  // ---------------------------------------------------------------- Home
  function homePage(sc, gen) {
    const signedIn = T.status && T.status.signedIn;
    sc.innerHTML = '<section class="tv-hero" data-block="top"><div class="tv-hero-body"><div class="tv-kicker">&nbsp;</div><h1 class="tv-htitle">&nbsp;</h1><div class="tv-hmeta"></div><p class="tv-hdesc"></p>' +
      '<div class="tv-hbtns"><button class="tv-btn primary" data-nav data-key="h-play" data-zone="hero" data-act="hero-play">' + icon('play') + '<span>Play</span></button>' +
      '<button class="tv-btn" data-nav data-key="h-info" data-zone="hero" data-act="hero-info">More Info</button>' +
      '<button class="tv-btn round" data-nav data-key="h-lib" data-zone="hero" data-act="hero-lib" aria-label="Add to Library">' + icon('plus') + '</button></div><div class="tv-dots"></div></div></section>' +
      (signedIn === false && !(S.lib.settings.tvSignInSeen) ? '<section class="tv-sec tv-signin-card" data-block><div><h2>Bring your Stremio stuff</h2><p>Sign in to use your own addons, library and Continue Watching, synced with the Stremio app.</p></div>' +
        '<button class="tv-btn primary" data-nav data-key="h-signin" data-zone="signin" data-act="signin">Sign in</button><button class="tv-btn" data-nav data-key="h-signin-no" data-zone="signin" data-act="signin-later">Not now</button></section>' : '') +
      '<div class="tv-cw"></div><div class="tv-recs"></div><div class="tv-rows"><div class="tv-loading">Loading…</div></div>';
    $('.tv-hero', sc).classList.add('wait');
    library().then(() => { if (!stale(gen)) { drawCw(sc); loadRecs(sc, gen); } });
    loadBoard(sc, gen);
  }
  function drawCw(sc) {
    const box = $('.tv-cw', sc);
    if (!box) return;
    const cw = (T.lib && T.lib.continueWatching) || [];
    const had = currentFocus() && currentFocus().closest('.tv-cw') && currentFocus().dataset.key;
    box.innerHTML = cw.length ? sectionHTML('Continue Watching', rowHTML(cw.map(cwHTML).join(''))) : '';
    if (had) place(had);
    hero();
    settle();
  }
  async function loadBoard(sc, gen) {
    let cats;
    try { cats = (await catalogs()).filter((c) => c.board); } catch (e) { const r = $('.tv-rows', sc); if (r && !stale(gen)) r.innerHTML = empty('Couldn’t reach your addons. ' + esc(e.message)); return; }
    if (stale(gen)) return;
    const box = $('.tv-rows', sc);
    if (!cats.length) { box.innerHTML = empty('No catalogs yet. Add an addon with catalogs in Addons.'); return; }
    const list = cats.slice(0, 10);
    box.innerHTML = list.map((c, i) => '<div class="tv-slot" data-i="' + i + '"></div>').join('');
    T.featured = [];
    await Promise.all(list.map(async (c, i) => {
      let items = [];
      try { items = await api.tvCatalog(c.addon, c.type, c.id, {}); } catch (_) { items = []; }
      if (stale(gen)) return;
      const slot = $('.tv-slot[data-i="' + i + '"]', sc);
      if (!slot) return;
      if (!items.length) { slot.remove(); return; }
      const title = catTitle(c);
      const had = currentFocus() && currentFocus().closest('.tv-slot') === slot && currentFocus().dataset.key;
      // The last card opens the whole category (more pages load as you scroll down).
      const more = moreHTML('r' + i, { c, title, items }, title);
      slot.innerHTML = sectionHTML(title, rowHTML(items.slice(0, 30).map((p, j) => posterHTML(p, 'r' + i + '-' + j, 'r' + i, 'r' + i)).join('') + more));
      if (had) place(had);
      settle();
      if (i === 0) { T.featured = items.filter((p) => p.background || metahub('background', p.id)).slice(0, 6); T.heroI = 0; hero(); }
    }));
    if (!stale(gen) && !T.featured.length) { const h = $('.tv-hero', sc); if (h) h.remove(); place(); }
  }
  // The last card of a row: opens everything in it on its own page.
  function moreHTML(zone, what, title) {
    return '<button class="tv-poster tv-more" data-nav data-key="' + zone + '-more" data-zone="' + zone + '" data-lock="' + zone + '" data-act="more" data-ref="' + ref(what) + '" aria-label="View more ' + esc(title) + '">' +
      '<span class="tv-more-ic">' + icon('grid') + '</span><span class="tv-more-t">View more</span></button>';
  }

  // ---------------------------------------------------------------- Recommended
  // "Recommended for you" and "Because you watched …", from what you've watched and saved lately:
  // the genres you watch most (newer counts more), filled from your addons' catalogs, leaving out
  // what's already in your Library or Continue Watching. Worked out again every 15 minutes.
  async function loadRecs(sc, gen) {
    const box = $('.tv-recs', sc);
    if (!box) return;
    const lib = T.lib || { continueWatching: [], items: [] };
    const seen = new Map();
    for (const it of lib.continueWatching.concat(lib.items).sort((a, b) => (b.lastWatched || 0) - (a.lastWatched || 0))) if (!seen.has(it.id)) seen.set(it.id, it);
    const recent = [...seen.values()].filter((x) => x.type === 'movie' || x.type === 'series').slice(0, 8);
    if (!recent.length) { box.innerHTML = ''; return; }
    const sig = recent.map((x) => x.id).join(',');
    let r = T.recs && T.recs.sig === sig && Date.now() - T.recs.at < 15 * 60e3 ? T.recs : null;
    if (!r) {
      try { r = await workOutRecs(recent, new Set(seen.keys())); } catch (_) { r = null; }
      if (!r) return;
      r.sig = sig; r.at = Date.now(); T.recs = r;
    }
    if (stale(gen)) return;
    const had = currentFocus() && currentFocus().closest('.tv-recs') && currentFocus().dataset.key;
    let h = '';
    if (r.forYou.length) h += sectionHTML('Recommended for you', rowHTML(r.forYou.slice(0, 30).map((p, j) => posterHTML(p, 'rc-' + j, 'rc', 'rc')).join('') + moreHTML('rc', { c: null, title: 'Recommended for you', items: r.forYou }, 'Recommended for you')));
    if (r.because && r.because.items.length) {
      const t = 'Because you watched ' + r.because.name;
      h += sectionHTML(t, rowHTML(r.because.items.slice(0, 30).map((p, j) => posterHTML(p, 'bw-' + j, 'bw', 'bw')).join('') + moreHTML('bw', { c: null, title: t, items: r.because.items }, t)));
    }
    box.innerHTML = h;
    if (had) place(had);
    settle();
  }
  async function workOutRecs(recent, owned) {
    const metas = (await Promise.all(recent.map((it) => api.tvMeta(it.type, it.id).catch(() => null)))).filter((m) => m && (m.genres || []).length);
    if (!metas.length) return { forYou: [], because: null };
    const cats = (await catalogs().catch(() => [])).filter((c) => (c.type === 'movie' || c.type === 'series') && (c.genres || []).length);
    const catFor = (type, g) => cats.find((c) => c.type === type && c.board && c.genres.includes(g)) || cats.find((c) => c.type === type && c.genres.includes(g));
    const fetchGenre = async (type, g) => { const c = catFor(type, g); if (!c) return []; try { return await api.tvCatalog(c.addon, c.type, c.id, { genre: g }); } catch (_) { return []; } };
    // Genres you watch, the newest counting most and each title's main genre a bit more.
    const score = new Map();
    metas.forEach((m, i) => (m.genres || []).forEach((g, j) => { const k = m.type + '|' + g; score.set(k, (score.get(k) || 0) + (metas.length - i) * (j === 0 ? 1.5 : 1)); }));
    const top = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => k.split('|'));
    const lists = await Promise.all(top.map(([type, g]) => fetchGenre(type, g)));
    const forYou = [], ids = new Set();
    for (let i = 0; forYou.length < 60; i++) {
      let any = false;
      for (const l of lists) {
        const p = l[i];
        if (!p) continue;
        any = true;
        if (owned.has(p.id) || ids.has(p.id)) continue;
        ids.add(p.id); forYou.push(p);
      }
      if (!any) break;
    }
    // The latest thing you watched: others in its genres, the ones sharing the most first.
    const last = metas[0];
    const pool = await fetchGenre(last.type, last.genres[0]);
    const shared = (p) => (p.genres || []).filter((g) => last.genres.includes(g)).length;
    const because = pool.filter((p) => p.id !== last.id && !owned.has(p.id)).map((p, i) => ({ p, i, n: shared(p) })).sort((a, b) => (b.n - a.n) || (a.i - b.i)).map((x) => x.p).slice(0, 40);
    const shown = recent.find((x) => x.id === last.id); // the name as it shows in your Continue Watching
    return { forYou, because: because.length >= 6 ? { name: (shown && shown.name) || last.name, items: because } : null };
  }

  // "Popular Movies", "Live TV · USA TV Next · Live TV"… without saying the same name twice.
  function catTitle(c) {
    if (c.name === 'Popular' || c.name === 'Featured' || c.name === 'New') return c.name + ' ' + typeName(c.type);
    const parts = [c.name];
    if (c.addonName && !/cinemeta/i.test(c.addonName) && c.addonName.toLowerCase() !== String(c.name).toLowerCase()) parts.push(c.addonName);
    const t = typeName(c.type);
    if (t && !parts.some((x) => String(x).toLowerCase() === t.toLowerCase())) parts.push(t);
    return parts.join(' · ');
  }
  function hero() {
    const sc = scroller(), h = $('.tv-hero', sc);
    if (!h || !T.featured || !T.featured.length) return;
    const p = T.featured[T.heroI % T.featured.length];
    h.classList.remove('wait');
    backdrop(p.background || metahub('background', p.id));
    const cw = cwFor(p.id);
    const ep = cw && epOf(cw.videoId);
    $('.tv-kicker', h).textContent = (cw ? 'CONTINUE · ' : 'FEATURED · ') + typeName(p.type).toUpperCase();
    $('.tv-htitle', h).innerHTML = p.logo ? '<img class="tv-logo" src="' + esc(p.logo) + '" alt="' + esc(p.name) + '">' : esc(p.name);
    $('.tv-hmeta', h).innerHTML = [p.releaseInfo, (p.genres || []).slice(0, 2).join(', '), p.runtime, p.imdbRating ? 'IMDb ' + p.imdbRating : ''].filter(Boolean).map(esc).join('<span class="dot">·</span>');
    $('.tv-hdesc', h).textContent = p.description || '';
    $('[data-key="h-play"] span', h).textContent = cw ? 'Resume' + (ep ? ' S' + ep.season + ':E' + ep.episode : '') : p.type === 'series' ? 'Watch' : 'Play';
    const inLib = T.lib && T.lib.items.some((x) => x.id === p.id);
    const lb = $('[data-key="h-lib"]', h);
    lb.innerHTML = icon(inLib ? 'check' : 'plus'); lb.setAttribute('aria-label', inLib ? 'In your Library' : 'Add to Library');
    $('.tv-dots', h).innerHTML = T.featured.length > 1 ? T.featured.map((_, i) => '<i' + (i === T.heroI % T.featured.length ? ' class="on"' : '') + '></i>').join('') : '';
    clearInterval(T.heroTimer);
    if (T.featured.length > 1 && !reduce()) T.heroTimer = setInterval(() => {
      const f = currentFocus();
      if (!isOpen() || k.topLayer() !== T.layer || !f || !f.closest('.tv-hero')) return;
      T.heroI = (T.heroI + 1) % T.featured.length; hero();
    }, 9000);
  }
  const heroItem = () => T.featured && T.featured.length ? T.featured[T.heroI % T.featured.length] : null;

  // ---------------------------------------------------------------- Movies / Series
  function browsePage(type) {
    const sc = scroller();
    const gen = T.gen;
    if (!T.grid || T.grid.type !== type || T.grid.view) T.grid = { type, genre: null, cat: null, items: [], done: false, loading: false };
    sc.innerHTML = '<div class="tv-head" data-block="top"><h1>' + typeName(type) + '</h1><div class="tv-chips" role="tablist"></div></div><div class="tv-grid"><div class="tv-loading">Loading…</div></div>';
    catalogs().then((cats) => {
      if (stale(gen)) return;
      const list = cats.filter((c) => c.type === type && (c.board || c.genreRequired));
      if (!list.length) { $('.tv-grid', sc).innerHTML = empty('None of your addons have ' + typeName(type).toLowerCase() + ' catalogs.'); return; }
      const g = T.grid;
      g.cat = g.cat && list.find((c) => c.addon === g.cat.addon && c.id === g.cat.id) || list.find((c) => c.board) || list[0];
      const genres = g.cat.genres || [];
      const chips = list.filter((c) => c.board).map((c) => ({ k: 'cat', label: c.name, c })).concat(genres.slice(0, 24).map((x) => ({ k: 'genre', label: x })));
      $('.tv-chips', sc).innerHTML = chips.map((ch, i) => '<button class="tv-chip' + ((ch.k === 'cat' && ch.c === g.cat && !g.genre) || (ch.k === 'genre' && ch.label === g.genre) ? ' on' : '') + '" data-nav data-key="chip-' + i + '" data-zone="chips" data-lock="chips" data-act="chip" data-ref="' + ref(ch) + '">' + esc(ch.label) + '</button>').join('');
      const on = $('.tv-chips .tv-chip.on', sc);
      if (on) S.zoneMemory.chips = on.dataset.key;
      if (!g.items.length) loadMore(gen); else drawGrid();
      if (!currentFocus() || !currentFocus().closest('.tv-scroll')) place();
    }).catch((e) => { if (!stale(gen)) $('.tv-grid', sc).innerHTML = empty('Couldn’t load: ' + esc(e.message)); });
  }
  async function loadMore(gen) {
    const g = T.grid;
    if (!g || g.loading || g.done) return;
    g.loading = true;
    const extra = {};
    if (g.genre) extra.genre = g.genre;
    if (g.items.length) { if (!g.cat.skip) { g.done = true; g.loading = false; return; } extra.skip = g.items.length; }
    try {
      const items = await api.tvCatalog(g.cat.addon, g.cat.type, g.cat.id, extra);
      if (T.grid !== g) return;
      const seen = new Set(g.items.map((x) => x.id));
      const fresh = items.filter((x) => !seen.has(x.id));
      if (!fresh.length) g.done = true;
      g.items = g.items.concat(fresh);
    } catch (_) { g.done = true; }
    g.loading = false;
    if (!stale(gen) && T.grid === g) drawGrid();
  }
  function drawGrid() {
    const box = $('.tv-grid', scroller());
    if (!box) return;
    const g = T.grid;
    const focusKey = currentFocus() && currentFocus().dataset.key;
    const from = $$('.tv-poster', box).length;
    if (!g.items.length) { box.innerHTML = empty('Nothing here.'); return; }
    if (from === 0) box.innerHTML = '';
    box.insertAdjacentHTML('beforeend', g.items.slice(from).map((p, i) => posterHTML(p, 'g-' + (from + i), 'grid', null, ' data-gi="' + (from + i) + '"')).join(''));
    if (!focusKey) place();
    settle();
  }

  // ---------------------------------------------------------------- One category (View more)
  function catPage(sc, gen) {
    const g = T.grid;
    if (!g || (!g.cat && !g.fixed)) return homePage(sc, gen);
    const genres = (g.cat && !g.cat.genreRequired && g.cat.genres) || [];
    sc.innerHTML = '<div class="tv-head" data-block="top"><h1>' + esc(g.title || g.cat.name) + '</h1><div class="tv-chips" role="tablist"></div></div><div class="tv-grid"><div class="tv-loading">Loading…</div></div>';
    const chips = genres.length ? [{ k: 'cat', label: 'All', c: g.cat }].concat(genres.slice(0, 24).map((x) => ({ k: 'genre', label: x }))) : [];
    const box = $('.tv-chips', sc);
    if (chips.length) {
      box.innerHTML = chips.map((ch, i) => '<button class="tv-chip' + ((ch.k === 'cat' && !g.genre) || (ch.k === 'genre' && ch.label === g.genre) ? ' on' : '') + '" data-nav data-key="chip-' + i + '" data-zone="chips" data-lock="chips" data-act="chip" data-ref="' + ref(ch) + '">' + esc(ch.label) + '</button>').join('');
      const on = $('.tv-chip.on', box);
      if (on) S.zoneMemory.chips = on.dataset.key;
    } else box.remove();
    if (!g.items.length) loadMore(gen); else drawGrid();
  }

  // ---------------------------------------------------------------- Library
  function libraryPage(sc, gen) {
    sc.innerHTML = '<div class="tv-head" data-block="top"><h1>Library</h1><div class="tv-chips"></div></div><div class="tv-cw"></div><div class="tv-grid"><div class="tv-loading">Loading…</div></div>';
    const filter = T.libFilter || 'all';
    S.zoneMemory.chips = 'lf-' + filter;
    $('.tv-chips', sc).innerHTML = [['all', 'All'], ['movie', 'Movies'], ['series', 'Series']].map(([id, l]) => '<button class="tv-chip' + (filter === id ? ' on' : '') + '" data-nav data-key="lf-' + id + '" data-zone="chips" data-lock="chips" data-act="libfilter" data-f="' + id + '">' + l + '</button>').join('');
    library(true).then((lib) => {
      if (stale(gen)) return;
      drawCw(sc);
      const items = lib.items.filter((x) => filter === 'all' || x.type === filter);
      $('.tv-grid', sc).innerHTML = items.length ? items.map((p, i) => posterHTML(p, 'l-' + i, 'grid')).join('')
        : empty(T.status && T.status.signedIn ? 'Nothing in your Library yet. Press X on a poster, or + on a show’s page, to add it.' : 'Press X on a poster to add it to your Library. Sign in to Stremio (Settings › Movies & TV) to bring your own Library here.');
      place(currentFocus() && currentFocus().closest('.tv-scroll') ? currentFocus().dataset.key : null);
      settle();
    });
  }

  // ---------------------------------------------------------------- Cable TV
  // A cable box guide: channels down the side, the next few hours across. Pick a channel (or
  // anything on it) and it tunes in to what's airing right now.
  const HALF = 30 * 60e3, SPAN = 3 * HALF; // the grid shows an hour and a half
  const clock = (t) => { const d = new Date(t); let h = d.getHours(); const m = d.getMinutes(); const pm = h >= 12; h = h % 12 || 12; return h + ':' + String(m).padStart(2, '0') + (pm ? ' PM' : ' AM'); };
  const epShort = (v) => (v && v.season ? 'S' + v.season + ' E' + v.episode + (v.title ? ' · ' + v.title : '') : '');
  if (api.on && !T.cableHooked) {
    T.cableHooked = true;
    api.on('tv:cableProgress', (p) => {
      if (!isOpen() || T.page !== 'cable') return;
      const el = $('.tv-cable-setup .n', T.layer.el);
      if (el && p) el.textContent = p.done + ' of ' + p.total + ' shows';
      const bar = $('.tv-cable-setup i', T.layer.el);
      if (bar && p && p.total) { T.cablePct = Math.max(T.cablePct || 0, Math.round(p.done / p.total * 100)); bar.style.width = T.cablePct + '%'; }
    });
  }
  function cablePage(sc, gen) {
    sc.innerHTML = '<div class="tv-head tv-cable-head" data-block="top"><h1>Cable TV</h1><div class="tv-cable-sub"><span class="tv-cable-clock"></span>' +
      '<button class="tv-chip" data-nav data-key="cb-era" data-zone="cbtop" data-lock="cbtop" data-act="cable-era">Era: <span class="tv-cera">…</span></button>' +
      '<button class="tv-chip" data-nav data-key="cb-ads" data-zone="cbtop" data-lock="cbtop" data-act="cable-ads">Commercials: ' + (S.lib.settings.cableAds === false ? 'Off' : 'On') + '</button>' +
      '<button class="tv-chip" data-nav data-key="cb-edit" data-zone="cbtop" data-lock="cbtop" data-act="cable-edit">' + icon('gear') + ' Edit channels</button></div></div><div class="tv-cable"><div class="tv-loading">Loading the guide…</div></div>';
    drawGuide(sc, gen);
    clearInterval(T.cableTimer);
    T.cableTimer = setInterval(() => { if (stale(gen) || T.page !== 'cable') { clearInterval(T.cableTimer); return; } drawGuide(sc, gen, true); }, 30000);
  }
  async function drawGuide(sc, gen, quiet) {
    const t0 = Math.floor(Date.now() / HALF) * HALF;
    let g;
    try { g = await api.tvCableGuide(t0, t0 + SPAN); } catch (e) { if (!stale(gen)) $('.tv-cable', sc).innerHTML = empty('Couldn’t load the guide. ' + esc(e.message)); return; }
    if (stale(gen)) return;
    const clockEl = $('.tv-cable-clock', sc);
    if (clockEl) clockEl.textContent = clock(Date.now());
    const eraEl = $('.tv-cera', sc);
    if (eraEl) eraEl.textContent = g.era || 'pick one';
    const editEl = $('[data-key="cb-edit"]', sc);
    if (editEl) editEl.hidden = !g.era;
    const box = $('.tv-cable', sc);
    // The first time: which era to start with (only its shows are looked up).
    if (!g.era) { if (!quiet) eraPicker(sc, gen, box); return; }
    if (!g.ready) {
      if (quiet) return;
      box.innerHTML = '<div class="tv-cable-setup"><h2>Setting up the ' + esc(g.era) + '</h2><p>Finding the shows and their episodes (only the first time for each era, about a minute).</p><div class="tv-cable-prog"><i></i></div><div class="n">Starting…</div></div>';
      if (!T.cableSetup) { T.cablePct = 0; T.cableSetup = api.tvCableSetup().catch((e) => { toast(e.message, true); }).finally(() => { T.cableSetup = null; }); }
      const res = await T.cableSetup;
      if (stale(gen) || T.page !== 'cable') return;
      // (Never loop: if it still isn't ready, say so instead of starting over.)
      if (res && res.ready) drawGuide(sc, gen);
      else box.innerHTML = empty('The shows couldn’t be looked up. Check your internet connection, then open Cable TV again.');
      return;
    }
    const had = currentFocus() && currentFocus().closest('.tv-cable') ? currentFocus().dataset.key : null;
    const pct = (t) => Math.max(0, Math.min(100, (t - t0) / SPAN * 100));
    const now = g.now;
    const times = [0, 1, 2].map((i) => '<span style="left:' + (i / 3 * 100) + '%">' + clock(t0 + i * HALF) + '</span>').join('');
    const rows = g.channels.slice().sort((a, b) => a.number - b.number).map((c) => {
      const progs = c.programs.map((p, i) => {
        const l = pct(p.start), r = pct(p.end), on = p.start <= now && p.end > now;
        if (r - l < 0.5) return '';
        return '<button class="tv-prog-cell' + (on ? ' now' : '') + '" style="left:' + l + '%;width:' + (r - l) + '%" data-nav data-key="cp-' + c.id + '-' + p.start + '" data-zone="cr-' + c.id + '" data-lock="cr-' + c.id + '" data-act="cable-tune" data-ch="' + esc(c.id) + '" data-ref="' + ref(Object.assign({ ch: c }, p)) + '">' +
          '<b>' + esc(p.show) + '</b><span>' + esc(on ? clock(p.start) + ' – ' + clock(p.end) : clock(p.start)) + '</span></button>';
      }).join('');
      return '<div class="tv-crow" style="--ch:' + esc(c.color) + '"><button class="tv-cch" data-nav data-key="cc-' + c.id + '" data-zone="cr-' + c.id + '" data-lock="cr-' + c.id + '" data-act="cable-tune" data-ch="' + esc(c.id) + '"><b>' + c.number + '</b><span>' + esc(c.name) + '</span></button>' +
        '<div class="tv-cprogs">' + (progs || '<div class="tv-cnone">' + (c.found ? 'Nothing found' : 'Shows not found yet') + '</div>') + '</div></div>';
    }).join('');
    box.innerHTML = '<div class="tv-cgrid"><div class="tv-ctimes"><div></div><div class="tv-ctimes-in">' + times + '<i class="tv-cnow" style="left:' + pct(now) + '%"></i></div></div>' + rows + '</div>' +
      '<div class="tv-cinfo"></div>';
    const inHead = T.cableKeepHead && currentFocus() && currentFocus().closest('.tv-cable-head');
    T.cableKeepHead = false;
    if (had && $('[data-key="' + cssEsc(had) + '"]', box)) place(had);
    else if (inHead) { /* the focus stays up top (Commercials / Edit channels) */ }
    else if (!quiet) {
      const last = S.lib.settings.cableLast;
      const first = (last && $('.tv-prog-cell.now[data-ch="' + cssEsc(last) + '"]', box)) || $('.tv-prog-cell.now', box) || $('.tv-cch', box);
      if (first) setFocus(first, { instant: true });
    } else place(had);
    cableInfo(currentFocus());
  }
  // Which eras: big cards for the 2000s, 2010s and 2020s. Pick one, or several to merge them
  // (their shows share the channels). Eras not watched before are set up when picked (their
  // shows looked up, about a minute); the others aren't touched.
  async function eraPicker(sc, gen, box) {
    let eras;
    try { eras = await api.tvCableEras(); } catch (e) { box.innerHTML = empty(esc(e.message)); return; }
    if (stale(gen)) return;
    T.eras = eras;
    const first = !eras.some((e) => e.setup);
    if (!T.eraSel) { const cur = eras.filter((e) => e.current).map((e) => e.id); T.eraSel = new Set(cur.length ? cur : ['2010s']); }
    box.innerHTML = '<div class="tv-eras-intro"><h2>' + (first ? 'Pick an era to start with' : 'Pick your eras') + '</h2><p>' +
      'Pick one, or more to mix them: their shows share the channels. ' + (first ? 'Only the eras you pick are looked up now (about a minute each).' : 'Eras you haven’t watched yet take about a minute to set up.') + '</p></div>' +
      '<div class="tv-eras"></div><div class="tv-eras-go"></div>';
    drawEraCards(box);
    const cur = eras.find((e) => T.eraSel.has(e.id)) || eras[1];
    setFocus($('[data-key="era-' + cur.id + '"]', box), { instant: true });
  }
  function drawEraCards(box, focusKey) {
    const eras = T.eras || [];
    $('.tv-eras', box).innerHTML = eras.map((e) => {
      const on = T.eraSel.has(e.id);
      return '<button class="tv-era' + (on ? ' on' : '') + '" data-nav data-key="era-' + e.id + '" data-zone="eras" data-lock="eras" data-act="cable-pick-era" data-era="' + e.id + '" aria-pressed="' + on + '">' +
        '<span class="tv-era-tick">' + (on ? icon('check') : '') + '</span><b>' + esc(e.name) + '</b><span class="tv-era-st">' + (e.setup ? 'Ready' : 'About a minute to set up') + '</span>' +
        '<span class="tv-era-ch">' + esc(e.channels.join(' · ')) + '</span><span class="tv-era-sh">' + esc(e.sample.join(', ')) + '…</span><span class="tv-era-n">' + e.shows + ' shows</span></button>';
    }).join('');
    const sel = eras.filter((e) => T.eraSel.has(e.id)).map((e) => e.name);
    $('.tv-eras-go', box).innerHTML = sel.length
      ? '<button class="tv-btn primary" data-nav data-key="era-go" data-zone="erago" data-act="cable-eras-go">' + icon('play') + '<span>Watch ' + esc(sel.length > 1 ? sel.join(' + ') + ' together' : 'the ' + sel[0]) + '</span></button>'
      : '<p class="tv-eras-none">Pick at least one era</p>';
    if (focusKey) place(focusKey);
  }
  function toggleEra(id) {
    if (T.eraSel.has(id)) T.eraSel.delete(id); else T.eraSel.add(id);
    const box = T.layer && $('.tv-cable', T.layer.el);
    if (box) drawEraCards(box, 'era-' + id);
  }
  async function watchEras() {
    const ids = [...(T.eraSel || [])];
    if (!ids.length) return;
    try { await api.tvCableSetEras(ids); } catch (e) { toast(e.message, true); return; }
    T.cableKeepHead = false;
    T.eraSel = null;
    if (T.page !== 'cable') { T.page = 'cable'; T.stack = []; }
    render();
  }
  // The era page from the guide's Era button.
  function cableErasPage(sc, gen) {
    T.eraSel = null;
    sc.innerHTML = '<div class="tv-head" data-block="top"><h1>Eras</h1></div><div class="tv-cable"><div class="tv-loading">Loading…</div></div>';
    eraPicker(sc, gen, $('.tv-cable', sc));
  }
  // The box under the guide: what the focused program is.
  function cableInfo(el) {
    const box = T.layer && $('.tv-cinfo', T.layer.el);
    if (!box) return;
    const p = el && el.dataset.act === 'cable-tune' ? got(el) : null;
    if (!p || !p.show) { box.innerHTML = el && el.classList.contains('tv-cch') ? '<p class="tv-cinfo-hint">Press A to watch channel ' + esc(el.textContent.replace(/\D+.*$/, '')) + '</p>' : ''; return; }
    const on = p.start <= Date.now() && p.end > Date.now();
    box.innerHTML = (p.poster ? '<img src="' + esc(p.poster) + '" alt="">' : '') + '<div><div class="tv-cinfo-k">' + esc(p.ch.number + ' · ' + p.ch.name + ' · ' + (on ? 'On now, until ' + clock(p.end) : clock(p.start) + ' – ' + clock(p.end))) + '</div>' +
      '<h3>' + esc(p.show) + '</h3><p>' + esc(epShort(p.video)) + '</p><p class="tv-cinfo-hint">' + (on ? 'Press A to watch' : 'Press A to watch what’s on ' + esc(p.ch.name) + ' now') + '</p></div>';
  }
  async function tuneIn(chId) {
    if (T.busy) return;
    T.busy = true;
    S.lib.settings.cableLast = chId; save();
    const t0 = Date.now();
    try {
      await api.tvCableTune(chId);
      if (!(T.endedAt >= t0)) { S.tvPlaying = true; S.tvPlayingAt = 0; }
    } catch (e) {
      if (/NO_MPV/.test(e.message)) { T.busy = false; if (await mpvSetup()) return tuneIn(chId); return; }
      toast(e.message, true);
    } finally { T.busy = false; }
  }
  // Edit channels: each channel's shows; remove one, add any show, or go back to the default list.
  function cableEditPage(sc, gen) {
    sc.innerHTML = '<div class="tv-head" data-block="top"><h1>Edit channels</h1><div class="tv-chips"></div></div><div class="tv-cedit"><div class="tv-loading">Loading…</div></div>';
    loadLineup(sc, gen, T.editEra);
  }
  // Merged eras are edited one era at a time (a row of era buttons picks which).
  function loadLineup(sc, gen, era, focusKey) {
    api.tvCableLineup(era).then((r) => {
      if (gen != null && stale(gen)) return;
      T.lineMix = r.mix || [];
      T.editEra = r.channels[0] ? r.channels[0].era : null;
      drawLineup(sc, r.channels, focusKey);
    }).catch((e) => { if (gen == null || !stale(gen)) $('.tv-cedit', sc).innerHTML = empty(esc(e.message)); });
  }
  function drawLineup(sc, list, focusKey) {
    T.lineup = list;
    const cur = list.find((c) => c.id === T.cableEdit) || list[0];
    if (!cur) return;
    T.cableEdit = cur.id;
    S.zoneMemory.chips = 'ce-' + cur.id;
    const eraRow = (T.lineMix || []).length > 1 ? '<div class="tv-cedit-eras"><span>Editing the</span>' + T.lineMix.map((id) => '<button class="tv-chip' + (id === T.editEra ? ' on' : '') + '" data-nav data-key="cee-' + id + '" data-zone="ceeras" data-lock="ceeras" data-act="cable-edit-era" data-era="' + id + '">' + id + '</button>').join('') + '</div>' : '';
    $('.tv-chips', sc).innerHTML = list.map((c) => '<button class="tv-chip' + (c.id === cur.id ? ' on' : '') + '" data-nav data-key="ce-' + c.id + '" data-zone="chips" data-lock="chips" data-act="cable-ch" data-ch="' + esc(c.id) + '">' + c.number + ' ' + esc(c.name) + '</button>').join('');
    const head = $('.tv-head', sc);
    const old = $('.tv-cedit-eras', head);
    if (old) old.remove();
    if (eraRow) head.insertAdjacentHTML('beforeend', eraRow);
    const cards = cur.list.map((x, i) => '<button class="tv-poster tv-cshow' + (x.found ? '' : ' missing') + '" data-nav data-key="cs-' + i + '" data-zone="grid" data-act="cable-show" data-i="' + i + '" aria-label="' + esc(x.name) + '">' +
      (x.poster ? '<img src="' + esc(x.poster) + '" alt="" loading="lazy">' : '') + '<span class="tv-pname">' + esc(x.name) + '</span>' + (x.found ? '' : '<span class="tv-cmiss">' + (x.missing ? 'Not found' : 'Not looked up yet') + '</span>') + '</button>').join('');
    $('.tv-cedit', sc).innerHTML = '<div class="tv-cedit-btns"><button class="tv-btn primary" data-nav data-key="ce-add" data-zone="cebtns" data-act="cable-add">' + icon('plus') + '<span>Add a show</span></button>' +
      '<button class="tv-btn" data-nav data-key="ce-reset" data-zone="cebtns" data-act="cable-reset">Default shows</button><span class="tv-cedit-n">' + cur.list.length + ' shows on ' + esc(cur.name) + ((T.lineMix || []).length > 1 ? ' in the ' + esc(T.editEra) : '') + '</span></div><div class="tv-grid">' + cards + '</div>';
    place(focusKey || (currentFocus() && currentFocus().closest('.tv-scroll') && $('[data-key="' + cssEsc(currentFocus().dataset.key) + '"]', sc) ? currentFocus().dataset.key : 'ce-' + cur.id));
  }
  async function cableAddShow() {
    const ch = (T.lineup || []).find((c) => c.id === T.cableEdit);
    if (!ch) return;
    const q = await osk('Add a show to ' + ch.name, '', 'Show name');
    if (!q) return;
    let rows = [];
    try { rows = await api.tvSearch(q); } catch (e) { toast(e.message, true); return; }
    const items = [].concat(...rows.filter((r) => r.type === 'series').map((r) => r.items)).filter((x, i, a) => /^tt\d+$/.test(x.id) && a.findIndex((y) => y.id === x.id) === i).slice(0, 12);
    if (!items.length) { toast('No shows found for “' + q + '”', true); return; }
    const pick = await openMenu('Add to ' + ch.name, items.map((x) => ({ id: x.id, label: x.name + (x.releaseInfo ? ' (' + x.releaseInfo + ')' : ''), icon: 'plus' })));
    if (!pick) return;
    const it = items.find((x) => x.id === pick);
    const wait = toast('Adding ' + it.name + '…');
    try { const list = await api.tvCableAdd(ch.id, it, T.editEra); toast(it.name + ' is on ' + ch.name + ' now'); drawLineup(scroller(), list, 'cs-' + (list.find((c) => c.id === ch.id).list.length - 1)); }
    catch (e) { toast(e.message, true); }
    finally { if (wait && wait.remove) wait.remove(); }
  }
  async function cableShowMenu(i) {
    const ch = (T.lineup || []).find((c) => c.id === T.cableEdit);
    const x = ch && ch.list[i];
    if (!x) return;
    const pick = await openMenu(x.name, [{ id: 'remove', label: 'Remove from ' + ch.name, icon: 'x' }]);
    if (pick !== 'remove') return;
    try { const list = await api.tvCableRemove(ch.id, i, T.editEra); drawLineup(scroller(), list, 'cs-' + Math.max(0, Math.min(i, list.find((c) => c.id === ch.id).list.length - 1))); toast('Removed ' + x.name); }
    catch (e) { toast(e.message, true); }
  }

  // ---------------------------------------------------------------- Search
  function searchPage(sc, gen) {
    const q = T.query || '';
    sc.innerHTML = '<div class="tv-head" data-block="top"><h1>Search</h1><div class="tv-chips"><button class="tv-search" data-nav data-key="s-box" data-zone="chips" data-lock="chips" data-act="search">' + icon('search') + '<span>' + (q ? esc(q) : 'Movies and series') + '</span></button></div></div><div class="tv-rows"></div>';
    if (!q) { if (!T.searchAsked) { T.searchAsked = true; setTimeout(() => { if (!stale(gen)) askSearch(); }, 60); } return; }
    $('.tv-rows', sc).innerHTML = '<div class="tv-loading">Searching…</div>';
    api.tvSearch(q).then((rows) => {
      if (stale(gen)) return;
      $('.tv-rows', sc).innerHTML = rows.length ? rows.map((r, i) => sectionHTML(r.title, rowHTML(r.items.map((p, j) => posterHTML(p, 'sr' + i + '-' + j, 'sr' + i, 'sr' + i)).join('')))).join('') : empty('Nothing found for “' + esc(q) + '”.');
      settle();
    }).catch((e) => { if (!stale(gen)) $('.tv-rows', sc).innerHTML = empty('Search didn’t work: ' + esc(e.message)); });
  }
  async function askSearch() {
    const q = await osk('Search movies and series', T.query || '', 'Title');
    if (q == null) return;
    T.query = q.trim();
    if (T.page === 'search') render('s-box'); else go('search');
  }

  // ---------------------------------------------------------------- Addons
  function addonsPage(sc, gen) {
    const signed = T.status && T.status.signedIn;
    sc.innerHTML = '<div class="tv-head" data-block="top"><div><h1>Addons</h1><p class="tv-note">' + (signed ? 'Synced with your Stremio account. The order sets whose streams show first.' : 'Sign in (Settings › Movies & TV) to use the addons from your Stremio account.') + '</p></div>' +
      '<div class="tv-chips"><button class="tv-btn" data-nav data-key="ad-discover" data-zone="adtop" data-lock="adtop" data-act="ad-discover">Discover addons</button>' +
      '<button class="tv-btn" data-nav data-key="ad-paste" data-zone="adtop" data-lock="adtop" data-act="ad-paste">Paste addon link</button>' +
      '<button class="tv-btn" data-nav data-key="ad-type" data-zone="adtop" data-lock="adtop" data-act="ad-type">Type addon link</button></div></div><div class="tv-addons"><div class="tv-loading">Loading…</div></div>';
    api.tvAddons(true).then((list) => {
      if (stale(gen)) return;
      const has = (a, r) => a.resources.includes(r);
      $('.tv-addons', sc).innerHTML = list.map((a, i) => '<button class="tv-addon" data-nav data-key="ad-' + esc(a.id) + '" data-zone="adgrid" data-act="addon" data-ref="' + ref(a) + '">' +
        '<span class="tv-alogo">' + (a.logo ? '<img src="' + esc(a.logo) + '" alt="">' : '') + '<b>' + esc((a.name || '?').charAt(0)) + '</b></span>' +
        '<span class="tv-ainfo"><span class="tv-aname">' + esc(a.name) + '</span><span class="tv-asub">' + esc(a.protected ? 'Built in' : (has(a, 'stream') ? ordinal(list.filter((x) => x.resources.includes('stream')).indexOf(a) + 1) + ' for streams' : a.version ? 'Version ' + a.version : '')) + '</span></span>' +
        '<span class="tv-atags">' + [['stream', 'Streams'], ['catalog', 'Catalogs'], ['meta', 'Info'], ['subtitles', 'Subtitles']].filter(([r]) => has(a, r)).map(([, l]) => '<i>' + l + '</i>').join('') + '</span></button>').join('');
      if (!currentFocus() || !currentFocus().closest('.tv-scroll')) place();
    }).catch((e) => { if (!stale(gen)) $('.tv-addons', sc).innerHTML = empty('Couldn’t load your addons: ' + esc(e.message)); });
  }
  const ordinal = (n) => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');
  async function addonMenu(a) {
    const items = [];
    if (a.configurable) items.push({ id: 'configure', label: 'Set up on its website', icon: 'gear' });
    items.push({ id: 'up', label: 'Move up', icon: 'up' }, { id: 'down', label: 'Move down', icon: 'up' });
    if (!a.protected) items.push({ id: 'remove', label: 'Remove', icon: 'trash', danger: true });
    const c = await openMenu(a.name, items);
    try {
      if (c === 'configure') { await api.tvAddonConfigure(a.url); toast('Opened on your PC. Install the link it gives you with Paste addon link.'); }
      else if (c === 'up' || c === 'down') { await api.tvAddonMove(a.url, c === 'up' ? -1 : 1); T.catalogs = null; render('ad-' + a.id); }
      else if (c === 'remove') { if (await confirmBox('Remove ' + a.name + '?', 'Its catalogs and streams won’t show any more.', 'Remove', true)) { await api.tvAddonRemove(a.url); T.catalogs = null; render(); toast(a.name + ' removed'); } }
    } catch (e) { toast(e.message, true); }
  }
  async function installAddon(fn) {
    try { const a = await fn(); T.catalogs = null; toast(a.name + ' added'); render('ad-' + a.id); } catch (e) { toast(e.message, true); }
  }

  // ---------------------------------------------------------------- Show / movie page
  // Opening a title: its poster grows out of the row into the full-screen page (like an app
  // opening on Apple TV), the artwork fades from the poster to the backdrop, and the page fades in.
  function openShow(p, fromEl) {
    const bg = p.background || metahub('background', p.id);
    const z = fromEl && zoomFrom(fromEl, bg);
    push('show', { show: { preview: p, meta: null, season: null } });
    pageIn(!!z);
  }
  const EASE = 'cubic-bezier(.32,.72,0,1)'; // iOS-like
  function pageIn(late) {
    const sc = scroller();
    if (!sc || reduce()) return;
    sc.animate([{ opacity: 0, transform: 'translateY(2.4rem)' }, { opacity: 1, transform: 'none' }], { duration: late ? 420 : 300, delay: late ? 230 : 0, easing: EASE, fill: 'backwards' });
  }
  // The zoom is drawn frame by frame (not a fixed CSS animation) so it always lands exactly on
  // the poster, even if the row is still scrolling into place; and it always cleans up, even if
  // the window was hidden halfway (frames stop while it isn't on screen).
  const easeOut = (t) => 1 - Math.pow(1 - t, 4); // close to the iOS curve
  const zooms = new Set();
  function endZooms() {
    for (const z of zooms) z.finish();
    zooms.clear();
  }
  function zoomBox(poster, bg) {
    const el = document.createElement('div');
    el.className = 'tv-zoom';
    el.innerHTML = (bg ? '<i class="z-bg" style="background-image:url(&quot;' + esc(bg) + '&quot;)"></i>' : '') + (poster ? '<i class="z-po" style="background-image:url(&quot;' + esc(poster) + '&quot;)"></i>' : '');
    $('.tv', T.layer.el).appendChild(el);
    return el;
  }
  // from/to: functions giving { left, top, width, height, radius } (read every frame).
  function runZoom({ box, from, to, dur, poOpacity, onFinish, fadeOut }) {
    const po = $('.z-po', box);
    let raf = 0, timer = 0, done = false;
    const z = {
      finish() {
        if (done) return;
        done = true;
        cancelAnimationFrame(raf); clearTimeout(timer);
        if (onFinish) { try { onFinish(); } catch (_) { /* fine */ } }
        box.remove();
        zooms.delete(z);
      }
    };
    zooms.add(z);
    const t0 = performance.now();
    const place = (r) => Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', borderRadius: r.radius + 'px' });
    const frame = (now) => {
      if (done) return;
      const t = Math.min(1, (now - t0) / dur), k = easeOut(t);
      const a = from(), b = to();
      place({ left: a.left + (b.left - a.left) * k, top: a.top + (b.top - a.top) * k, width: a.width + (b.width - a.width) * k, height: a.height + (b.height - a.height) * k, radius: a.radius + (b.radius - a.radius) * k });
      if (po && poOpacity) po.style.opacity = String(poOpacity(t));
      if (t < 1) { raf = requestAnimationFrame(frame); return; }
      if (!fadeOut) { z.finish(); return; }
      box.style.transition = 'opacity 260ms ease';
      box.style.opacity = '0';
      timer = setTimeout(() => z.finish(), 280);
    };
    place(from());
    if (po && poOpacity) po.style.opacity = String(poOpacity(0));
    raf = requestAnimationFrame(frame);
    // Whatever happens (window hidden, page changed), it's gone shortly after it should be.
    setTimeout(() => z.finish(), dur + 900);
    return z;
  }
  const rectOf = (el, radius) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, radius }; };
  const screenRect = () => ({ left: 0, top: 0, width: window.innerWidth, height: window.innerHeight, radius: 0 });
  const radiusOf = (el) => parseFloat(getComputedStyle(el).borderTopLeftRadius) || 12;
  function zoomFrom(el, bg) {
    if (reduce()) return null;
    endZooms();
    const start = rectOf(el, radiusOf(el));
    if (!start.width) return null;
    const img = $('img:not(.broken)', el);
    const box = zoomBox(img && img.src, bg);
    box.style.boxShadow = '0 2rem 5rem rgba(0,0,0,.6)';
    // Poster shows first, then gives way to the backdrop as it fills the screen.
    return runZoom({ box, from: () => start, to: screenRect, dur: 600, fadeOut: true,
      poOpacity: bg ? (t) => (t < 0.15 ? 1 : t > 0.6 ? 0 : 1 - (t - 0.15) / 0.45) : null });
  }
  // Going back from a title: the page shrinks back into its poster in the row.
  function zoomBack(bg) {
    if (reduce()) return;
    endZooms();
    const el = currentFocus();
    if (!el || !el.classList.contains('tv-poster') || !el.isConnected) { pageIn(false); return; }
    const img = $('img:not(.broken)', el);
    const box = zoomBox(img && img.src, bg);
    const radius = radiusOf(el), key = el.dataset.key;
    // The poster it lands on (the row can be redrawn meanwhile: then it's the new one), hidden
    // until the zoom gets there.
    const hidden = new Set();
    const target = () => {
      const cur = el.isConnected ? el : (key && $('.tv-scroll [data-key="' + cssEsc(key) + '"]', T.layer && T.layer.el)) || null;
      if (cur && !hidden.has(cur)) { cur.style.visibility = 'hidden'; hidden.add(cur); }
      return cur;
    };
    target();
    let last = null;
    runZoom({ box, from: screenRect, dur: 420, poOpacity: (t) => Math.min(1, t / 0.6),
      to: () => { const cur = target(); if (cur) last = rectOf(cur, radius); return last || screenRect(); },
      onFinish: () => { for (const h of hidden) h.style.visibility = ''; hidden.clear(); } });
  }
  function showPage(sc, gen) {
    const sh = T.show, p = sh.preview;
    backdrop(p.background || metahub('background', p.id));
    sc.innerHTML = '<section class="tv-detail" data-block="top"><h1 class="tv-htitle">' + (p.logo ? '<img class="tv-logo" src="' + esc(p.logo) + '" alt="' + esc(p.name) + '">' : esc(p.name)) + '</h1><div class="tv-hmeta"></div><p class="tv-hdesc">' + esc(p.description || '') + '</p>' +
      '<div class="tv-hbtns"><button class="tv-btn primary" data-nav data-key="d-play" data-zone="dbtn" data-act="d-play">' + icon('play') + '<span>Play</span></button>' +
      '<button class="tv-btn" data-nav data-key="d-streams" data-zone="dbtn" data-act="d-streams">Choose stream</button>' +
      '<button class="tv-btn round" data-nav data-key="d-lib" data-zone="dbtn" data-act="d-lib" aria-label="Add to Library">' + icon('plus') + '</button></div></section>' +
      '<div class="tv-eps"></div><div class="tv-extra"></div>';
    Promise.all([sh.meta ? Promise.resolve(sh.meta) : api.tvMeta(p.type, p.id), library()]).then(async ([m]) => {
      if (stale(gen)) return;
      sh.meta = m;
      const hm = $('.tv-hmeta', sc);
      hm.innerHTML = [m.releaseInfo, (m.genres || []).slice(0, 3).join(', '), m.runtime, m.imdbRating ? 'IMDb ' + m.imdbRating : ''].filter(Boolean).map(esc).join('<span class="dot">·</span>');
      if (!p.description && m.description) $('.tv-hdesc', sc).textContent = m.description;
      if (!p.background && m.background) backdrop(m.background);
      const ids = m.videos.map((v) => v.id);
      sh.watched = ids.length ? await api.tvWatched(ids).catch(() => ({})) : {};
      if (stale(gen)) return;
      drawDetailButtons(sc);
      if (m.type === 'series' && m.videos.length) drawEpisodes(sc);
      const ex = [];
      if (m.cast && m.cast.length) ex.push('<div><b>Starring</b> ' + esc(m.cast.slice(0, 5).join(', ')) + '</div>');
      if (m.director && m.director.length) ex.push('<div><b>Director</b> ' + esc(m.director.join(', ')) + '</div>');
      $('.tv-extra', sc).innerHTML = ex.length ? '<section class="tv-sec tv-credits" data-block>' + ex.join('') + '</section>' : '';
    }).catch((e) => { if (!stale(gen)) $('.tv-eps', sc).innerHTML = empty('Couldn’t load this: ' + esc(e.message)); });
  }
  // What Play does on a show page: resume where you left off, or the next unwatched episode.
  function nextUp(sh) {
    const m = sh.meta;
    const cw = cwFor(m.id);
    if (m.type !== 'series' || !m.videos.length) return { video: null, resume: !!cw, label: cw ? 'Resume' + (minsLeft(cw) ? ' · ' + minsLeft(cw) : '') : 'Play' };
    const eps = m.videos.filter((v) => v.season > 0);
    const list = eps.length ? eps : m.videos;
    if (cw && cw.videoId) { const v = list.find((x) => x.id === cw.videoId); if (v) return { video: v, resume: true, label: 'Resume S' + v.season + ':E' + v.episode }; }
    let lastWatched = -1;
    list.forEach((v, i) => { if (sh.watched && sh.watched[v.id]) lastWatched = i; });
    const v = list[Math.min(list.length - 1, lastWatched + 1)] || list[0];
    return { video: v, resume: false, label: 'Play S' + v.season + ':E' + v.episode };
  }
  function drawDetailButtons(sc) {
    const sh = T.show, nu = nextUp(sh);
    $('[data-key="d-play"] span', sc).textContent = nu.label;
    const inLib = T.lib && T.lib.items.some((x) => x.id === sh.meta.id);
    const lb = $('[data-key="d-lib"]', sc);
    lb.innerHTML = icon(inLib ? 'check' : 'plus'); lb.setAttribute('aria-label', inLib ? 'In your Library' : 'Add to Library');
  }
  function seasonsOf(m) {
    const s = [...new Set(m.videos.map((v) => v.season))].sort((a, b) => (a === 0) - (b === 0) || a - b);
    return s;
  }
  function drawEpisodes(sc) {
    const sh = T.show, m = sh.meta;
    const seasons = seasonsOf(m);
    if (sh.season == null || !seasons.includes(sh.season)) { const nu = nextUp(sh); sh.season = nu.video ? nu.video.season : seasons[0]; }
    const cw = cwFor(m.id);
    const eps = m.videos.filter((v) => v.season === sh.season);
    const focusKey = currentFocus() && currentFocus().dataset.key;
    S.zoneMemory.seasons = 'se-' + sh.season;
    $('.tv-eps', sc).innerHTML = '<section class="tv-sec" data-block>' + (seasons.length > 1 ? '<div class="tv-chips">' + seasons.map((n) => '<button class="tv-chip' + (n === sh.season ? ' on' : '') + '" data-nav data-key="se-' + n + '" data-zone="seasons" data-lock="seasons" data-act="season" data-s="' + n + '">' + (n === 0 ? 'Specials' : 'Season ' + n) + '</button>').join('') + '</div>' : '<h2>Episodes</h2>') +
      rowHTML(eps.map((v) => {
        const img = v.thumbnail || metahub('background', m.id);
        const isCur = cw && cw.videoId === v.id;
        const pct = isCur && cw.duration ? Math.min(100, Math.round(cw.offset / cw.duration * 100)) : sh.watched[v.id] ? 100 : 0;
        return '<button class="tv-ep" data-nav data-key="ep-' + esc(v.id) + '" data-zone="eps" data-lock="eps" data-act="episode" data-ref="' + ref(v) + '" aria-label="' + esc('Episode ' + v.episode + (v.title ? ', ' + v.title : '')) + '">' +
          '<span class="tv-wimg">' + (img ? '<img src="' + esc(img) + '" alt="" loading="lazy">' : '') + (sh.watched[v.id] ? '<span class="tv-check">' + icon('check') + '</span>' : '') + (pct ? '<span class="tv-prog"><i style="width:' + pct + '%"></i></span>' : '') + '</span>' +
          '<span class="tv-eno">EPISODE ' + v.episode + (v.released ? ' · ' + esc(new Date(v.released).getFullYear() || '') : '') + (isCur ? ' · RESUME' : '') + '</span><span class="tv-etitle">' + esc(v.title || 'Episode ' + v.episode) + '</span>' +
          (v.overview ? '<span class="tv-eover">' + esc(v.overview) + '</span>' : '') + '</button>';
      }).join('')) + '</section>';
    if (focusKey && $('[data-key="' + cssEsc(focusKey) + '"]', sc)) place(focusKey);
  }

  // ---------------------------------------------------------------- playing
  async function play(meta, video, opts) {
    opts = opts || {};
    if (T.busy) return;
    const videoId = video ? video.id : meta.id;
    const req = { meta: { id: meta.id, type: meta.type, name: meta.name, poster: meta.poster || null, videos: meta.videos || [] }, videoId };
    if (opts.stream) req.stream = opts.stream;
    else if (!opts.pick && (opts.resume || S.lib.settings.tvAutoPlay)) req.mode = opts.resume ? 'resume' : 'best';
    else return pickStream(meta, video);
    if (opts.from0) req.startAt = 0;
    T.busy = true;
    const wait = toast('Starting ' + (video ? 'S' + video.season + ':E' + video.episode : meta.name) + '…');
    const t0 = Date.now();
    try {
      await api.tvPlay(req);
      // (It can already have ended, before the answer came back.)
      if (!(T.endedAt >= t0)) { S.tvPlaying = true; S.tvPlayingAt = 0; }
    } catch (e) {
      if (/NO_MPV/.test(e.message)) { T.busy = false; if (await mpvSetup()) return play(meta, video, opts); return; }
      toast(e.message, true);
    } finally { T.busy = false; if (wait && wait.remove) wait.remove(); }
  }
  // After the video closes: show where you are now.
  function ended(payload) {
    S.tvPlaying = false;
    T.endedAt = Date.now();
    if (payload && payload.error) toast(payload.error, true);
    if (!isOpen()) return;
    // Back from Cable TV: the guide, on the channel you were watching.
    if (payload && payload.cable) {
      S.lib.settings.cableLast = payload.cable;
      if (T.page !== 'cable') { T.page = 'cable'; T.stack = []; }
      render();
      return;
    }
    library(true).then(() => {
      if (!isOpen() || k.topLayer() !== T.layer) return;
      const key = currentFocus() && currentFocus().dataset.key;
      if (T.page === 'show' && T.show) {
        if (payload && payload.videoId && T.show.meta) api.tvWatched(T.show.meta.videos.map((v) => v.id)).then((w) => { T.show.watched = w || {}; const sc = scroller(); drawDetailButtons(sc); if (T.show.meta.type === 'series') drawEpisodes(sc); place(key); }).catch(() => {});
      } else if (T.page === 'home') { drawCw(scroller()); place(key); }
      else if (T.page === 'library') render(key, scroller().scrollTop);
    });
  }
  async function playPreview(p, cw) {
    try {
      const m = await api.tvMeta(p.type, p.id);
      if (m.type === 'series' && m.videos.length) {
        const sh = { meta: m, watched: await api.tvWatched(m.videos.map((v) => v.id)).catch(() => ({})) };
        const nu = nextUp(sh);
        return play(m, nu.video, { resume: nu.resume || !!cw });
      }
      return play(m, null, { resume: !!cw });
    } catch (e) { toast(e.message, true); }
  }

  // Stream picker: grouped by addon, filter by quality, best match on top.
  function pickStream(meta, video) {
    let data = null, err = null, q = 'all';
    const label = meta.name + (video ? ' · S' + video.season + ':E' + video.episode + (video.title ? ' · ' + video.title : '') : '');
    const layer = openLayer({
      className: 'tv-sheet-layer tv-' + mode(),
      html: '<div class="tv-sheet"><div class="tv-sheet-head"><div><div class="tv-kicker">' + esc(label.toUpperCase()) + '</div><h1>Choose a stream</h1></div><div class="tv-note tv-count">Asking your addons…</div></div>' +
        '<div class="tv-chips"></div><div class="tv-streams"><div class="tv-loading">Finding streams…</div></div>' +
        '<div class="tv-sheet-foot"></div></div>',
      onActivate: (el) => {
        const a = el.dataset.act;
        if (a === 'q') { q = el.dataset.q; draw(el.dataset.key); return; }
        if (a === 'auto') { S.lib.settings.tvAutoPlay = !S.lib.settings.tvAutoPlay; save(); foot(); place2('auto'); return; }
        if (a === 'stream') { const s = data && data.flat[Number(el.dataset.i)]; if (s) { closeLayer(layer); play(meta, video, { stream: s }); } }
      },
      onFocus: (el) => { if (el.dataset.act === 'q' && el.dataset.q !== q) { q = el.dataset.q; draw(el.dataset.key); } },
      onBack: () => closeLayer(layer),
      prompts: (el) => (el && el.dataset.act === 'stream' ? [['A', 'Play'], ['B', 'Close']] : [['A', 'Select'], ['B', 'Close']])
    });
    const place2 = (key) => { const el = $('[data-key="' + cssEsc(key) + '"]', layer.el); if (el) setFocus(el, { instant: true }); };
    function foot() {
      $('.tv-sheet-foot', layer.el).innerHTML = '<button class="tv-toggle" data-nav data-key="auto" data-zone="sfoot" data-act="auto" role="switch" aria-checked="' + (S.lib.settings.tvAutoPlay ? 'true' : 'false') + '"><span class="tv-box">' + (S.lib.settings.tvAutoPlay ? icon('check') : '') + '</span>Next time, play the best match straight away</button>';
    }
    function draw(focusKey) {
      if (err) { $('.tv-streams', layer.el).innerHTML = empty('Couldn’t get streams: ' + esc(err)); return; }
      if (!data) return;
      const qs = ['all'].concat(['4K', '1080p', '720p', '480p'].filter((x) => data.flat.some((s) => s.quality === x)));
      S.zoneMemory.qchips = 'q-' + q;
      $('.tv-chips', layer.el).innerHTML = qs.map((x) => '<button class="tv-chip' + (q === x ? ' on' : '') + '" data-nav data-key="q-' + x + '" data-zone="qchips" data-lock="qchips" data-act="q" data-q="' + x + '">' + (x === 'all' ? 'All' : x) + '</button>').join('');
      const groups = data.groups.map((g) => ({ addon: g.addon, error: g.error, list: g.streams.map((s) => ({ s, i: data.flat.indexOf(s) })).filter((x) => x.s.playable && (q === 'all' || x.s.quality === q)) }));
      const shown = groups.filter((g) => g.list.length);
      $('.tv-count', layer.el).textContent = data.total ? data.flat.filter((s) => s.playable).length + ' found by ' + data.groups.filter((g) => g.streams.length).length + ' addon' + (data.groups.filter((g) => g.streams.length).length === 1 ? '' : 's') : '';
      $('.tv-streams', layer.el).innerHTML = shown.length ? shown.map((g) => '<div class="tv-sgroup"><div class="tv-sname">' + esc(g.addon.toUpperCase()) + '</div>' + g.list.map(({ s, i }) =>
        '<button class="tv-stream" data-nav data-key="st-' + i + '" data-zone="streams" data-act="stream" data-i="' + i + '"><span class="tv-q">' + esc(s.quality || (s.kind === 'url' ? 'Link' : 'P2P')) + '</span>' +
        '<span class="tv-sinfo"><span class="tv-slabel">' + esc(s.label) + '</span><span class="tv-sdetail">' + esc([s.size, s.seeds != null ? s.seeds + ' peers' : '', s.hdr, s.audio, s.cached ? 'Instant' : s.kind === 'torrent' ? 'Torrent' : ''].filter(Boolean).join(' · ') || s.detail || s.name) + '</span></span>' +
        (data.best === s ? '<span class="tv-badge">BEST MATCH</span>' : '') + '</button>').join('') + '</div>').join('')
        : empty(data.total ? 'No ' + q + ' streams.' : (data.addons ? 'Your addons didn’t find a stream for this.' : 'You have no addons with streams. Add one in Addons.'));
      const want = focusKey && $('[data-key="' + cssEsc(focusKey) + '"]', layer.el);
      setFocus(want || $('.tv-stream', layer.el) || $('[data-nav]', layer.el), { instant: true });
    }
    foot();
    api.tvStreams(meta.type, video ? video.id : meta.id).then((r) => {
      const flat = [].concat(...r.groups.map((g) => g.streams));
      const best = r.best ? flat.find((s) => s.addon === r.best.addon && s.label === r.best.label) : null;
      // Best match first in its addon's list.
      if (best) { const g = r.groups.find((x) => x.streams.includes(best)); g.streams = [best].concat(g.streams.filter((s) => s !== best)); r.groups = [g].concat(r.groups.filter((x) => x !== g)); }
      data = Object.assign(r, { flat: [].concat(...r.groups.map((g) => g.streams)), best });
      if (k.layers.includes(layer)) draw();
    }).catch((e) => { err = e.message; if (k.layers.includes(layer)) draw(); });
  }

  // mpv isn't there yet: install it (one press) or point at it.
  async function mpvSetup() {
    const mac = /Mac/i.test(navigator.platform || '') || /Macintosh/.test(navigator.userAgent || '');
    const c = await openMenu('Movies play in mpv', [
      { id: 'install', label: mac ? 'Install mpv now (with Homebrew, free)' : 'Install mpv now (free, about a minute)', icon: 'plus' },
      { id: 'choose', label: mac ? 'I have it: choose mpv in Applications' : 'I have it: choose mpv.exe', icon: 'folder' }
    ]);
    try {
      if (c === 'install') {
        const t = toast('Installing mpv… this takes about a minute');
        await api.tvInstallMpv();
        if (t && t.remove) t.remove();
        toast('mpv is ready');
        return true;
      }
      if (c === 'choose') {
        const p = await browse(mac ? { title: 'Find mpv', exts: ['.app'], hint: 'Pick mpv in Applications' } : { title: 'Find mpv.exe', exts: ['.exe'], hint: 'Pick mpv.exe' });
        if (!p) return false;
        await api.tvSetMpv(p);
        return true;
      }
    } catch (e) { toast(e.message, true); }
    return false;
  }

  // Sign in on your phone with a code, or with email + password.
  async function signIn() {
    let code = null, timer = null, done = false;
    const layer = openLayer({
      className: 'tv-sheet-layer tv-' + mode(),
      html: '<div class="tv-sheet tv-signin"><h1>Sign in to Stremio</h1><div class="tv-signin-body"><div class="tv-loading">Getting a code…</div></div>' +
        '<div class="tv-sheet-foot"><button class="tv-btn" data-nav data-key="si-email" data-zone="sfoot" data-act="email">Use email and password</button><button class="tv-btn" data-nav data-key="si-cancel" data-zone="sfoot" data-act="cancel">Cancel</button></div></div>',
      onActivate: async (el) => {
        if (el.dataset.act === 'cancel') return closeLayer(layer);
        if (el.dataset.act === 'email') {
          const email = await osk('Stremio email', '', 'you@example.com', { email: true });
          if (!email) return;
          const pw = await osk('Stremio password', '', '', { secret: true });
          if (!pw) return;
          try { await api.tvLogin(email, pw); success(); } catch (e) { toast(e.message, true); }
        }
      },
      onBack: () => closeLayer(layer),
      onClose: () => { clearInterval(timer); },
      prompts: () => [['A', 'Select'], ['B', 'Cancel']]
    });
    function success() {
      if (done) return;
      done = true;
      clearInterval(timer);
      closeLayer(layer);
      toast('Signed in to Stremio');
      T.catalogs = null; T.lib = null;
      refreshStatus().then(() => { if (isOpen()) render(); if (k.refreshSettings) k.refreshSettings(); });
    }
    try {
      code = await api.tvLinkCreate();
      if (!k.layers.includes(layer)) return;
      $('.tv-signin-body', layer.el).innerHTML = (code.qrcode ? '<img class="tv-qr" src="' + esc(code.qrcode) + '" alt="QR code to sign in">' : '') +
        '<div class="tv-steps"><p>On your phone or computer, go to</p><div class="tv-link">' + esc(code.link.replace(/^https?:\/\//, '')) + '</div><p>and enter this code:</p><div class="tv-code">' + esc(code.code) + '</div><p class="tv-note">This screen continues by itself once you’re signed in.</p></div>';
      const started = Date.now();
      timer = setInterval(async () => {
        if (Date.now() - started > 10 * 60e3) { clearInterval(timer); return; }
        try { const r = await api.tvLinkPoll(code.code); if (r && r.done) success(); } catch (_) { /* keep waiting */ }
      }, 3000);
    } catch (e) {
      if (k.layers.includes(layer)) $('.tv-signin-body', layer.el).innerHTML = '<p class="tv-note">' + esc(e.message) + '. Sign in with your email and password instead.</p>';
    }
  }

  // ---------------------------------------------------------------- controller
  async function activate(el) {
    const a = el.dataset.act, r = got(el);
    switch (a) {
      case 'section': return el.dataset.to === 'search' ? (T.page === 'search' ? askSearch() : go('search')) : go(el.dataset.to);
      case 'settings': closeLayer(T.layer); return k.openSettings && k.openSettings();
      case 'item': return r && openShow(r, el);
      case 'resume': return r && playPreview({ id: r.id, type: r.type, name: r.name, poster: r.poster }, r);
      case 'more': return r && push('cat', { grid: { view: true, fixed: !r.c, type: r.c ? r.c.type : 'movie', cat: r.c || null, title: r.title, genre: null, items: (r.items || []).slice(), done: !r.c, loading: false } });
      case 'hero-play': { const p = heroItem(); return p && playPreview(p, cwFor(p.id)); }
      case 'hero-info': { const p = heroItem(); return p && openShow(p, null); }
      case 'hero-lib': { const p = heroItem(); if (p) await toggleLib(p); return hero(); }
      case 'signin': return signIn();
      case 'signin-later': S.lib.settings.tvSignInSeen = true; save(); return render();
      case 'chip': {
        const g = T.grid;
        if (r.k === 'cat') { g.cat = r.c; g.genre = null; } else g.genre = r.label === g.genre ? null : r.label;
        g.items = []; g.done = false; g.loading = false;
        return render(el.dataset.key);
      }
      case 'libfilter': T.libFilter = el.dataset.f; return render(el.dataset.key);
      case 'search': return askSearch();
      case 'cable-tune': return tuneIn(el.dataset.ch);
      case 'cable-edit': return push('cableedit');
      case 'cable-pick-era': return toggleEra(el.dataset.era);
      case 'cable-eras-go': return watchEras();
      case 'cable-era': return push('cableeras');
      case 'cable-edit-era': T.editEra = el.dataset.era; return loadLineup(scroller(), null, T.editEra, el.dataset.key);
      case 'cable-ads': {
        const on = S.lib.settings.cableAds === false;
        S.lib.settings.cableAds = on; save();
        T.cableKeepHead = true;
        toast(on ? 'Commercials on: real commercial breaks from the time, and shows in 30-minute slots' : 'Commercials off: just the shows, back to back');
        return render('cb-ads');
      }
      case 'cable-ch': T.cableEdit = el.dataset.ch; return drawLineup(scroller(), T.lineup || [], el.dataset.key);
      case 'cable-add': return cableAddShow();
      case 'cable-show': return cableShowMenu(Number(el.dataset.i));
      case 'cable-reset': {
        const ch = (T.lineup || []).find((c) => c.id === T.cableEdit);
        if (!ch || !(await confirmBox('Go back to the default shows?', 'Shows you added to ' + ch.name + ' are taken off, and ones you removed come back.', 'Default shows', true))) return;
        try { const list = await api.tvCableReset(ch.id, T.editEra); drawLineup(scroller(), list, 'ce-reset'); api.tvCableSetup().catch(() => {}); } catch (e) { toast(e.message, true); }
        return;
      }
      case 'addon': return addonMenu(r);
      case 'ad-discover': try { await api.tvDiscover(); toast('Opened stremio-addons.net on your PC. Copy an addon’s link there, then press Paste addon link.'); } catch (e) { toast(e.message, true); } return;
      case 'ad-paste': return installAddon(() => api.tvAddonClipboard());
      case 'ad-type': { const u = await osk('Addon link', 'https://', 'https://…/manifest.json'); if (u) installAddon(() => api.tvAddonInstall(u)); return; }
      case 'd-play': { const sh = T.show; if (!sh.meta) return; const nu = nextUp(sh); return play(sh.meta, nu.video, { resume: nu.resume }); }
      case 'd-streams': { const sh = T.show; if (!sh.meta) return; return play(sh.meta, nextUp(sh).video, { pick: true }); }
      case 'd-lib': { const sh = T.show; if (!sh.meta) return; await toggleLib(sh.meta); return drawDetailButtons(scroller()); }
      case 'season': T.show.season = Number(el.dataset.s); return drawEpisodes(scroller());
      case 'episode': { const sh = T.show; const cw = cwFor(sh.meta.id); return play(sh.meta, r, { resume: !!(cw && cw.videoId === r.id) }); }
      default: return null;
    }
  }
  async function toggleLib(p) {
    const inLib = T.lib && T.lib.items.some((x) => x.id === p.id);
    try {
      await api.tvLibSet({ id: p.id, type: p.type, name: p.name, poster: p.poster || metahub('poster', p.id) }, !inLib);
      await library();
      toast(inLib ? 'Removed from your Library' : 'Added to your Library');
    } catch (e) { toast(e.message, true); }
  }
  function buttonPress(b) {
    const el = currentFocus();
    if (b === 'LB' || b === 'RB') {
      if (T.page === 'show') {
        const chips = $$('[data-act="season"]', scroller());
        const i = chips.findIndex((c) => c.classList.contains('on'));
        const n = chips[i + (b === 'RB' ? 1 : -1)];
        if (n) { T.show.season = Number(n.dataset.s); drawEpisodes(scroller()); setFocus($('[data-act="season"].on', scroller()) || n); }
        return true;
      }
      const order = SECTIONS.map((x) => x[0]).concat(['search']);
      const i = Math.max(0, order.indexOf(T.page === 'cat' ? (T.stack[0] && T.stack[0].page) || 'home' : T.page));
      const n = Math.max(0, Math.min(order.length - 1, i + (b === 'RB' ? 1 : -1)));
      if (n !== i) go(order[n]);
      return true;
    }
    if (b === 'Y') { askSearch(); return true; }
    if (b === 'X' && T.page === 'cableedit' && el && el.dataset.act === 'cable-show') { cableShowMenu(Number(el.dataset.i)); return true; }
    if (b === 'X') {
      if (el && el.dataset.act === 'episode') {
        const v = got(el), sh = T.show, on = !sh.watched[v.id];
        api.tvSetWatched(v.id, on).then(() => { if (on) sh.watched[v.id] = true; else delete sh.watched[v.id]; drawEpisodes(scroller()); drawDetailButtons(scroller()); toast(on ? 'Marked as watched' : 'Marked as not watched'); });
        return true;
      }
      if (el && (el.dataset.act === 'item' || el.dataset.act === 'resume')) { const p = got(el); toggleLib(p).then(() => { if (T.page === 'library') render(); }); return true; }
      return true;
    }
    if (b === 'LT' || b === 'RT') { const sc = scroller(); sc.scrollBy({ top: (b === 'RT' ? 1 : -1) * sc.clientHeight * 0.8, behavior: behavior() }); return true; }
    if (b === 'MENU') return true;
    return false;
  }
  function focused(el, opts) {
    if (!el || !isOpen()) return;
    // Keep the focused thing on screen, with the whole row visible.
    // (Couch TV: not for what the pointer is merely over or clicked: the page stays put.)
    const still = !!(k.standalone && opts && opts.noScroll);
    const sc = scroller();
    if (!still) keepSideways(el);
    if (!still && el.closest('.tv-scroll')) {
      const block = el.closest('[data-block]');
      if (block && block.dataset.block === 'top') { if (sc.scrollTop > 0) sc.scrollTo({ top: 0, behavior: behavior() }); }
      else {
        const box = el.closest('.tv-grid') ? el : (block || el);
        const r = box.getBoundingClientRect(), c = sc.getBoundingClientRect();
        const topPad = c.height * 0.16, bottomPad = c.height * 0.08;
        let dy = 0;
        if (r.top < c.top + topPad) dy = r.top - (c.top + topPad);
        else if (r.bottom > c.bottom - bottomPad) dy = r.bottom - (c.bottom - bottomPad);
        if (Math.abs(dy) > 2) sc.scrollTo({ top: Math.max(0, sc.scrollTop + dy), behavior: behavior() });
      }
    }
    // Genres and seasons follow the focus, like the launcher's Settings tabs.
    if (el.dataset.act === 'season' && T.show && Number(el.dataset.s) !== T.show.season) {
      clearTimeout(T.chipTimer);
      T.chipTimer = setTimeout(() => { if (currentFocus() === el) { T.show.season = Number(el.dataset.s); drawEpisodes(scroller()); } }, 160);
    }
    // Near the end of a grid: get more.
    if (el.dataset.gi != null && T.grid && Number(el.dataset.gi) > T.grid.items.length - 16) loadMore(T.gen);
    // Show the poster's backdrop behind Movies and Series pages.
    if ((T.page === 'movie' || T.page === 'series' || T.page === 'search' || T.page === 'cat') && el.dataset.act === 'item') { const p = got(el); if (p) backdrop(p.background || metahub('background', p.id)); }
    if (T.page === 'cable') cableInfo(el);
    hints(el);
  }
  // Rows scroll sideways to keep the focused card inside the page margins.
  function keepSideways(el) {
    const row = el.closest('.tv-row, .tv-chips');
    if (!row) return;
    const r = el.getBoundingClientRect(), c = row.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(row).paddingLeft) || 0;
    let dx = 0;
    if (r.left < c.left + pad) dx = r.left - (c.left + pad);
    else if (r.right > c.right - pad) dx = r.right - (c.right - pad);
    if (Math.abs(dx) > 1) row.scrollTo({ left: Math.max(0, row.scrollLeft + dx), behavior: behavior() });
  }
  function prompts(el) {
    const a = el && el.dataset.act;
    const list = [['A', a === 'item' ? 'Open' : a === 'episode' || a === 'resume' || a === 'stream' ? 'Play' : a === 'cable-tune' ? 'Watch' : a === 'cable-pick-era' ? (el.getAttribute('aria-pressed') === 'true' ? 'Unpick' : 'Pick') : 'Select']];
    if (a === 'cable-show') list.push(['X', 'Remove']);
    if (a === 'episode') list.push(['X', 'Watched']);
    else if (a === 'item' || a === 'resume') list.push(['X', 'Library']);
    list.push(['Y', 'Search']);
    if (T.stack.length || T.page !== 'home') list.push(['B', 'Back']); else if (!k.standalone) list.push(['B', 'Close']);
    return list;
  }
  function hints(el) {
    const h = $('.tv-hints', T.layer.el);
    if (!h) return;
    const p = prompts(el);
    h.innerHTML = p.map(([b, l]) => '<span' + (k.standalone && (b === 'B' || b === 'Y') ? ' data-b="' + b + '"' : '') + '><i class="g' + (b === 'A' ? ' a' : '') + '">' + esc(k.glyphText(b)) + '</i>' + esc(l) + '</span>').join('') +
      '<span><i class="g w">' + esc(k.glyphText('LB') + ' ' + k.glyphText('RB')) + '</i>' + (T.page === 'show' ? 'Seasons' : 'Sections') + '</span>';
  }

  return { open, isOpen, signIn, mpvSetup, ended, refreshStatus, status: () => T.status };
};
