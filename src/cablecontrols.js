'use strict';
// The controller while Cable TV plays (like a cable box remote):
//   ↑ / RB  channel up · ↓ / LB  channel down · A  what's on (now / next) · Y  captions · B or X  back to the guide
// The screen goes black for a moment between channels, with the channel number up top.

const BIT = { UP: 0x1, DOWN: 0x2, LEFT: 0x4, RIGHT: 0x8, START: 0x10, BACK: 0x20, LB: 0x100, RB: 0x200, A: 0x1000, B: 0x2000, X: 0x4000, Y: 0x8000 };
const STICK = 16000;
const BANNER_MS = 5000, MENU_MS = 12000, FIRST_REPEAT = 450, REPEAT = 260;

function createCableControls({ act, render, now }) {
  now = now || Date.now;
  // part: what's on screen: 'show', 'ad' (commercials) or 'filler' (a break with no commercials
  // found: a card). card: a channel bumper ("We'll be right back", "Now back to …") for a moment.
  const st = { info: null, bannerUntil: 0, blank: true, quiet: false, status: '', brk: false, pos: 0, part: 'show', backAt: 0, card: null, subs: [], menu: null, stripUntil: 0 };
  let prev = 0, held = null;
  // The captions list: Off, then the episode's caption tracks.
  const menuItems = () => [{ id: null, label: 'Off', selected: !st.subs.some((x) => x.selected) }].concat(st.subs.map((x) => ({ id: x.id, label: x.label || x.lang || 'Captions', selected: !!x.selected })));
  function openMenu() {
    const items = menuItems();
    st.menu = { items, index: Math.max(0, items.findIndex((i) => i.selected)), until: now() + MENU_MS };
    st.bannerUntil = 0;
  }

  function view() {
    const t = now(), i = st.info;
    const c = i ? i.channel : null, cur = i ? i.now : null;
    const banner = st.bannerUntil > t || (st.blank && !st.quiet);
    return {
      visible: true,
      cable: {
        number: c ? c.number : '', name: c ? c.name : '', color: c ? c.color : '#fff',
        show: cur ? cur.show : '', episode: cur && cur.video ? epText(cur.video) : '',
        start: cur ? cur.start : 0, end: cur ? cur.end : 0, now: t,
        next: i && i.next && i.next[0] ? { show: i.next[0].show, start: i.next[0].start } : null,
        banner, blank: st.blank, status: st.status, brk: (st.brk || st.part === 'filler') && !st.blank,
        part: st.part, backAt: st.backAt || 0, why: st.why || '',
        card: st.card && st.card.until > t ? { kind: st.card.kind, text: st.card.text } : null,
        strip: st.stripUntil > t, // (Couch TV: the buttons for the mouse, while it is moving)
        menu: st.menu ? { title: 'Captions', note: st.subs.length ? '' : st.part === 'show' ? 'This episode has no captions' : 'Commercials have no captions', items: st.menu.items.map((it, i) => ({ label: it.label, selected: it.selected, focused: i === st.menu.index })) } : null
      }
    };
  }
  const epText = (v) => (v.season ? 'S' + v.season + ' E' + v.episode + (v.title ? ' · ' + v.title : '') : v.title || '');
  const draw = () => render(view());

  function press(b) {
    if (st.menu) {
      const m = st.menu, it = m.items[m.index];
      st.menu = null;
      if (b === 'A' && it) act('sub', it.id);
      return;
    }
    if (b === 'Y') { openMenu(); return; }
    if (b === 'A') { st.bannerUntil = st.bannerUntil > now() ? 0 : now() + BANNER_MS; return; }
    if (b === 'B' || b === 'X') { act('exit'); return; }
    if (b === 'RB') { act('chan', 1); return; }
    if (b === 'LB') { act('chan', -1); return; }
    if (b === 'START') { st.bannerUntil = now() + BANNER_MS; }
  }
  function input(mask, lx, ly) {
    const t = now();
    let dir = null;
    if (mask & BIT.UP || ly > STICK) dir = 'up';
    else if (mask & BIT.DOWN || ly < -STICK) dir = 'down';
    else if (mask & BIT.LEFT || lx < -STICK || mask & BIT.RIGHT || lx > STICK) dir = 'side';
    let changed = false;
    for (const name of ['A', 'B', 'X', 'Y', 'LB', 'RB', 'START']) {
      const bit = BIT[name];
      if ((mask & bit) && !(prev & bit)) { press(name); changed = true; }
    }
    prev = mask;
    if (dir) {
      const fire = () => {
        if (st.menu) { const m = st.menu; m.until = now() + MENU_MS; if (dir === 'up') m.index = Math.max(0, m.index - 1); else if (dir === 'down') m.index = Math.min(m.items.length - 1, m.index + 1); return; }
        if (dir === 'up') act('chan', 1); else if (dir === 'down') act('chan', -1); else st.bannerUntil = now() + BANNER_MS;
      };
      if (!held || held.dir !== dir) { held = { dir, next: t + FIRST_REPEAT }; fire(); changed = true; }
      else if (t >= held.next && dir !== 'side') { held.next = t + REPEAT; fire(); changed = true; }
    } else held = null;
    if (changed) draw();
  }
  // Couch TV: the mouse (clicks on what view() draws) and the keyboard (a key at a time).
  const STRIP_MS = 3500;
  function mouse(a, x) {
    st.stripUntil = now() + STRIP_MS;
    if (a === 'wake') { if (!lastStrip) draw(); return; }
    if (a === 'menuPick') { const m = st.menu, it = m && m.items[x | 0]; st.menu = null; if (it) act('sub', it.id); }
    else if (a === 'menuClose') st.menu = null;
    else if (st.menu) st.menu = null;
    else if (a === 'chan') { act('chan', x > 0 ? 1 : -1); }
    else if (a === 'info') press('A');
    else if (a === 'captions') press('Y');
    else if (a === 'exit') { act('exit'); return; }
    draw();
  }
  function key(name, repeat) {
    if (st.menu && (name === 'UP' || name === 'DOWN')) { const m = st.menu; m.until = now() + MENU_MS; m.index = Math.max(0, Math.min(m.items.length - 1, m.index + (name === 'UP' ? -1 : 1))); draw(); return; }
    if (repeat) return; // (a held key doesn't race through the channels)
    if (name === 'UP') act('chan', 1);
    else if (name === 'DOWN') act('chan', -1);
    else if (name === 'LEFT' || name === 'RIGHT') st.bannerUntil = now() + BANNER_MS;
    else if (name === 'TOGGLE') press('A');
    else if (['A', 'B', 'X', 'Y', 'LB', 'RB', 'START'].includes(name)) press(name);
    else return;
    draw();
  }
  let lastBanner = null, lastMin = null, lastCard = null, lastStrip = false;
  function tick() {
    if (st.menu && now() > st.menu.until) { st.menu = null; draw(); }
    { const on = st.stripUntil > now(); if (on !== lastStrip) { lastStrip = on; draw(); } }
    const v = view().cable;
    const m = Math.floor(now() / (v.brk ? 1000 : 30000));
    const card = v.card ? v.card.kind + v.card.text : null;
    if (v.banner !== lastBanner || card !== lastCard || ((v.banner || v.brk) && m !== lastMin)) { lastBanner = v.banner; lastCard = card; lastMin = m; draw(); }
  }

  return {
    input, mouse, key, tick, view, BIT,
    // A channel was picked (or the program changed): show the banner, black until it plays.
    tuning(info) { st.menu = null; st.info = info; st.blank = true; st.quiet = false; st.brk = false; st.status = ''; st.bannerUntil = now() + BANNER_MS; draw(); },
    // Between the show and the commercials: just black for a moment, nothing on it.
    cut() { st.blank = true; st.quiet = true; st.brk = false; st.status = ''; st.bannerUntil = 0; draw(); },
    // The program is playing now.
    playing(info) { if (info) st.info = info; st.blank = false; st.quiet = false; st.brk = false; st.status = ''; draw(); },
    // Said on the black screen (searching, nothing found…).
    status(text) { st.status = String(text || ''); draw(); },
    // The episode ended before its time slot did: "coming up next" until the next one.
    onBreak(info) { if (info) st.info = info; st.brk = true; draw(); },
    // Show or commercials now (backAt: when the show comes back, for the banner).
    part(kind, backAt, why) { st.part = kind; st.backAt = backAt || 0; st.why = kind === 'filler' ? String(why || '') : ''; st.brk = false; if (kind === 'filler') { st.blank = false; st.quiet = false; } draw(); },
    // A channel bumper for a moment, covering the switch between show and commercials.
    card(kind, text, ms) { st.card = { kind, text: String(text || ''), until: now() + (ms || 3000) }; draw(); },
    get state() { return st; },
    // (The movie player's calls, so the rest of the code can treat both alike.)
    setInfo() {}, setTime(pos) { st.pos = pos; }, setPaused() {}, setBuffering() {}, showUpNext() {},
    // The episode's caption tracks (the open list follows them).
    setTracks(t) {
      st.subs = (t && t.subs) || [];
      if (st.menu) { const items = menuItems(); st.menu.items = items; st.menu.index = Math.min(st.menu.index, items.length - 1); draw(); }
    }
  };
}

module.exports = { createCableControls };
