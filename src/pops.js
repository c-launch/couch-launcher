'use strict';
// The launcher's own pop-ups, above everything else on the screen (games too):
//   - notifications, top right (instead of Windows notifications)
//   - your Discord call, top left: who's in it, lit up while they talk
// Two small windows that can't be clicked or focused, so they never take the screen, the mouse
// or the controller from a game. Each is only on screen while it has something to show.
// (A game in exclusive full screen draws over every window, these included.)

const SHOW_MS = 6500, LONG_MS = 9000, MAX_SHOWN = 4, MAX_WAITING = 12, HIDE_AFTER = 450, MAX_PEOPLE = 8;
const SPOTS = ['top-left', 'bottom-left', 'bottom-right', 'middle-left'];

// o: { BrowserWindow, file, preload, display() -> { bounds }, mac, now, sound() -> bool, callSpot() -> name }
function createPops(o) {
  const now = o.now || Date.now;
  const wins = { toasts: null, voice: null };
  const ready = { toasts: false, voice: false };
  const shown = []; // toasts on screen: { id, title, body, icon, from, until }
  const waiting = [];
  let nextId = 1, timer = null, hideTimer = null, call = null, closed = false;

  // Where each window sits on the chosen display (sizes follow the display, like the launcher).
  function boundsOf(kind) {
    const b = o.display().bounds;
    const rem = Math.min(b.width / 160, b.height / 90);
    const w = Math.round((kind === 'toasts' ? 50 : 34) * rem), h = Math.round((kind === 'toasts' ? 58 : 62) * rem);
    const width = Math.min(w, b.width), height = Math.min(h, b.height);
    if (kind === 'toasts') return { x: b.x + b.width - w, y: b.y, width, height };
    // The Discord call: where the chosen spot is (top left unless the setting says otherwise).
    const spot = spotOf();
    const x = spot.endsWith('right') ? b.x + b.width - w : b.x;
    const y = spot.startsWith('bottom') ? b.y + b.height - h : spot.startsWith('middle') ? b.y + Math.round((b.height - h) / 2) : b.y;
    return { x, y, width, height };
  }
  function spotOf() {
    let s = null;
    try { s = o.callSpot ? o.callSpot() : null; } catch (_) { s = null; }
    return SPOTS.includes(s) ? s : 'top-left';
  }
  function windowFor(kind) {
    let w = wins[kind];
    if (w && !w.isDestroyed()) return w;
    ready[kind] = false;
    w = wins[kind] = new o.BrowserWindow(Object.assign(boundsOf(kind), {
      transparent: true, frame: false, show: false, focusable: false, skipTaskbar: true, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false, hasShadow: false, backgroundColor: '#00000000',
      ...(o.mac ? { type: 'panel' } : {}), // Mac: a panel is what can float over another app's full screen
      webPreferences: { preload: o.preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' }
    }));
    w.setIgnoreMouseEvents(true);
    w.setAlwaysOnTop(true, 'screen-saver');
    if (o.mac) { try { w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) { /* older macOS */ } }
    w.loadFile(o.file, { query: { mode: kind } });
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    w.webContents.on('did-finish-load', () => { if (wins[kind] === w) { ready[kind] = true; send(kind); } });
    w.on('closed', () => { if (wins[kind] === w) { wins[kind] = null; ready[kind] = false; } });
    // A page that crashed is thrown away; the next pop-up makes a new one.
    w.webContents.on('render-process-gone', () => { try { if (!w.isDestroyed()) w.destroy(); } catch (_) { /* gone */ } });
    return w;
  }
  // The whole picture every time, so a page that loaded late or missed one is still right.
  function send(kind) {
    const w = wins[kind];
    if (!w || w.isDestroyed() || !ready[kind]) return false;
    w.webContents.send('pops', kind === 'toasts'
      ? { toasts: shown.map((t) => ({ id: t.id, title: t.title, body: t.body, icon: t.icon, from: t.from, sound: t.sound })) }
      : { voice: call, spot: spotOf() });
    if (kind === 'toasts') for (const s of shown) s.sound = false; // the sound plays once, when it first shows
    return true;
  }
  function reveal(kind) {
    const w = windowFor(kind);
    try { w.setBounds(boundsOf(kind)); } catch (_) { /* keeps its place */ }
    if (!w.isVisible()) { w.showInactive(); }
    try { w.setAlwaysOnTop(true, 'screen-saver'); w.moveTop(); } catch (_) { /* still on top */ }
  }
  function conceal(kind) { const w = wins[kind]; if (w && !w.isDestroyed() && w.isVisible()) w.hide(); }

  // ---- notifications
  function pump() {
    clearTimeout(timer); timer = null;
    const t = now();
    for (let i = shown.length - 1; i >= 0; i--) if (shown[i].until <= t) shown.splice(i, 1);
    while (shown.length < MAX_SHOWN && waiting.length) {
      const n = waiting.shift();
      n.until = t + (n.body.length > 90 ? LONG_MS : SHOW_MS);
      shown.push(n);
    }
    if (shown.length) {
      clearTimeout(hideTimer); hideTimer = null;
      reveal('toasts');
      send('toasts');
      timer = setTimeout(pump, Math.max(50, Math.min(...shown.map((s) => s.until)) - t));
    } else {
      send('toasts'); // the page plays the last one out
      if (!hideTimer) hideTimer = setTimeout(() => { hideTimer = null; if (!shown.length) conceal('toasts'); }, HIDE_AFTER);
    }
  }
  const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
  function toast(t) {
    if (closed) return false;
    const title = clean(t && t.title, 90), body = clean(t && t.body, 240);
    if (!title && !body) return false;
    // The same one twice in a row (two checks noticing the same thing) shows once.
    const same = (x) => x.title === title && x.body === body;
    if (shown.some(same) || waiting.some(same)) return false;
    const icon = /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\//.test(String((t && t.icon) || '')) ? String(t.icon) : null;
    if (waiting.length >= MAX_WAITING) waiting.shift();
    waiting.push({ id: nextId++, title, body, icon, from: clean(t && t.from, 30), sound: !o.sound || !!o.sound(), until: 0 });
    pump();
    return true;
  }

  // ---- the Discord call. v: null | { name, people: [{ id, name, pic, muted, deaf, speaking }] }
  function voice(v, talkingOnly) {
    if (closed) return;
    if (!v || !Array.isArray(v.people)) { call = null; send('voice'); conceal('voice'); return; }
    const all = v.people.filter((p) => p && p.id);
    const list = (talkingOnly ? all.filter((p) => p.speaking) : all);
    call = {
      name: clean(v.name, 60), talkingOnly: !!talkingOnly,
      people: list.slice(0, MAX_PEOPLE).map((p) => ({ id: String(p.id), name: clean(p.name, 40) || 'Someone', pic: /^https:\/\/cdn\.discordapp\.com\//.test(String(p.pic || '')) ? String(p.pic) : null, muted: !!p.muted, deaf: !!p.deaf, speaking: !!p.speaking })),
      more: Math.max(0, list.length - MAX_PEOPLE)
    };
    reveal('voice');
    send('voice');
  }

  return {
    toast, voice,
    // The display changed (or another one was chosen): move to it.
    place() { for (const k of ['toasts', 'voice']) { const w = wins[k]; if (w && !w.isDestroyed()) { try { w.setBounds(boundsOf(k)); } catch (_) { /* keeps its place */ } } } send('voice'); },
    close() { closed = true; clearTimeout(timer); clearTimeout(hideTimer); for (const k of ['toasts', 'voice']) { const w = wins[k]; if (w && !w.isDestroyed()) w.destroy(); wins[k] = null; } },
    get state() { return { shown: shown.map((s) => s.title), waiting: waiting.length, call }; },
    isOurs: (w) => w === wins.toasts || w === wins.voice
  };
}

module.exports = { createPops };
