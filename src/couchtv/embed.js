'use strict';
// Windows: the few window calls Couch TV needs to keep the player's picture inside its own
// window. The player (mpv) is started with Couch TV's window as its parent, so its picture is
// a child of that window: it moves with it, is clipped by it and goes away with it.
//  - child(parent): the player's picture inside this window (or 0);
//  - fit(parent): makes that picture fill the window's inside (the player follows the window's
//    size by itself; this is asked as well whenever the window changes, so it never lags);
//  - inside(h): the size of a window's inside, in screen pixels;
//  - place(h): where a window is on the screen, in screen pixels;
//  - focusOurs(): whether the keyboard is with this program (not with the player's picture).
// Returns null when these can't be had (not Windows, or the calls failed to load): Couch TV
// then plays videos full screen, the way the launcher does.
function createEmbed() {
  if (process.platform !== 'win32') return null;
  try {
    const koffi = require('koffi');
    const u = koffi.load('user32.dll');
    const RECT = koffi.struct('CTV_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
    const GUI = koffi.struct('CTV_GUITHREADINFO', { cbSize: 'uint32', flags: 'uint32', hwndActive: 'uintptr_t', hwndFocus: 'uintptr_t', hwndCapture: 'uintptr_t', hwndMenuOwner: 'uintptr_t', hwndMoveSize: 'uintptr_t', hwndCaret: 'uintptr_t', rcCaret: RECT });
    const FindWindowExW = u.func('__stdcall', 'FindWindowExW', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'str16', 'str16']);
    const GetClientRect = u.func('__stdcall', 'GetClientRect', 'bool', ['uintptr_t', koffi.out(koffi.pointer(RECT))]);
    const GetWindowRect = u.func('__stdcall', 'GetWindowRect', 'bool', ['uintptr_t', koffi.out(koffi.pointer(RECT))]);
    const SetWindowPos = u.func('__stdcall', 'SetWindowPos', 'bool', ['uintptr_t', 'uintptr_t', 'int', 'int', 'int', 'int', 'uint32']);
    const GetParent = u.func('__stdcall', 'GetParent', 'uintptr_t', ['uintptr_t']);
    const IsWindowVisible = u.func('__stdcall', 'IsWindowVisible', 'bool', ['uintptr_t']);
    const GetWindowThreadProcessId = u.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['uintptr_t', koffi.out(koffi.pointer('uint32'))]);
    const GetGUIThreadInfo = u.func('__stdcall', 'GetGUIThreadInfo', 'bool', ['uint32', koffi.inout(koffi.pointer(GUI))]);
    const pidOf = (h) => { const p = [0]; GetWindowThreadProcessId(h, p); return p[0]; };
    const api = {
      child(parent) {
        let h = 0;
        for (let i = 0; i < 50; i++) {
          h = Number(FindWindowExW(parent, h, 'mpv', null));
          if (!h) return 0;
          if (pidOf(h) !== process.pid) return h;
        }
        return 0;
      },
      inside(h) { const r = {}; return GetClientRect(h, r) ? { width: r.right - r.left, height: r.bottom - r.top } : null; },
      place(h) { const r = {}; return GetWindowRect(h, r) ? { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top } : null; },
      parentOf: (h) => Number(GetParent(h)),
      visible: (h) => !!IsWindowVisible(h),
      fit(parent) {
        const c = api.child(parent), box = c ? api.inside(parent) : null;
        if (!c || !box || box.width < 1 || box.height < 1) return false;
        const cur = api.inside(c);
        if (cur && cur.width === box.width && cur.height === box.height) return true;
        // (Asked, not waited for: the player is another program. No change of focus or order.)
        return !!SetWindowPos(c, 0, 0, 0, box.width, box.height, 0x4 | 0x10 | 0x4000); // NOZORDER | NOACTIVATE | ASYNCWINDOWPOS
      },
      // Which program has the keyboard right now (0 when it can't be told).
      focusPid() {
        const g = { cbSize: koffi.sizeof(GUI) };
        if (!GetGUIThreadInfo(0, g)) return 0;
        const h = Number(g.hwndFocus || g.hwndActive || 0);
        return h ? pidOf(h) : 0;
      }
    };
    return api;
  } catch (_) { return null; }
}

module.exports = { createEmbed };
