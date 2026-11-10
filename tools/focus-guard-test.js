// Run before every publish (publish.sh): who has the screen while a game runs. The GTA case
// (the game takes the screen back from the guide while paused) plus a storm of random focus
// changes: a frozen game must never be left in front.
const assert = require('assert');
const { createFocusGuard } = require('../src/focusguard.js');
const SELF = 100, GAME = 200, OTHER = 300, OV = 11, WIN = 12, GW = 21, OW = 31;
function world(o) {
  const w = Object.assign({ t: 0, fg: { hwnd: GW, pid: GAME }, game: { pids: [GAME], hwnds: [GW], pausable: true }, overlay: null, shown: true,
    paused: new Set(), log: [], pauseMs: 1000, pauseWorks: true }, o || {});
  w.guard = createFocusGuard({
    now: () => w.t, self: SELF, foreground: () => w.fg, game: () => w.game, overlay: () => w.overlay, launcherShown: () => w.shown,
    isPaused: () => w.paused.size > 0, isPausedPid: (p) => w.paused.has(p),
    pause: () => { w.log.push('pause@' + w.t); const at = w.t + w.pauseMs; return new Promise((res) => { w.pending = { at, res }; }); },
    resume: () => { if (w.paused.size) w.log.push('resume@' + w.t); w.paused.clear(); },
    stepAside: () => { w.log.push('aside@' + w.t); w.overlay = null; w.fg = { hwnd: WIN, pid: SELF }; },
    dropOverlay: () => { w.log.push('drop@' + w.t); w.overlay = null; },
    focusGame: (h) => { w.log.push('focus@' + w.t); if (w.focusWorks) w.fg = { hwnd: h, pid: GAME }; },
    minimizeLauncher: () => { w.log.push('min@' + w.t); w.fg = { hwnd: GW, pid: GAME }; w.shown = false; }
  });
  // advances the clock in 150 ms ticks, finishing a pause that is being set up when its time comes
  w.run = async (ms) => {
    const end = w.t + ms;
    while (w.t < end) {
      w.t += 150;
      if (w.pending && w.t >= w.pending.at) { const p = w.pending; w.pending = null; if (w.pauseWorks && w.guard.wantsPause()) w.paused.add(GAME); p.res(); await null; await null; }
      w.guard.tick();
      // the invariant: a frozen game is never in front for more than one tick
      if (w.paused.has(w.fg && w.fg.pid)) { w.bad = (w.bad || 0) + 1; assert.ok(w.bad <= 1, 'frozen game left in front at ' + w.t); } else w.bad = 0;
    }
  };
  w.openGuide = (takes) => { w.overlay = { hwnd: OV, openedAt: w.t }; w.guard.cancelExpect(); if (takes !== false) w.fg = { hwnd: OV, pid: SELF }; };
  return w;
}
const has = (w, re) => w.log.some((l) => re.test(l));
(async () => {
  // A. the usual: guide opens and gets the screen -> game paused; closing hands it back, no re-pause
  let w = world();
  await w.run(600); assert.deepStrictEqual(w.log, [], 'nothing while the game is in front');
  w.openGuide(); await w.run(2000);
  assert.ok(has(w, /^pause@/) && w.paused.has(GAME) && !has(w, /aside|drop/), 'A paused: ' + w.log);
  assert.strictEqual(w.log.filter((l) => /^pause/.test(l)).length, 1, 'one pause only');
  w.overlay = null; w.paused.clear(); w.fg = { hwnd: GW, pid: GAME }; w.guard.expectGame(GW); w.log.length = 0;
  await w.run(3000); assert.deepStrictEqual(w.log, [], 'A back in the game: left alone');

  // B. GTA: gives the guide the screen, then takes it back seconds later while frozen
  w = world(); w.openGuide(); await w.run(2500); assert.ok(w.paused.has(GAME));
  w.fg = { hwnd: GW, pid: GAME }; w.log.length = 0;
  await w.run(150); assert.ok(has(w, /^resume@/) && !w.paused.size, 'B woken at once: ' + w.log);
  await w.run(600); assert.ok(has(w, /^aside@/) && !w.overlay, 'B then steps aside: ' + w.log);
  await w.run(2000); assert.ok(w.paused.has(GAME), 'B paused again once the launcher really is in front');

  // B2. it takes the screen back under another window of the same game (a window we never saw)
  w = world(); w.openGuide(); await w.run(2500);
  w.fg = { hwnd: 999, pid: GAME }; await w.run(600); assert.ok(has(w, /^aside@/), 'B2: ' + w.log);
  // B3. a child process of the game we only know from having paused it
  w = world(); w.openGuide(); await w.run(2500); w.paused.add(201);
  w.fg = { hwnd: 998, pid: 201 }; w.log.length = 0; await w.run(150); assert.ok(has(w, /^resume@/) && !w.paused.size, 'B3: ' + w.log);

  // C. the game never lets go (exclusive full screen, anti-cheat): never paused, steps aside
  w = world(); w.openGuide(false); await w.run(900);
  assert.ok(!has(w, /^pause/) && has(w, /^aside@/), 'C: ' + w.log);

  // D. the game takes the screen back while the pause is still being set up: not frozen
  w = world({ pauseMs: 1200 }); w.openGuide(); await w.run(600); assert.ok(has(w, /^pause@/) && !w.paused.size);
  w.fg = { hwnd: GW, pid: GAME }; await w.run(2000);
  assert.ok(!w.paused.has(GAME) || w.fg.pid === SELF, 'D never frozen in front');

  // E. you go to another program with the guide open: woken, then the guide gets out of the way
  w = world(); w.openGuide(); await w.run(2500); w.log.length = 0;
  w.fg = { hwnd: OW, pid: OTHER };
  await w.run(600); assert.ok(has(w, /^resume@/) && !has(w, /aside/), 'E woken: ' + w.log);
  await w.run(900); assert.ok(has(w, /^drop@/) && !has(w, /aside/), 'E guide dropped: ' + w.log);
  // ... but a blip (another window in front for one tick) changes nothing
  w = world(); w.openGuide(); await w.run(2500); w.log.length = 0;
  w.fg = { hwnd: OW, pid: OTHER }; await w.run(150); w.fg = { hwnd: OV, pid: SELF }; await w.run(1500);
  assert.deepStrictEqual(w.log, [], 'E blip: ' + w.log);
  // no window in front at all for a moment: nothing rash
  w = world(); w.openGuide(); await w.run(2500); w.log.length = 0; w.fg = null; await w.run(300); w.fg = { hwnd: OV, pid: SELF }; await w.run(600);
  assert.deepStrictEqual(w.log, []);

  // F. handing the screen back: asked again twice, then the launcher minimizes itself
  w = world({ fg: { hwnd: WIN, pid: SELF } }); w.guard.expectGame(GW); await w.run(3000);
  assert.deepStrictEqual(w.log.map((l) => l.split('@')[0]), ['focus', 'focus', 'min'], 'F: ' + w.log);
  assert.ok(w.fg.pid === GAME && !w.paused.size && !w.guard.expecting);
  w = world({ fg: { hwnd: WIN, pid: SELF }, focusWorks: true }); w.guard.expectGame(GW); await w.run(3000);
  assert.deepStrictEqual(w.log.map((l) => l.split('@')[0]), ['focus'], 'F2: ' + w.log);
  // the guide opened again meanwhile: the launcher is meant to be in front, hands off
  w = world({ fg: { hwnd: WIN, pid: SELF } }); w.guard.expectGame(GW); await w.run(150); w.openGuide(); await w.run(3000);
  assert.ok(!has(w, /focus|min/) && w.paused.has(GAME), 'F3: ' + w.log);
  // the hold-off: the launcher in front right after a hand-back doesn't freeze the game
  w = world({ fg: { hwnd: WIN, pid: SELF }, focusWorks: true }); w.guard.expectGame(0); await w.run(1800);
  assert.ok(!has(w, /^pause/), 'J hold-off: ' + w.log);

  // G. anti-cheat games are never paused; one found out late is woken
  w = world(); w.game.pausable = false; w.openGuide(); await w.run(3000); assert.ok(!has(w, /^pause/), 'G');
  w = world(); w.openGuide(); await w.run(2500); assert.ok(w.paused.size); w.game.pausable = false; await w.run(150); assert.ok(!w.paused.size, 'G2');

  // H. a pause that pauses nothing isn't hammered
  w = world({ pauseWorks: false, pauseMs: 150 }); w.openGuide(); await w.run(4500);
  assert.strictEqual(w.log.filter((l) => /^pause/.test(l)).length, 1, 'H: ' + w.log);
  await w.run(2000); assert.strictEqual(w.log.filter((l) => /^pause/.test(l)).length, 2, 'H retry later');

  // I. the game is gone: nothing stays frozen
  w = world(); w.openGuide(); await w.run(2500); w.game = null; w.fg = { hwnd: WIN, pid: SELF }; await w.run(150); assert.ok(!w.paused.size, 'I');

  // K. the launcher's own screen in front with the game behind it (guide on the launcher's screen)
  w = world({ fg: { hwnd: WIN, pid: SELF } }); await w.run(2000); assert.ok(w.paused.has(GAME), 'K');
  w.shown = false; w.paused.clear(); w.log.length = 0; w.fg = { hwnd: OW, pid: OTHER }; await w.run(2000); assert.ok(!has(w, /^pause/), 'K2');

  // L. random storm: whatever happens, a frozen game is never left in front (checked in run())
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let n = 0; n < 300; n++) {
    w = world({ pauseMs: 150 + Math.floor(rnd() * 1500) });
    for (let i = 0; i < 40; i++) {
      const k = Math.floor(rnd() * 7);
      if (k === 0) w.openGuide(rnd() < 0.6);
      else if (k === 1) w.fg = { hwnd: GW, pid: GAME };
      else if (k === 2) w.fg = { hwnd: OW, pid: OTHER };
      else if (k === 3) w.fg = w.overlay ? { hwnd: OV, pid: SELF } : { hwnd: WIN, pid: SELF };
      else if (k === 4) { w.overlay = null; w.guard.expectGame(GW); }
      else if (k === 5) w.fg = null;
      else w.shown = rnd() < 0.5;
      await w.run(150 * (1 + Math.floor(rnd() * 8)));
    }
  }
  console.log('focus guard ok');
})().catch((e) => { console.error(e); process.exit(1); });
