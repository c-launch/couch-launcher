'use strict';
/* The pop-ups page. The app core sends the whole picture each time: { toasts: [...] } or
   { voice: {...} | null }. Nothing here can be clicked. */
(function () {
  const $ = (id) => document.getElementById(id);
  const mode = new URLSearchParams(location.search).get('mode') === 'voice' ? 'voice' : 'toasts';
  document.documentElement.classList.add(mode);
  const safePic = (u) => (/^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\/[\w./?=&%-]+$/.test(String(u || '')) ? String(u) : null);

  // ---- notifications: new ones slide in, gone ones slide out
  const els = new Map();
  let audio = null;
  function chime() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const t = audio.currentTime;
      [[660, 0], [880, 0.09]].forEach(([f, at]) => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + at); g.gain.exponentialRampToValueAtTime(0.07, t + at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.32);
        o.connect(g); g.connect(audio.destination); o.start(t + at); o.stop(t + at + 0.36);
      });
    } catch (_) { /* no sound device */ }
  }
  function drawToasts(list) {
    const box = $('toasts'), ids = new Set(list.map((t) => t.id));
    for (const [id, el] of Array.from(els)) {
      if (ids.has(id) || el.classList.contains('out')) continue;
      el.classList.add('out');
      setTimeout(() => { el.remove(); els.delete(id); }, 280);
    }
    let sound = false;
    for (const t of list) {
      if (els.has(t.id)) continue;
      const el = document.createElement('div'); el.className = 'pop';
      const ic = document.createElement('div'); ic.className = 'ic';
      const pic = safePic(t.icon);
      if (pic) { ic.classList.add('round'); ic.style.backgroundImage = 'url("' + pic + '")'; }
      const tx = document.createElement('div'); tx.className = 'tx';
      if (t.from) { const f = document.createElement('div'); f.className = 'from'; f.textContent = t.from; tx.appendChild(f); }
      const h = document.createElement('div'); h.className = 't'; h.textContent = t.title || '';
      const b = document.createElement('div'); b.className = 'b'; b.textContent = t.body || '';
      tx.appendChild(h); tx.appendChild(b); el.appendChild(ic); el.appendChild(tx);
      box.appendChild(el); els.set(t.id, el);
      if (t.sound) sound = true;
    }
    if (sound) chime();
  }

  // ---- the Discord call
  function drawVoice(v) {
    const box = $('voice');
    if (!v || !v.people) { box.hidden = true; box.textContent = ''; return; }
    box.hidden = false; box.textContent = '';
    for (const p of v.people) {
      const row = document.createElement('div'); row.className = 'who' + (p.speaking ? ' speaking' : '');
      const av = document.createElement('div'); av.className = 'av';
      const pic = safePic(p.pic);
      if (pic) av.style.backgroundImage = 'url("' + pic + '")'; else av.textContent = String(p.name || '?').trim().slice(0, 1).toUpperCase();
      const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = p.name || 'Someone';
      row.appendChild(av); row.appendChild(nm);
      if (p.deaf || p.muted) { const st = document.createElement('div'); st.className = 'st'; st.textContent = p.deaf ? 'deafened' : 'muted'; row.appendChild(st); }
      box.appendChild(row);
    }
    if (v.more) { const m = document.createElement('div'); m.className = 'who more'; m.textContent = '+' + v.more + ' more'; box.appendChild(m); }
  }

  // Where the call sits (top-left unless the setting says otherwise); the page only takes a known name.
  const SPOTS = ['top-left', 'bottom-left', 'bottom-right', 'middle-left'];
  function setSpot(s) { document.documentElement.dataset.spot = SPOTS.includes(s) ? s : 'top-left'; }
  function draw(msg) {
    if (!msg) return;
    if (mode === 'voice' && 'spot' in msg) setSpot(msg.spot);
    if (mode === 'toasts' && Array.isArray(msg.toasts)) drawToasts(msg.toasts);
    if (mode === 'voice' && 'voice' in msg) drawVoice(msg.voice);
  }
  if (window.launcher && window.launcher.on) window.launcher.on('pops', draw);
  window.__pops = draw; // for tests
})();
