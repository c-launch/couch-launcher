'use strict';
// Controller as a mouse while Apple Music or Spotify is in front (they have no controller support).
// Left stick: pointer · A: click · right stick: scroll · D-pad: arrow keys · B: Back (Esc)
// X: play/pause · LB/RB: previous/next track · Menu: Enter.
// Only Xbox-style (XInput) controllers; the Xbox button still opens the launcher's guide.

// Apps without controller support where the controller works as a mouse.
const MUSIC_APPS = new Set(['applemusic.exe', 'spotify.exe', 'discord.exe', 'discordptb.exe', 'discordcanary.exe', 'epicgameslauncher.exe']);
const B = { UP: 0x1, DOWN: 0x2, LEFT: 0x4, RIGHT: 0x8, START: 0x10, LB: 0x100, RB: 0x200, A: 0x1000, B: 0x2000, X: 0x4000 };
const VK = { UP: 0x26, DOWN: 0x28, LEFT: 0x25, RIGHT: 0x27, ESC: 0x1B, ENTER: 0x0D, PLAY: 0xB3, PREV: 0xB1, NEXT: 0xB0 };

function createPadMouse(loadXInput, isEnabled) {
  const off = { start() {}, stop() {}, available: false };
  if (process.platform !== 'win32') return off;
  let x, u, k32, koffi;
  try {
    x = loadXInput();
    koffi = require('koffi');
    const user = koffi.load('user32.dll');
    k32 = koffi.load('kernel32.dll');
    u = {
      fg: user.func('__stdcall', 'GetForegroundWindow', 'uintptr_t', []),
      pidOf: user.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['uintptr_t', koffi.out(koffi.pointer('uint32'))]),
      mouse: user.func('__stdcall', 'mouse_event', 'void', ['uint32', 'int32', 'int32', 'int32', 'uintptr_t']),
      key: user.func('__stdcall', 'keybd_event', 'void', ['uint8', 'uint8', 'uint32', 'uintptr_t']),
      open: k32.func('__stdcall', 'OpenProcess', 'void *', ['uint32', 'bool', 'uint32']),
      close: k32.func('__stdcall', 'CloseHandle', 'bool', ['void *']),
      imageName: k32.func('__stdcall', 'QueryFullProcessImageNameW', 'bool', ['void *', 'uint32', 'void *', koffi.inout(koffi.pointer('uint32'))])
    };
  } catch (_) { return off; }

  const names = new Map(); // pid -> exe name
  function exeOf(pid) {
    if (names.has(pid)) return names.get(pid);
    let name = '';
    const h = u.open(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    if (h) {
      try {
        const buf = Buffer.alloc(2048);
        const len = [1024];
        if (u.imageName(h, 0, buf, len)) name = buf.toString('utf16le', 0, len[0] * 2).split('\\').pop().toLowerCase();
      } finally { u.close(h); }
    }
    if (names.size > 200) names.clear();
    names.set(pid, name);
    return name;
  }
  function musicInFront() {
    const h = u.fg();
    if (!h) return false;
    const pid = [0];
    u.pidOf(h, pid);
    return MUSIC_APPS.has(exeOf(pid[0]));
  }

  const tap = (vk, ext) => { u.key(vk, 0, ext ? 1 : 0, 0); u.key(vk, 0, (ext ? 1 : 0) | 2, 0); };
  let prev = 0, timer = null, checkTimer = null, active = false, repeatAt = 0, heldDir = 0;
  const curve = (v) => { const dead = 7849; const a = Math.abs(v); if (a < dead) return 0; const n = (a - dead) / (32767 - dead); return Math.sign(v) * n * n; };

  function frame() {
    let st = null;
    for (let i = 0; i < 4 && !st; i++) {
      const s = {};
      try { if (x.getState(i, s) === 0 && s.Gamepad && (s.Gamepad.wButtons || Math.abs(s.Gamepad.sThumbLX) > 7849 || Math.abs(s.Gamepad.sThumbLY) > 7849 || Math.abs(s.Gamepad.sThumbRY) > 8689)) st = s.Gamepad; } catch (_) { /* skip */ }
    }
    if (!st) { if (prev & B.A) u.mouse(0x4, 0, 0, 0, 0); prev = 0; heldDir = 0; return; }
    const b = st.wButtons;
    const down = (m) => (b & m) && !(prev & m);
    const up = (m) => !(b & m) && (prev & m);
    // Pointer and scroll
    const dx = Math.round(curve(st.sThumbLX) * 22), dy = Math.round(-curve(st.sThumbLY) * 22);
    if (dx || dy) u.mouse(0x1, dx, dy, 0, 0);
    const wheel = Math.round(curve(st.sThumbRY) * 60);
    if (wheel) u.mouse(0x800, 0, 0, wheel, 0);
    // Buttons
    if (down(B.A)) u.mouse(0x2, 0, 0, 0, 0);
    if (up(B.A)) u.mouse(0x4, 0, 0, 0, 0);
    if (down(B.B)) tap(VK.ESC);
    if (down(B.X)) tap(VK.PLAY, true);
    if (down(B.LB)) tap(VK.PREV, true);
    if (down(B.RB)) tap(VK.NEXT, true);
    if (down(B.START)) tap(VK.ENTER);
    // D-pad as arrow keys, repeating while held
    const dir = b & (B.UP | B.DOWN | B.LEFT | B.RIGHT);
    const now = Date.now();
    if (dir && (dir !== heldDir || now >= repeatAt)) {
      const vk = dir & B.UP ? VK.UP : dir & B.DOWN ? VK.DOWN : dir & B.LEFT ? VK.LEFT : VK.RIGHT;
      tap(vk, true);
      repeatAt = now + (dir !== heldDir ? 400 : 90);
    }
    heldDir = dir;
    prev = b;
  }

  function setActive(on) {
    if (on === active) return;
    active = on;
    if (on) { prev = 0xFFFF; timer = setInterval(frame, 16); } // ignore buttons already held
    else { clearInterval(timer); timer = null; if (prev & B.A) u.mouse(0x4, 0, 0, 0, 0); prev = 0; }
  }

  return {
    available: true,
    start() { if (!checkTimer) checkTimer = setInterval(() => { try { setActive(isEnabled() && musicInFront()); } catch (_) { setActive(false); } }, 400); },
    stop() { clearInterval(checkTimer); checkTimer = null; setActive(false); }
  };
}

module.exports = { createPadMouse };
