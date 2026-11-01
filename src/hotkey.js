'use strict';
// Reads Xbox-style (XInput) controllers from the app core, so buttons work even while a game
// has the screen (Chromium only reads controllers for the focused window).
//
//  - Xbox / Guide button: read through XInput's hidden "XInputGetStateEx" (ordinal 100),
//    the only way Windows exposes it. If that can't be loaded, this button isn't available.
//  - View + Menu held for 1 second: fallback that always works with XInput.
//
// If XInput can't be loaded at all (non-Windows, missing package), this quietly does nothing.

const BACK = 0x0020;
const START = 0x0010;
const GUIDE = 0x0400;
const HOLD_MS = 1000;
const POLL_MS = 40;

let xinputCache = null;
// Loaded once and shared (the controller watcher and the music-app mouse both use it).
function loadXInput() {
  if (xinputCache) return xinputCache;
  const koffi = require('koffi');
  let lib = null;
  let dllName = null;
  for (const dll of ['xinput1_4.dll', 'xinput1_3.dll', 'xinput9_1_0.dll']) {
    try { lib = koffi.load(dll); dllName = dll; break; } catch (_) { /* try next */ }
  }
  if (!lib) throw new Error('XInput not found');
  const pad = koffi.struct('CL_XINPUT_GAMEPAD', {
    wButtons: 'uint16', bLeftTrigger: 'uint8', bRightTrigger: 'uint8',
    sThumbLX: 'int16', sThumbLY: 'int16', sThumbRX: 'int16', sThumbRY: 'int16'
  });
  const stateType = koffi.struct('CL_XINPUT_STATE', { dwPacketNumber: 'uint32', Gamepad: pad });
  const getState = lib.func('__stdcall', 'XInputGetState', 'uint32', ['uint32', koffi.out(koffi.pointer(stateType))]);

  // XInputGetStateEx has no name, only ordinal 100, so look it up with GetProcAddress.
  let getStateEx = null;
  if (dllName !== 'xinput9_1_0.dll') {
    try {
      const k32 = koffi.load('kernel32.dll');
      const GetModuleHandleW = k32.func('__stdcall', 'GetModuleHandleW', 'void *', ['str16']);
      const GetProcAddress = k32.func('__stdcall', 'GetProcAddress', 'void *', ['void *', 'uintptr_t']);
      const mod = GetModuleHandleW(dllName);
      const ptr = mod && GetProcAddress(mod, 100);
      if (ptr) {
        // The hidden call writes 4 bytes more than XInputGetState (dwPaddingReserved).
        const stateExType = koffi.struct('CL_XINPUT_STATE_EX', { dwPacketNumber: 'uint32', Gamepad: pad, dwPaddingReserved: 'uint32' });
        const proto = koffi.proto('__stdcall', 'CL_XInputGetStateEx', 'uint32', ['uint32', koffi.out(koffi.pointer(stateExType))]);
        if (typeof koffi.call === 'function') getStateEx = (i, st) => koffi.call(ptr, proto, i, st);
        else getStateEx = koffi.decode(ptr, proto);
      }
    } catch (_) { getStateEx = null; }
  }
  // Battery level (xinput1_4 / 1_3 only).
  let getBattery = null;
  if (dllName !== 'xinput9_1_0.dll') {
    try {
      const bat = koffi.struct('CL_XINPUT_BATTERY', { BatteryType: 'uint8', BatteryLevel: 'uint8' });
      getBattery = lib.func('__stdcall', 'XInputGetBatteryInformation', 'uint32', ['uint32', 'uint8', koffi.out(koffi.pointer(bat))]);
    } catch (_) { getBattery = null; }
  }
  xinputCache = { getState, getStateEx, getBattery };
  return xinputCache;
}

// onGuide(): Xbox button pressed. onCombo(): View + Menu held while a game runs.
function createControllerWatcher({ onGuide, onCombo, onBack, onPress }) {
  const off = { start() {}, stop() {}, setGameRunning() {}, setJoin() {}, available: false, guide: false };
  if (process.platform !== 'win32') return off;
  let x;
  try { x = loadXInput(); } catch (err) { return Object.assign(off, { error: String(err && err.message || err) }); }

  let timer = null;
  let gameRunning = false;
  let heldSince = 0, comboFired = false, guideWasDown = false, backWasDown = false;
  let exWorks = !!x.getStateEx;
  let joining = false; // "Who's playing?" screen: report A presses per controller
  const prevSlot = [0, 0, 0, 0];

  function read(i) {
    const st = {};
    if (exWorks) {
      try { const rc = x.getStateEx(i, st); return rc === 0 ? st.Gamepad : null; }
      catch (_) { exWorks = false; } // fall back for good if the hidden call misbehaves
    }
    try { const rc = x.getState(i, st); return rc === 0 ? st.Gamepad : null; } catch (_) { return null; }
  }

  function poll() {
    let combo = false, guide = false, back = false;
    for (let i = 0; i < 4; i++) {
      const g = read(i);
      if (!g) { prevSlot[i] = 0; continue; }
      const b = g.wButtons;
      if (joining && onPress && (b & 0x1000) && !(prevSlot[i] & 0x1000)) onPress(i);
      prevSlot[i] = b;
      if ((b & BACK) && (b & START)) combo = true;
      if (b & GUIDE) guide = true;
      if (b & 0x2000) back = true; // B
    }
    if (guide && !guideWasDown) onGuide();
    guideWasDown = guide;
    if (back && !backWasDown && gameRunning && onBack) onBack();
    backWasDown = back;

    const now = Date.now();
    if (combo && gameRunning) {
      if (!heldSince) heldSince = now;
      if (!comboFired && now - heldSince >= HOLD_MS) { comboFired = true; onCombo(); }
    } else { heldSince = 0; comboFired = false; }
  }

  return {
    available: true,
    get guide() { return exWorks; },
    start() { if (!timer) timer = setInterval(poll, POLL_MS); },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    setGameRunning(on) { gameRunning = !!on; heldSince = 0; comboFired = false; },
    setJoin(on) { joining = !!on; }
  };
}

// Connected Xbox-style controllers with their battery: [{ slot, power: 'wired'|'battery'|'unknown', level: 0-3 }]
// (level: 0 empty, 1 low, 2 medium, 3 full).
function readPads() {
  if (process.platform !== 'win32') return [];
  let x;
  try { x = loadXInput(); } catch (_) { return []; }
  const out = [];
  for (let i = 0; i < 4; i++) {
    const st = {};
    let rc = 1;
    try { rc = x.getState(i, st); } catch (_) { rc = 1; }
    if (rc !== 0) continue;
    let power = 'unknown', level = 3;
    if (x.getBattery) {
      const b = {};
      try {
        if (x.getBattery(i, 0, b) === 0) {
          power = b.BatteryType === 1 ? 'wired' : (b.BatteryType === 2 || b.BatteryType === 3) ? 'battery' : 'unknown';
          level = b.BatteryLevel;
        }
      } catch (_) { /* unknown */ }
    }
    out.push({ slot: i, power, level });
  }
  return out;
}

module.exports = { createControllerWatcher, loadXInput, readPads };
