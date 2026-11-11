'use strict';
// Windows: the few window calls Couch TV needs to keep the player's picture inside its own
// window.
//
// The picture is NOT drawn into Couch TV's window itself. 1.29.0 to 1.29.3 did that, and on a
// real PC the show played unseen with the page still showing (it only worked on GitHub's test
// machine, which has no graphics card: with one, the page is drawn in a way that covers
// anything else placed inside its window). Instead a plain black window of Couch TV's own (the "host", nothing of the page in
// it) is laid exactly over the inside of Couch TV's window and belongs to it: it stays above
// it, hides and comes back with it, and is never the window in use. The player (mpv) is
// started with the host as its parent, so its picture is a child of the host. The controls
// are a see-through window kept just above the host.
//  - createHost(owner) / showHost / placeHost / destroyHost: the host;
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
    const POINT = koffi.struct('CTV_POINT', { x: 'int32', y: 'int32' });
    const CreateWindowExW = u.func('__stdcall', 'CreateWindowExW', 'uintptr_t', ['uint32', 'str16', 'str16', 'uint32', 'int', 'int', 'int', 'int', 'uintptr_t', 'uintptr_t', 'uintptr_t', 'uintptr_t']);
    const DestroyWindow = u.func('__stdcall', 'DestroyWindow', 'bool', ['uintptr_t']);
    const ShowWindow = u.func('__stdcall', 'ShowWindow', 'bool', ['uintptr_t', 'int']);
    const IsWindow = u.func('__stdcall', 'IsWindow', 'bool', ['uintptr_t']);
    const GetWindow = u.func('__stdcall', 'GetWindow', 'uintptr_t', ['uintptr_t', 'uint32']);
    const GetTopWindow = u.func('__stdcall', 'GetTopWindow', 'uintptr_t', ['uintptr_t']);
    const GetClassNameW = u.func('__stdcall', 'GetClassNameW', 'int', ['uintptr_t', 'void *', 'int']);
    const GetWindowLongPtrW = u.func('__stdcall', 'GetWindowLongPtrW', 'intptr_t', ['uintptr_t', 'int']);
    const WindowFromPoint = u.func('__stdcall', 'WindowFromPoint', 'uintptr_t', [POINT]);
    const GetAncestor = u.func('__stdcall', 'GetAncestor', 'uintptr_t', ['uintptr_t', 'uint32']);
    const SetCursorPos = u.func('__stdcall', 'SetCursorPos', 'bool', ['int', 'int']);
    const mouse_event = u.func('__stdcall', 'mouse_event', 'void', ['uint32', 'uint32', 'uint32', 'uint32', 'uintptr_t']);
    const pidOf = (h) => { const p = [0]; GetWindowThreadProcessId(h, p); return p[0]; };
    const classOf = (h) => { const b = Buffer.alloc(256); const n = GetClassNameW(h, b, 127); return n > 0 ? b.toString('utf16le', 0, n * 2) : ''; };
    const api = {
      // A plain black window owned by `owner` (so it stays above it and goes with it), that
      // never becomes the window in use and has no taskbar button. 0 when it can't be made.
      createHost(owner) {
        // "Static" with SS_BLACKRECT: Windows' own class that paints itself black.
        // WS_POPUP | WS_CLIPCHILDREN | SS_BLACKRECT; WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW
        return Number(CreateWindowExW(0x08000000 | 0x80, 'Static', 'Couch TV picture', (0x80000000 | 0x02000000 | 0x4) >>> 0, 0, 0, 16, 16, owner, 0, 0, 0)) || 0;
      },
      isWindow: (h) => !!h && !!IsWindow(h),
      showHost(h, on) { return !!ShowWindow(h, on ? 4 : 0); }, // SW_SHOWNOACTIVATE / SW_HIDE
      // Where it is (screen pixels), and its place in the pile: just under `under` (the
      // controls) when that is given, otherwise left where it is in the pile.
      placeHost(h, b, under) {
        return !!SetWindowPos(h, under || 0, b.x, b.y, b.width, b.height, 0x10 | (under ? 0 : 0x4)); // NOACTIVATE (| NOZORDER)
      },
      destroyHost(h) { try { return !!DestroyWindow(h); } catch (_) { return false; } },
      // For finding out what is wrong on a PC where it doesn't look right: the window under a
      // point of the screen, and this program's and the player's windows from the top of the pile down.
      windowAt(x, y) { const h = Number(WindowFromPoint({ x: Math.round(x), y: Math.round(y) })); const top = h ? Number(GetAncestor(h, 2)) : 0; return { hwnd: h, cls: h ? classOf(h) : '', pid: h ? pidOf(h) : 0, top, topCls: top ? classOf(top) : '' }; },
      describe(h) { const r = api.place(h); return { hwnd: h, cls: classOf(h), pid: pidOf(h), visible: !!IsWindowVisible(h), ex: Number(BigInt.asUintN(32, BigInt(GetWindowLongPtrW(h, -20)))).toString(16), style: Number(BigInt.asUintN(32, BigInt(GetWindowLongPtrW(h, -16)))).toString(16), owner: Number(GetWindow(h, 4)), rect: r }; },
      pile(pids) {
        const out = [];
        let h = Number(GetTopWindow(0));
        for (let i = 0; h && i < 4000; i++) { if (pids.includes(pidOf(h)) && IsWindowVisible(h)) out.push(api.describe(h)); h = Number(GetWindow(h, 2)); }
        return out;
      },
      children(parent) { const out = []; let h = Number(GetWindow(parent, 5)); for (let i = 0; h && i < 200; i++) { out.push(api.describe(h)); h = Number(GetWindow(h, 2)); } return out; },
      // A real click of the mouse at a point of the screen (the build check only).
      clickAt(x, y) { SetCursorPos(Math.round(x), Math.round(y)); mouse_event(0x2, 0, 0, 0, 0); mouse_event(0x4, 0, 0, 0, 0); },
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
