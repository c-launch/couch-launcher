'use strict';
// Small Windows helpers for seamless hand-offs: which window has the screen, and placing the
// launcher directly underneath a game, so when the game closes the launcher is already there.
function createWin32() {
  if (process.platform !== 'win32') return null;
  try {
    const koffi = require('koffi');
    const u = koffi.load('user32.dll');
    const GetForegroundWindow = u.func('__stdcall', 'GetForegroundWindow', 'uintptr_t', []);
    const GetWindowThreadProcessId = u.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['uintptr_t', koffi.out(koffi.pointer('uint32'))]);
    const SetWindowPos = u.func('__stdcall', 'SetWindowPos', 'bool', ['uintptr_t', 'uintptr_t', 'int', 'int', 'int', 'int', 'uint32']);
    const IsWindow = u.func('__stdcall', 'IsWindow', 'bool', ['uintptr_t']);
    const SetForegroundWindow = u.func('__stdcall', 'SetForegroundWindow', 'bool', ['uintptr_t']);
    const AllowSetForegroundWindow = u.func('__stdcall', 'AllowSetForegroundWindow', 'bool', ['uint32']);
    const RECT = koffi.struct('CL_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
    const GetWindowRect = u.func('__stdcall', 'GetWindowRect', 'bool', ['uintptr_t', koffi.out(koffi.pointer(RECT))]);
    const IsZoomed = u.func('__stdcall', 'IsZoomed', 'bool', ['uintptr_t']);
    const k32 = koffi.load('kernel32.dll');
    const GetCurrentThreadId = k32.func('__stdcall', 'GetCurrentThreadId', 'uint32', []);
    const AttachThreadInput = u.func('__stdcall', 'AttachThreadInput', 'bool', ['uint32', 'uint32', 'bool']);
    const BringWindowToTop = u.func('__stdcall', 'BringWindowToTop', 'bool', ['uintptr_t']);
    const ShowWindow = u.func('__stdcall', 'ShowWindow', 'bool', ['uintptr_t', 'int']);
    const FindWindowExW = u.func('__stdcall', 'FindWindowExW', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'str16', 'str16']);
    const IsWindowVisible = u.func('__stdcall', 'IsWindowVisible', 'bool', ['uintptr_t']);
    const IsIconic = u.func('__stdcall', 'IsIconic', 'bool', ['uintptr_t']);
    const GetWindow = u.func('__stdcall', 'GetWindow', 'uintptr_t', ['uintptr_t', 'uint32']);
    const GetWindowTextW = u.func('__stdcall', 'GetWindowTextW', 'int', ['uintptr_t', 'void *', 'int']);
    const OpenProcess = k32.func('__stdcall', 'OpenProcess', 'void *', ['uint32', 'bool', 'uint32']);
    const CloseHandle = k32.func('__stdcall', 'CloseHandle', 'bool', ['void *']);
    const QueryFullProcessImageNameW = k32.func('__stdcall', 'QueryFullProcessImageNameW', 'bool', ['void *', 'uint32', 'void *', koffi.inout(koffi.pointer('uint32'))]);
    const exeOf = (pid) => {
      let name = '';
      const h = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
      if (h) {
        try {
          const buf = Buffer.alloc(2048); const len = [1024];
          if (QueryFullProcessImageNameW(h, 0, buf, len)) name = buf.toString('utf16le', 0, len[0] * 2).split('\\').pop().toLowerCase();
        } finally { CloseHandle(h); }
      }
      return name;
    };
    const titleOf = (h) => { const buf = Buffer.alloc(512); const n = GetWindowTextW(h, buf, 256); return n > 0 ? buf.toString('utf16le', 0, n * 2) : ''; };
    const keybd_event = u.func('__stdcall', 'keybd_event', 'void', ['uint8', 'uint8', 'uint32', 'uintptr_t']);
    const SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10;
    return {
      hwndOf(browserWindow) {
        const b = browserWindow.getNativeWindowHandle();
        return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0);
      },
      foreground() {
        const h = GetForegroundWindow();
        if (!h) return null;
        const pid = [0];
        GetWindowThreadProcessId(h, pid);
        return { hwnd: Number(h), pid: pid[0] };
      },
      // Puts `ours` right below `target` without taking focus.
      placeBelow(ours, target) { return SetWindowPos(ours, target, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE); },
      exists: (h) => !!h && IsWindow(h),
      focus: (h) => SetForegroundWindow(h),
      // Takes focus even from the background: briefly share input with the program that has focus,
      // take it, then stop sharing. No fake key presses.
      forceForeground(h) {
        const fg = GetForegroundWindow();
        if (!fg || Number(fg) === h) { SetForegroundWindow(h); return; }
        const pid = [0];
        const fgThread = GetWindowThreadProcessId(fg, pid);
        const me = GetCurrentThreadId();
        const attached = fgThread && fgThread !== me && AttachThreadInput(me, fgThread, true);
        try { BringWindowToTop(h); SetForegroundWindow(h); }
        finally { if (attached) AttachThreadInput(me, fgThread, false); }
      },
      // Moves and sizes a window (physical pixels) without changing focus or stacking.
      move(h, x, y, w, ht) {
        if (IsZoomed(h)) ShowWindow(h, 9); // un-maximize first, or Windows snaps it back
        return SetWindowPos(h, 0, x, y, w, ht, 0x4 | 0x10 | 0x20); // NOZORDER | NOACTIVATE | FRAMECHANGED
      },
      rect(h) {
        const r = {};
        if (!GetWindowRect(h, r)) return null;
        return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
      },
      // The main window of a running program (by exe name), including minimized ones.
      // Store-app windows can belong to ApplicationFrameHost, so those match by title instead.
      findAppWindow(exeNames, titlePrefix) {
        const want = new Set(exeNames.map((n) => n.toLowerCase()));
        const cache = new Map();
        let h = 0, best = null;
        for (let i = 0; i < 2000; i++) {
          h = Number(FindWindowExW(0, h, null, null));
          if (!h) break;
          if (!IsWindowVisible(h) || Number(GetWindow(h, 4))) continue; // hidden or owned (popups, tooltips)
          const title = titleOf(h);
          if (!title) continue;
          const pid = [0];
          GetWindowThreadProcessId(h, pid);
          if (!cache.has(pid[0])) cache.set(pid[0], exeOf(pid[0]));
          const exe = cache.get(pid[0]);
          const match = want.has(exe) || (exe === 'applicationframehost.exe' && titlePrefix && title.toLowerCase().startsWith(titlePrefix.toLowerCase()));
          if (!match) continue;
          const r = this.rect(h);
          const area = r ? r.width * r.height : 0;
          if (!best || area > best.area || (IsIconic(h) && !best.iconic && best.area === 0)) best = { hwnd: h, area, iconic: IsIconic(h) };
        }
        return best ? best.hwnd : null;
      },
      // Un-minimizes a window and brings it to the front.
      show(h) {
        if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
        else ShowWindow(h, 5); // SW_SHOW
        this.forceForeground(h);
        return true;
      },
      // Presses a key with modifiers held (e.g. [0x11, 0x10] + 'M' = Ctrl+Shift+M), then lets go.
      keys(mods, vk) {
        for (const m of mods) keybd_event(m, 0, 0, 0);
        keybd_event(vk, 0, 0, 0); keybd_event(vk, 0, 2, 0);
        for (const m of mods.slice().reverse()) keybd_event(m, 0, 2, 0);
      },
      // Lets the next program we start come to the front (otherwise Windows keeps it behind us).
      allowForeground: () => AllowSetForegroundWindow(0xFFFFFFFF)
    };
  } catch (_) {
    return null;
  }
}

module.exports = { createWin32 };
