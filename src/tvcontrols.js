'use strict';
// The controller while a movie or episode plays (mpv has the screen, so the launcher reads the
// controller itself and draws its controls in a see-through window on top).
//
//   Playing:   A pause (controls appear) · ←/→ scrub · LB −10 s · RB +30 s · Y subtitles · X audio · B back
//   Controls:  ←/→ scrub (hold to go faster), A jumps there / play-pause · ↓ buttons row · B hide / back
//   Menus:     ↑/↓ choose · A pick · B close
//   Up next:   A play now · B back (plays by itself when the countdown ends)
//
// Buttons come in as XInput bits (PlayStation pads are translated the same way).

const BIT = { UP: 0x1, DOWN: 0x2, LEFT: 0x4, RIGHT: 0x8, START: 0x10, BACK: 0x20, LB: 0x100, RB: 0x200, A: 0x1000, B: 0x2000, X: 0x4000, Y: 0x8000 };
const STICK = 16000;
const HIDE_MS = 4000, COMMIT_MS = 700, FIRST_REPEAT = 380, REPEAT = 140;

function createTvControls({ act, render, now }) {
  now = now || Date.now;
  const st = {
    info: { title: '', subtitle: '', isSeries: false, episodes: [] },
    pos: 0, dur: 0, paused: false, buffering: true,
    hud: true, focus: 'bar', btn: 0, menu: null, target: null, upNext: null,
    tracks: { subs: [], audio: [] }, lastInput: now(), flash: null
  };
  let prev = 0, held = null; // held: { dir, since, next }

  const buttons = () => {
    const sub = st.tracks.subs.find((t) => t.selected), au = st.tracks.audio.find((t) => t.selected);
    const b = [{ id: 'subs', label: 'Subtitles: ' + (sub ? short(sub.label) : 'Off') }, { id: 'audio', label: 'Audio: ' + (au ? short(au.label) : 'Default') }];
    if (st.info.isSeries && st.info.episodes.length) b.push({ id: 'eps', label: 'Episodes' });
    return b;
  };
  const short = (s) => String(s).split(' · ').slice(0, 2).join(' ').slice(0, 28);
  const clampT = (t) => Math.max(0, Math.min(st.dur > 0 ? st.dur - 2 : t, t));

  function view() {
    const t = now();
    return {
      visible: st.hud || !!st.menu || !!st.upNext || st.target != null || (st.flash && st.flash.until > t),
      paused: st.paused, buffering: st.buffering, pos: st.pos, dur: st.dur, target: st.target,
      title: st.info.title, subtitle: st.info.subtitle,
      focus: st.focus, btn: st.btn, buttons: buttons(),
      menu: st.menu ? { title: st.menu.title, items: st.menu.items.map((it, i) => ({ label: it.label, selected: !!it.selected, focused: i === st.menu.index })) } : null,
      upNext: st.upNext ? { title: st.upNext.title, sec: Math.max(0, Math.ceil((st.upNext.until - t) / 1000)) } : null,
      flash: st.flash && st.flash.until > t ? st.flash.text : null
    };
  }
  const draw = () => render(view());
  const show = () => { st.hud = true; st.lastInput = now(); };
  const flash = (text) => { st.flash = { text, until: now() + 1200 }; };

  function openMenu(kind) {
    let items, title;
    if (kind === 'subs') { title = 'Subtitles'; items = [{ id: null, label: 'Off', selected: !st.tracks.subs.some((t) => t.selected) }].concat(st.tracks.subs.map((t) => ({ id: t.id, label: t.label, selected: t.selected }))); }
    else if (kind === 'audio') { title = 'Audio'; items = st.tracks.audio.map((t) => ({ id: t.id, label: t.label, selected: t.selected })); }
    else { title = 'Episodes'; items = st.info.episodes.map((e) => ({ id: e.id, label: e.label, selected: !!e.current })); }
    if (!items.length) { flash(kind === 'audio' ? 'Only one audio track' : 'Nothing to choose'); return; }
    const sel = Math.max(0, items.findIndex((i) => i.selected));
    st.menu = { kind, title, items, index: sel };
  }
  function pick() {
    const m = st.menu, it = m.items[m.index];
    st.menu = null;
    if (!it) return;
    if (m.kind === 'subs') act('sub', it.id);
    else if (m.kind === 'audio') act('audio', it.id);
    else if (!it.selected) act('episode', it.id);
  }
  function scrub(dir, step) {
    show();
    st.focus = 'bar';
    const base = st.target != null ? st.target : st.pos;
    st.target = clampT(base + (dir === 'right' ? step : -step));
    st.commitAt = now() + COMMIT_MS;
  }
  function commit() {
    if (st.target == null) return;
    act('seekTo', st.target);
    st.pos = st.target; st.target = null;
  }

  function press(b) {
    st.lastInput = now();
    if (st.upNext) {
      if (b === 'A') { st.upNext = null; act('next'); }
      else if (b === 'B') { st.upNext = null; act('exit'); }
      return;
    }
    if (st.menu) {
      const m = st.menu;
      if (b === 'UP') m.index = Math.max(0, m.index - 1);
      else if (b === 'DOWN') m.index = Math.min(m.items.length - 1, m.index + 1);
      else if (b === 'A') pick();
      else if (b === 'B') st.menu = null;
      return;
    }
    if (b === 'Y') { show(); openMenu('subs'); return; }
    if (b === 'X') { show(); openMenu('audio'); return; }
    if (b === 'LB' || b === 'RB') { commit(); act('seekBy', b === 'RB' ? 30 : -10); flash(b === 'RB' ? '+30 s' : '−10 s'); show(); return; }
    if (b === 'START') { act('toggle'); show(); return; }
    if (!st.hud) {
      if (b === 'A') { act('toggle'); show(); return; }
      if (b === 'B') { act('exit'); return; }
      if (b === 'UP' || b === 'DOWN') { show(); st.focus = 'bar'; return; }
      return;
    }
    // Controls showing
    if (b === 'B') {
      if (st.target != null) { st.target = null; return; }
      if (st.paused) { act('exit'); return; }
      st.hud = false; return;
    }
    if (st.focus === 'bar') {
      if (b === 'A') { if (st.target != null) commit(); else act('toggle'); return; }
      if (b === 'DOWN') { commit(); st.focus = 'btns'; st.btn = Math.min(st.btn, buttons().length - 1); return; }
      return;
    }
    // Buttons row
    const list = buttons();
    if (b === 'UP') { st.focus = 'bar'; return; }
    if (b === 'A') { const it = list[st.btn]; if (it) openMenu(it.id); return; }
  }
  function moveDir(dir, first, heldFor) {
    st.lastInput = now();
    if (st.upNext) return;
    if (st.menu) { if (first || dir === 'up' || dir === 'down') press(dir.toUpperCase()); return; }
    if (dir === 'left' || dir === 'right') {
      if (st.hud && st.focus === 'btns') {
        if (!first && heldFor < FIRST_REPEAT) return;
        const n = buttons().length;
        st.btn = Math.max(0, Math.min(n - 1, st.btn + (dir === 'right' ? 1 : -1)));
        return;
      }
      // Scrubbing speeds up the longer you hold.
      scrub(dir, heldFor > 5000 ? 60 : heldFor > 2000 ? 30 : 10);
      return;
    }
    if (first) press(dir.toUpperCase());
  }

  // Called every controller poll with the buttons held right now.
  function input(mask, lx, ly) {
    const t = now();
    let dir = null;
    if (mask & BIT.UP || ly > STICK) dir = 'up';
    else if (mask & BIT.DOWN || ly < -STICK) dir = 'down';
    else if (mask & BIT.LEFT || lx < -STICK) dir = 'left';
    else if (mask & BIT.RIGHT || lx > STICK) dir = 'right';
    let changed = false;
    for (const name of ['A', 'B', 'X', 'Y', 'LB', 'RB', 'START']) {
      const bit = BIT[name];
      if ((mask & bit) && !(prev & bit)) { press(name); changed = true; }
    }
    prev = mask;
    if (dir) {
      if (!held || held.dir !== dir) { held = { dir, since: t, next: t + FIRST_REPEAT }; moveDir(dir, true, 0); changed = true; }
      else if (t >= held.next) { held.next = t + REPEAT; moveDir(dir, false, t - held.since); changed = true; }
    } else held = null;
    if (tick() || changed) draw();
  }
  // Timers: jump after scrubbing stops, hide the controls, the Up Next countdown.
  let lastSec = null;
  function tick() {
    const t = now();
    let changed = false;
    if (st.target != null && t >= st.commitAt && !held) { commit(); changed = true; }
    if (st.hud && !st.paused && !st.menu && st.target == null && !st.upNext && t - st.lastInput > HIDE_MS) { st.hud = false; changed = true; }
    if (st.flash && st.flash.until <= t) { st.flash = null; changed = true; }
    if (st.upNext) {
      const sec = Math.ceil((st.upNext.until - t) / 1000);
      if (sec !== lastSec) { lastSec = sec; changed = true; }
      if (t >= st.upNext.until) { st.upNext = null; act('next'); changed = true; }
    }
    return changed;
  }

  // Couch TV: the controls worked with the mouse (clicks on what view() draws)...
  function mouse(a, x) {
    st.lastInput = now();
    if (a === 'wake') { if (!st.hud) { st.hud = true; draw(); } return; }
    if (st.upNext) { if (a === 'press' && (x === 'A' || x === 'B')) press(x); draw(); return; }
    if (a === 'menuPick') { if (st.menu && st.menu.items[x | 0]) { st.menu.index = x | 0; pick(); } }
    else if (a === 'menuClose') st.menu = null;
    else if (st.menu) st.menu = null; // a click anywhere else closes the list first
    else if (a === 'toggle') { st.target = null; act('toggle'); show(); }
    else if (a === 'seekFrac') { if (st.dur > 0) { const t = clampT(Math.max(0, Math.min(1, Number(x) || 0)) * st.dur); st.target = null; act('seekTo', t); st.pos = t; } show(); st.focus = 'bar'; }
    else if (a === 'seekBy') { commit(); act('seekBy', Number(x) || 0); flash((x > 0 ? '+' : '−') + Math.abs(Number(x) || 0) + ' s'); show(); }
    else if (a === 'button') { const it = buttons()[x | 0]; show(); if (it) openMenu(it.id); }
    else if (a === 'exit') { act('exit'); return; }
    draw();
  }
  // ...and with the keyboard (a key at a time: name is a button or a direction; repeat: the key
  // is being held, for heldMs).
  function key(name, repeat, heldMs) {
    const dir = { UP: 'up', DOWN: 'down', LEFT: 'left', RIGHT: 'right' }[name];
    if (dir) moveDir(dir, !repeat, repeat ? Math.max(FIRST_REPEAT, Number(heldMs) || 0) : 0);
    else if (name === 'TOGGLE') { if (st.menu || st.upNext) press('A'); else { st.lastInput = now(); st.target = null; act('toggle'); show(); } }
    else if (!repeat && ['A', 'B', 'X', 'Y', 'LB', 'RB', 'START'].includes(name)) press(name);
    else return;
    // (A direction let go: where it was scrubbed to is jumped to a moment later, as with a pad.)
    tick(); draw();
  }

  return {
    input, mouse, key, tick: () => { if (tick()) draw(); }, view, BIT,
    setInfo(info) { st.info = Object.assign({ title: '', subtitle: '', isSeries: false, episodes: [] }, info); st.btn = 0; st.upNext = null; st.menu = null; st.target = null; st.buffering = true; show(); draw(); },
    setTime(pos, dur) { st.pos = pos; if (dur > 0) st.dur = dur; },
    setPaused(p) { st.paused = !!p; if (p) show(); else st.lastInput = now(); draw(); },
    setBuffering(b) { st.buffering = !!b; draw(); },
    setTracks(t) { st.tracks = { subs: (t && t.subs) || [], audio: (t && t.audio) || [] }; draw(); },
    showUpNext(title, secs) { st.menu = null; st.target = null; st.upNext = { title, until: now() + (secs || 10) * 1000 }; lastSec = null; draw(); },
    get state() { return st; }
  };
}

module.exports = { createTvControls, BIT };
