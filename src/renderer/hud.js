'use strict';
/* Player controls over the video. The app core sends the whole picture of what to show. */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (t) => {
    t = Math.max(0, Math.floor(t || 0));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  };
  const clock = (t) => { const d = new Date(t); let h = d.getHours(); const m = d.getMinutes(); const pm = h >= 12; h = h % 12 || 12; return h + ':' + String(m).padStart(2, '0') + ' ' + (pm ? 'PM' : 'AM'); };
  // Couch TV shows these inside its window, where the mouse works them too (?mouse=1): every
  // row of a list is there to click (and the list scrolls), instead of the nine around the
  // highlighted one.
  const MOUSE = /[?&]mouse=1/.test(location.search);
  const menuHTML = (items, start) => (MOUSE ? items.map((it, i) => ({ it, i })) : items.slice(start, start + 9).map((it, k) => ({ it, i: start + k })))
    .map(({ it, i }) => '<div class="mi' + (it.focused && !MOUSE ? ' focus' : '') + '" data-m="menuPick" data-x="' + i + '"><span class="ck">' + (it.selected ? '✓' : '') + '</span>' + esc(it.label) + '</div>').join('');
  let last = null; // what is drawn now
  // Cable TV: channel banner, black between channels, "coming up next" between shows.
  function drawCable(c) {
    if (MOUSE) $('cb-strip-m').classList.toggle('on', !!c.strip && !c.menu);
    const box = $('cable');
    box.hidden = false;
    box.style.setProperty('--ch', c.color || '#fff');
    $('cb-blank').classList.toggle('on', !!c.blank || !!c.brk);
    $('cb-num').classList.toggle('on', !!c.banner);
    $('cb-n').textContent = c.number; $('cb-cn').textContent = c.name;
    const st = $('cb-status');
    st.textContent = c.blank ? c.status || '' : '';
    st.classList.toggle('spin', !!c.blank && /…$/.test(c.status || ''));
    const bk = $('cb-break');
    bk.hidden = !c.brk;
    if (c.brk) {
      // A break with no commercials: back to the show after it, or what's next.
      const back = c.part === 'filler' && c.backAt;
      const at = back ? c.backAt : c.next ? c.next.start : 0;
      $('cb-bk').textContent = back ? c.name : 'Coming up next on ' + c.name;
      $('cb-bt').textContent = back ? c.show : c.next ? c.next.show : '';
      const sec = at ? Math.max(0, Math.round((at - c.now) / 1000)) : 0;
      $('cb-why').textContent = back && c.why ? 'No commercials this break: ' + c.why : '';
      $('cb-bw').textContent = at ? (back ? 'continues ' : '') + (sec > 60 ? 'at ' + clock(at) : sec > 3 ? 'in ' + sec + ' seconds' : 'in a moment') : '';
    }
    // Bumper cards between the show and the commercials.
    const card = $('cb-card');
    card.classList.toggle('on', !!c.card);
    if (c.card) {
      const k = c.card.kind;
      $('cb-ck').textContent = c.name;
      $('cb-ct').textContent = k === 'brb' ? 'We’ll be right back' : k === 'back' ? 'Now back to' : 'Coming up next';
      $('cb-cs').textContent = k === 'brb' ? 'to ' + (c.card.text || 'the show') : c.card.text || '';
    }
    const b = $('cb-banner');
    b.classList.toggle('on', !!c.banner && !c.brk && !c.card);
    b.classList.toggle('ad', c.part === 'ad');
    $('cb-bn').textContent = c.number; $('cb-bname').textContent = c.name;
    $('cb-time').textContent = c.part === 'ad' ? 'COMMERCIAL BREAK' + (c.backAt ? ' · BACK AT ' + clock(c.backAt) : ' · UP NEXT AT ' + clock(c.end)) : c.start ? 'NOW · ' + clock(c.start) + ' – ' + clock(c.end) : 'NOW';
    $('cb-show').textContent = c.show || 'Nothing on';
    $('cb-ep').textContent = c.episode || '';
    const pct = c.end > c.start ? Math.max(0, Math.min(100, (c.now - c.start) / (c.end - c.start) * 100)) : 0;
    $('cb-fill').style.width = pct + '%';
    const m = $('cb-menu');
    m.hidden = !c.menu;
    if (c.menu) {
      $('cb-menu-t').textContent = c.menu.title;
      const items = c.menu.items || [];
      const fi = Math.max(0, items.findIndex((x) => x.focused));
      const start = Math.max(0, Math.min(fi - 4, items.length - 9));
      $('cb-menu-list').innerHTML = menuHTML(items, start);
      $('cb-menu-note').textContent = c.menu.note || '';
    }
    $('cb-next').hidden = !c.next;
    if (c.next) { $('cb-nt').textContent = 'NEXT · ' + clock(c.next.start); $('cb-ns').textContent = c.next.show; }
  }
  function draw(v) {
    v = v || {};
    last = v;
    const hud = $('hud');
    if (v.cable) { hud.classList.add('hidden'); drawCable(v.cable); return; }
    $('cable').hidden = true;
    hud.classList.toggle('hidden', !v.visible && !v.error);
    if (!v.visible && !v.error) return;
    $('title').textContent = v.title || '';
    $('sub').textContent = v.subtitle || '';
    const dur = v.dur || 0, at = v.target != null ? v.target : (v.pos || 0);
    const pct = dur > 0 ? Math.max(0, Math.min(100, at / dur * 100)) : 0;
    $('fill').style.width = pct + '%';
    $('knob').style.left = pct + '%';
    $('bar').classList.toggle('focus', v.focus === 'bar' && !v.menu && !v.upNext);
    const tip = $('tip');
    tip.textContent = v.target != null ? fmt(v.target) : '';
    tip.classList.toggle('on', v.target != null);
    $('pos').textContent = fmt(at);
    $('left').textContent = dur > 0 ? '−' + fmt(dur - at) : '';
    $('h-a').textContent = v.target != null ? 'Jump here' : v.paused ? 'Play' : 'Pause';
    $('btns').innerHTML = (v.buttons || []).map((b, i) => '<div class="btn' + (v.focus === 'btns' && v.btn === i && !v.menu ? ' focus' : '') + '" data-m="button" data-x="' + i + '">' + esc(b.label) + '</div>').join('');
    if (MOUSE) { $('m-toggle').classList.toggle('paused', !!v.paused); $('m-time').textContent = fmt(at) + (dur > 0 ? ' / ' + fmt(dur) : ''); }
    const c = $('center');
    c.className = 'center' + (v.error ? ' err' : v.buffering && !v.paused ? ' spin' : '');
    c.textContent = v.error ? v.error : v.flash ? v.flash : v.buffering && !v.paused ? 'Loading' : '';
    const m = $('menu');
    m.hidden = !v.menu;
    if (v.menu) {
      $('menu-t').textContent = v.menu.title;
      const items = v.menu.items || [];
      const fi = Math.max(0, items.findIndex((x) => x.focused));
      const start = Math.max(0, Math.min(fi - 4, items.length - 9));
      $('menu-list').innerHTML = menuHTML(items, start);
    }
    const u = $('upnext');
    u.hidden = !v.upNext;
    if (v.upNext) { $('un-k').textContent = 'UP NEXT · IN ' + v.upNext.sec + ' S'; $('un-t').textContent = v.upNext.title; }
  }
  if (window.launcher && window.launcher.on) window.launcher.on('hud', draw);
  if (MOUSE) mouseMode();
  // ---------- the mouse (Couch TV)
  function mouseMode() {
    const api = window.launcher || {};
    const send = (a, x) => { try { if (api.hudAct) api.hudAct(a, x).catch(() => {}); } catch (_) { /* older app core */ } };
    document.body.classList.add('mouse', 'idle');
    // Cable TV's banner and cards were drawn for a TV across the room: a size smaller here, but
    // never too small to read in a small window.
    const fit = () => { document.body.style.setProperty('--cz', String(Math.max(.72, Math.min(1.25, 1080 / Math.max(320, window.innerWidth))))); };
    fit(); window.addEventListener('resize', fit);
    // Moving the mouse brings the controls up (and the pointer back); they go away again by themselves.
    let wokeAt = 0, idleT = null, lastXY = null;
    document.addEventListener('mousemove', (e) => {
      const xy = e.screenX + ',' + e.screenY;
      if (xy === lastXY) return; // (the window moving under a still pointer isn't the mouse)
      lastXY = xy;
      document.body.classList.remove('idle');
      clearTimeout(idleT);
      idleT = setTimeout(() => document.body.classList.add('idle'), 3200);
      const t = Date.now();
      if (t - wokeAt > 350) { wokeAt = t; send('wake'); }
    });
    document.addEventListener('mouseleave', () => { clearTimeout(idleT); document.body.classList.add('idle'); });
    const frac = (e) => { const r = $('bar').getBoundingClientRect(); return r.width > 0 ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0; };
    // The time under the pointer on the bar.
    $('bar').addEventListener('mousemove', (e) => {
      if (!last || !(last.dur > 0)) return;
      const tip = $('tip'), f = frac(e);
      tip.textContent = fmt(f * last.dur); tip.classList.add('on');
      $('knob').style.left = (f * 100) + '%';
    });
    $('bar').addEventListener('mouseleave', () => { if (last) draw(last); });
    document.addEventListener('mousedown', () => send('front'));
    let clickT = null;
    document.addEventListener('click', (e) => {
      if (e.button !== 0) return;
      const el = e.target.closest && e.target.closest('[data-m]');
      if (el) {
        const a = el.dataset.m, x = el.dataset.x;
        send(a, a === 'press' ? x : x != null ? Number(x) : null);
        return;
      }
      if (e.target.closest && e.target.closest('#bar')) { send('seekFrac', frac(e)); return; }
      const inMenu = e.target.closest && e.target.closest('.menu, .upnext');
      if (inMenu) return;
      const menuOpen = !!(last && (last.menu || (last.cable && last.cable.menu)));
      if (menuOpen) { send('menuClose'); return; }
      // The picture itself: a click pauses or plays (a movie), two go full screen.
      clearTimeout(clickT);
      if (e.detail >= 2) { send('fullscreen'); return; }
      clickT = setTimeout(() => { if (last && !last.cable && !last.upNext) send('toggle'); else send('wake'); }, 230);
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  window.__hud = draw; // for tests
})();
