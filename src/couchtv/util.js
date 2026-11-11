'use strict';
// Small parts of Couch TV's app core that don't need the app itself (so they can be tested).

// The settings Couch TV has (everything else in the launcher's settings means nothing here).
const OWN = ['tvMode', 'tvIntro', 'tvQuality', 'tvAutoPlay', 'tvSubLang', 'mpvPath', 'cableAds', 'cableSubs', 'cableLast', 'tvSignInSeen', 'reduceMotion', 'tvInWindow'];
// (Changed by the app core itself: what the screen sends back never overwrites them.)
const CORE = ['mpvPath', 'cableSubs'];

function pickOwn(from) {
  const out = {};
  for (const k of OWN) if (from && from[k] !== undefined) out[k] = from[k];
  return out;
}
// Is any part of this rectangle (enough to grab) on a screen that is there now?
function onScreen(b, displays) {
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width < 300 || b.height < 200) return false;
  return displays.some((d) => {
    const a = d.workArea;
    const w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const h = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
    return w >= 200 && h >= 120 && b.y >= a.y - 10; // (and its title bar isn't above the screen)
  });
}

module.exports = { OWN, CORE, pickOwn, onScreen };
