'use strict';
// The controller while Cable TV plays (like a cable box remote):
//   ↑ / RB  channel up · ↓ / LB  channel down · A  what's on (now / next) · B or X  back to the guide
// The screen goes black for a moment between channels, with the channel number up top.

const BIT = { UP: 0x1, DOWN: 0x2, LEFT: 0x4, RIGHT: 0x8, START: 0x10, BACK: 0x20, LB: 0x100, RB: 0x200, A: 0x1000, B: 0x2000, X: 0x4000, Y: 0x8000 };
const STICK = 16000;
const BANNER_MS = 5000, FIRST_REPEAT = 450, REPEAT = 260;

function createCableControls({ act, render, now }) {
  now = now || Date.now;
  // part: what's on screen: 'show', 'ad' (commercials) or 'filler' (a break with no commercials
  // found: a card). card: a channel bumper ("We'll be right back", "Now back to …") for a moment.
  const st = { info: null, bannerUntil: 0, blank: true, status: '', brk: false, pos: 0, part: 'show', backAt: 0, card: null };
  let prev = 0, held = null;

  function view() {
    const t = now(), i = st.info;
    const c = i ? i.channel : null, cur = i ? i.now : null;
    const banner = st.bannerUntil > t || st.blank;
    return {
      visible: true,
      cable: {
        number: c ? c.number : '', name: c ? c.name : '', color: c ? c.color : '#fff',
        show: cur ? cur.show : '', episode: cur && cur.video ? epText(cur.video) : '',
        start: cur ? cur.start : 0, end: cur ? cur.end : 0, now: t,
        next: i && i.next && i.next[0] ? { show: i.next[0].show, start: i.next[0].start } : null,
        banner, blank: st.blank, status: st.status, brk: (st.brk || st.part === 'filler') && !st.blank,
        part: st.part, backAt: st.backAt || 0,
        card: st.card && st.card.until > t ? { kind: st.card.kind, text: st.card.text } : null
      }
    };
  }
  const epText = (v) => (v.season ? 'S' + v.season + ' E' + v.episode + (v.title ? ' · ' + v.title : '') : v.title || '');
  const draw = () => render(view());

  function press(b) {
    if (b === 'A') { st.bannerUntil = st.bannerUntil > now() ? 0 : now() + BANNER_MS; return; }
    if (b === 'B' || b === 'X') { act('exit'); return; }
    if (b === 'RB') { act('chan', 1); return; }
    if (b === 'LB') { act('chan', -1); return; }
    if (b === 'Y' || b === 'START') { st.bannerUntil = now() + BANNER_MS; }
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
      const fire = () => { if (dir === 'up') act('chan', 1); else if (dir === 'down') act('chan', -1); else st.bannerUntil = now() + BANNER_MS; };
      if (!held || held.dir !== dir) { held = { dir, next: t + FIRST_REPEAT }; fire(); changed = true; }
      else if (t >= held.next && dir !== 'side') { held.next = t + REPEAT; fire(); changed = true; }
    } else held = null;
    if (changed) draw();
  }
  let lastBanner = null, lastMin = null, lastCard = null;
  function tick() {
    const v = view().cable;
    const m = Math.floor(now() / (v.brk ? 1000 : 30000));
    const card = v.card ? v.card.kind + v.card.text : null;
    if (v.banner !== lastBanner || card !== lastCard || ((v.banner || v.brk) && m !== lastMin)) { lastBanner = v.banner; lastCard = card; lastMin = m; draw(); }
  }

  return {
    input, tick, view, BIT,
    // A channel was picked (or the program changed): show the banner, black until it plays.
    tuning(info) { st.info = info; st.blank = true; st.brk = false; st.status = ''; st.bannerUntil = now() + BANNER_MS; draw(); },
    // The program is playing now.
    playing(info) { if (info) st.info = info; st.blank = false; st.brk = false; st.status = ''; draw(); },
    // Said on the black screen (searching, nothing found…).
    status(text) { st.status = String(text || ''); draw(); },
    // The episode ended before its time slot did: "coming up next" until the next one.
    onBreak(info) { if (info) st.info = info; st.brk = true; draw(); },
    // Show or commercials now (backAt: when the show comes back, for the banner).
    part(kind, backAt) { st.part = kind; st.backAt = backAt || 0; st.brk = false; if (kind === 'filler') st.blank = false; draw(); },
    // A channel bumper for a moment, covering the switch between show and commercials.
    card(kind, text, ms) { st.card = { kind, text: String(text || ''), until: now() + (ms || 3000) }; draw(); },
    get state() { return st; },
    // (The movie player's calls, so the rest of the code can treat both alike.)
    setInfo() {}, setTime(pos) { st.pos = pos; }, setPaused() {}, setBuffering() {}, setTracks() {}, showUpNext() {}
  };
}

module.exports = { createCableControls };
