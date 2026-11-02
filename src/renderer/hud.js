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
  function draw(v) {
    v = v || {};
    const hud = $('hud');
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
    $('btns').innerHTML = (v.buttons || []).map((b, i) => '<div class="btn' + (v.focus === 'btns' && v.btn === i && !v.menu ? ' focus' : '') + '">' + esc(b.label) + '</div>').join('');
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
      $('menu-list').innerHTML = items.slice(start, start + 9).map((it) => '<div class="mi' + (it.focused ? ' focus' : '') + '"><span class="ck">' + (it.selected ? '✓' : '') + '</span>' + esc(it.label) + '</div>').join('');
    }
    const u = $('upnext');
    u.hidden = !v.upNext;
    if (v.upNext) { $('un-k').textContent = 'UP NEXT · IN ' + v.upNext.sec + ' S'; $('un-t').textContent = v.upNext.title; }
  }
  if (window.launcher && window.launcher.on) window.launcher.on('hud', draw);
  window.__hud = draw; // for tests
})();
