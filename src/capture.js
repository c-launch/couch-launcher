'use strict';
// Medal clips and screenshots from the controller, like a console:
//   tap Share = screenshot · hold Share = clip
// PlayStation: the Share / Create button (not while Options is held: that's the
// "back to the launcher" combo). Xbox Series: its Share button over Bluetooth; otherwise (or
// when chosen in Settings) hold View and press RB for a clip, LB for a screenshot.

const HOLD_MS = 600;

function createCapture({ fire, now, mode }) {
  now = now || Date.now;
  mode = mode || (() => 'auto');
  let downAt = 0, fired = false, cancelled = false, wasDown = false;
  let prevLB = false, prevRB = false;
  // st: { psShare, psOptions, xShare, xView, xLB, xRB, xShareReadable }
  function input(st) {
    const m = mode();
    const t = now();
    const useXShare = m === 'share' || (m === 'auto' && st.xShareReadable);
    const useCombo = m === 'combo' || (m === 'auto' && !st.xShareReadable);
    const down = !!st.psShare || (useXShare && !!st.xShare);
    if (st.psOptions) cancelled = true;
    if (down && !wasDown) { downAt = t; fired = false; cancelled = !!st.psOptions; }
    if (down && !fired && !cancelled && t - downAt >= HOLD_MS) { fired = true; fire('clip'); }
    if (!down && wasDown && !fired && !cancelled) fire('shot');
    wasDown = down;
    if (useCombo && st.xView) {
      if (st.xRB && !prevRB) fire('clip');
      if (st.xLB && !prevLB) fire('shot');
    }
    prevLB = !!st.xLB; prevRB = !!st.xRB;
  }
  return { input };
}

// "Shift+F8" -> { mods: [0x10], vk: 0x77 }
function parseKey(k) {
  const parts = String(k || '').split('+').map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  const MOD = { ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12 };
  const mods = [];
  let vk = null;
  for (const p of parts) {
    const low = p.toLowerCase();
    if (MOD[low]) { mods.push(MOD[low]); continue; }
    const f = /^f([1-9]|1[0-2])$/i.exec(p);
    if (f) vk = 0x6f + Number(f[1]);
    else if (/^(printscreen|prtsc)$/i.test(p)) vk = 0x2c;
    else if (/^[a-z0-9]$/i.test(p)) vk = p.toUpperCase().charCodeAt(0);
    else return null;
  }
  return vk == null ? null : { mods, vk };
}

module.exports = { createCapture, parseKey, HOLD_MS };
