'use strict';
// Who has the screen while a game runs (Windows). Windows decides that, not the launcher, and a
// game can take the screen back at any moment, so asking once and hoping isn't enough: this
// looks at the real window in front several times a second and keeps three promises.
//
//  1. A paused (frozen) game is never the window in front. A frozen game in front swallows the
//     keyboard and the controller: the guide button, the Windows key and Alt+Tab all seem dead.
//     The game is only paused once one of the launcher's own windows really is in front, and it
//     is woken the moment that stops being true.
//  2. The guide shown over a game really has the screen. If the game keeps it (or takes it back,
//     however late), the game steps aside and the guide opens on the launcher's own screen. If
//     you went to another program instead, the guide gets out of the way.
//  3. A game that is handed the screen back really gets it. If the launcher is still in front a
//     moment later it asks again, and as a last resort the launcher minimizes itself (which
//     hands the screen to the game without touching the game at all).
//
// Everything it needs is passed in, so it can be tested without Windows.

const T = {
  PAUSE_AFTER: 300,   // the launcher in front this long before the game is paused
  RESUME_AFTER: 400,  // something else (not the game) in front this long before it is woken
  KEPT_AFTER: 350,    // the game in front of the open guide this long: it kept the screen
  DROP_AFTER: 1200,   // another program in front of the open guide this long: you left
  EARLY: 1500,        // just after the guide opens, whatever is in front is taken to be the game
  HOLD_OFF: 2000,     // no pausing for this long after the game is handed the screen
  PAUSE_RETRY: 5000,  // a pause that paused nothing isn't tried again sooner than this
  EXPECT_FIRST: 250, EXPECT_NEXT: 450, EXPECT_TRIES: 2, EXPECT_FOR: 4000
};

// d: { now(), self, foreground() -> {hwnd, pid} | null,
//      game() -> null | { pids: [], hwnds: [], pausable: bool },
//      overlay() -> null | { hwnd, openedAt }   (only while the guide is shown over a game)
//      launcherShown() -> bool                  (the main window: visible and not minimized)
//      isPaused(), isPausedPid(pid), pause() -> Promise, resume(),
//      stepAside(), dropOverlay(), focusGame(hwnd), minimizeLauncher() }
function createFocusGuard(d) {
  let frontSince = 0, awaySince = 0, keptSince = 0, noPauseUntil = 0, pauseRetryAt = 0;
  let pausing = false, expect = null;
  const safe = (fn, ...a) => { try { return fn(...a); } catch (_) { return undefined; } };
  const front = () => safe(d.foreground) || null;
  const isOurs = (fg) => !!fg && fg.pid === d.self;
  const isGame = (fg, g) => !!fg && !isOurs(fg) && (g.pids.includes(fg.pid) || g.hwnds.includes(fg.hwnd) || !!safe(d.isPausedPid, fg.pid));

  // Should the game be paused right now? (Also asked again right before it is frozen.)
  function wantsPause() {
    const g = safe(d.game);
    if (!g || !g.pausable || d.now() < noPauseUntil) return false;
    return isOurs(front()) && (!!safe(d.overlay) || !!safe(d.launcherShown));
  }
  function wake() { awaySince = 0; frontSince = 0; safe(d.resume); }

  function tick() {
    const t = d.now(), g = safe(d.game);
    if (!g) {
      frontSince = awaySince = keptSince = 0; expect = null;
      if (safe(d.isPaused)) safe(d.resume); // nothing is left frozen once the game is gone
      return;
    }
    const fg = front(), ours = isOurs(fg), gameFront = isGame(fg, g);

    // 1. pausing
    if (safe(d.isPaused)) {
      frontSince = 0;
      if (gameFront || !g.pausable) wake();
      else if (!ours) { if (!awaySince) awaySince = t; else if (t - awaySince >= T.RESUME_AFTER) wake(); }
      else awaySince = 0;
    } else {
      awaySince = 0;
      if (!pausing && t >= pauseRetryAt && wantsPause()) {
        if (!frontSince) frontSince = t;
        else if (t - frontSince >= T.PAUSE_AFTER) {
          frontSince = 0; pausing = true;
          const done = () => { pausing = false; if (!safe(d.isPaused)) pauseRetryAt = d.now() + T.PAUSE_RETRY; };
          let p;
          try { p = d.pause(); } catch (_) { p = null; }
          if (p && typeof p.then === 'function') p.then(done, done); else done();
        }
      } else if (!pausing) frontSince = 0;
    }

    // 2. the guide over the game
    const ov = safe(d.overlay);
    if (ov && fg && !ours) {
      if (!keptSince) keptSince = t;
      const dt = t - keptSince;
      const gameish = gameFront || t - (ov.openedAt || 0) < T.EARLY;
      if (gameish && dt >= T.KEPT_AFTER) { keptSince = 0; expect = null; safe(d.stepAside); }
      else if (!gameish && dt >= T.DROP_AFTER) { keptSince = 0; safe(d.dropOverlay); }
    } else keptSince = 0;

    // 3. the game was handed the screen: did it get it?
    if (expect) {
      if (ov || t - expect.at > T.EXPECT_FOR) expect = null;
      else if (fg && !ours) expect = null; // the launcher is no longer in front: done
      else if (ours && t >= expect.nextAt) {
        if (expect.tries < T.EXPECT_TRIES) { expect.tries++; expect.nextAt = t + T.EXPECT_NEXT; safe(d.focusGame, expect.hwnd); }
        else { expect = null; safe(d.minimizeLauncher); }
      }
    }
  }

  return {
    tick, wantsPause, T,
    // The game is being given the screen (Resume, closing the guide, the game just started).
    expectGame(hwnd) {
      const t = d.now();
      noPauseUntil = t + T.HOLD_OFF; frontSince = 0;
      expect = hwnd ? { hwnd, at: t, tries: 0, nextAt: t + T.EXPECT_FIRST } : null;
    },
    // The launcher is meant to be in front now (the guide was opened, or you came back).
    cancelExpect() { expect = null; noPauseUntil = 0; },
    get expecting() { return !!expect; }
  };
}

module.exports = { createFocusGuard };
