'use strict';
// PlayStation controllers (DualShock 4, DualSense, DualSense Edge) read straight from Windows'
// HID driver, so the PS button opens the guide even while a game has the screen. Windows'
// Xbox controller system (XInput) never sees these pads, and Chromium only reads controllers
// for the focused window.
//
// Each pad is opened shared (games and Steam keep reading it as usual) with one read always
// waiting in the driver (overlapped I/O). Every poll picks up what arrived, without ever blocking.
// If something can't be loaded (non-Windows, no koffi) this quietly reads nothing.
//
// Xbox Series controllers on Bluetooth are opened too, only for their Share button (Windows
// keeps it from XInput). Everything else on those pads still comes through XInput.

const SONY = 0x054c;
const DUALSENSE = new Set([0x0ce6, 0x0df2]); // DualSense, DualSense Edge
const PADS = new Set([0x05c4, 0x09cc, 0x0ba0, 0x0ce6, 0x0df2]); // + DualShock 4 v1/v2, DS4 USB adapter
const MICROSOFT = 0x045e;
const XBOX_SHARE = new Set([0x0b13, 0x0b20]); // Xbox Series X|S controller over Bluetooth (older / newer firmware)
const STATUS_PENDING = 0x103;
const RESCAN_MS = 3000;
// A pad whose PS button seems to flip this often is being misread: ignore it rather than
// spamming the guide.
const FLIP_LIMIT = 8, FLIP_WINDOW = 1500;

// One input report -> { ps, cross, circle, share, options } or null for reports we don't read.
// size: the pad's report size from Windows (64 on USB; bigger over Bluetooth).
// The three button bytes sit at the same place in every layout, only shifted:
//   DS4 USB / Bluetooth basic 0x01: 5 · DS4 Bluetooth full 0x11-0x19: 7
//   DualSense USB 0x01 (64 bytes): 8 · DualSense Bluetooth basic 0x01: 5 · full 0x31: 9
function parseReport(pid, b, size) {
  const n = size;
  if (!b || n < 10) return null;
  const id = b[0];
  let base;
  if (DUALSENSE.has(pid)) {
    if (id === 0x01) base = n === 64 ? 8 : 5;
    else if (id === 0x31) base = 9;
    else return null;
  } else {
    if (id === 0x01) base = 5;
    else if (id >= 0x11 && id <= 0x19) base = 7;
    else return null;
  }
  if (n < base + 3) return null;
  const b1 = b[base], b2 = b[base + 1], b3 = b[base + 2];
  if ((b1 & 0x0f) > 8) return null; // the d-pad is 0-7 or 8 (centered): anything else isn't a button byte
  // Everything again as Xbox (XInput) buttons, so the same code reads both kinds of pad.
  const hat = b1 & 0x0f;
  let mask = 0;
  if (hat === 7 || hat === 0 || hat === 1) mask |= 0x0001; // up
  if (hat >= 3 && hat <= 5) mask |= 0x0002;                // down
  if (hat >= 5 && hat <= 7) mask |= 0x0004;                // left
  if (hat >= 1 && hat <= 3) mask |= 0x0008;                // right
  if (b2 & 0x20) mask |= 0x0010; // Options = Menu
  if (b2 & 0x10) mask |= 0x0020; // Share / Create = View
  if (b2 & 0x40) mask |= 0x0040; // L3
  if (b2 & 0x80) mask |= 0x0080; // R3
  if (b2 & 0x01) mask |= 0x0100; // L1 = LB
  if (b2 & 0x02) mask |= 0x0200; // R1 = RB
  if (b3 & 0x01) mask |= 0x0400; // PS = Xbox button
  if (b1 & 0x20) mask |= 0x1000; // Cross = A
  if (b1 & 0x40) mask |= 0x2000; // Circle = B
  if (b1 & 0x10) mask |= 0x4000; // Square = X
  if (b1 & 0x80) mask |= 0x8000; // Triangle = Y
  // Left stick (0-255, middle 128; down is 255) as XInput values.
  const lxAt = DUALSENSE.has(pid) ? (id === 0x31 ? 2 : 1) : base - 4;
  const lx = ((b[lxAt] | 0) - 128) * 256, ly = (127 - (b[lxAt + 1] | 0)) * 256;
  return {
    cross: !!(b1 & 0x20), circle: !!(b1 & 0x40),
    share: !!(b2 & 0x10), options: !!(b2 & 0x20),
    ps: !!(b3 & 0x01), mask, lx, ly
  };
}

// Xbox Series over Bluetooth, report 0x01: Share is bit 0 of byte 16 or 17, depending on the
// controller's firmware. Which one is learned: the first time one of them turns on while every
// other button is at rest, that's Share. A bit that keeps flipping by itself isn't a button.
//
// Windows' own Xbox Bluetooth driver (xinputhid) sends a different, 16-byte report with no report
// ID (sticks, both triggers on one axis, buttons, d-pad). Where Share sits in that one isn't the
// same everywhere, so it's learned once: Settings › Controllers › Test the Share button › Find
// Share, you press only Share, and the bit that turns on is remembered (shareMap).
function parseXbox(p, b, size, t, shareMap) {
  if (!b) return null;
  if (b[0] !== 0x01 || size < 17) {
    // The Windows report: a learned Share bit, if there is one for this controller.
    const m = shareMap && shareMap.pid === p.pid && shareMap.size === size ? shareMap : null;
    const xshare = !!(m && m.byte < size && ((b[m.byte] | 0) & m.mask));
    return { kind: 'xbox', xshare, mask: 0, lx: 0, ly: 0, generic: true };
  }
  const x = p.x || (p.x = { lock: null, last: {}, flips: { 16: [], 17: [] }, bad: {} });
  const rest = (b[13] | 0) === 0 && (b[14] | 0) === 0 && (b[15] | 0) === 0;
  for (const c of [16, 17]) {
    if (c >= size) continue;
    const bit = (b[c] | 0) & 1;
    if (x.last[c] !== undefined && bit !== x.last[c]) {
      x.flips[c] = x.flips[c].filter((u) => t - u < 3000);
      x.flips[c].push(t);
      if (x.flips[c].length > 6) { x.bad[c] = true; if (x.lock === c) x.lock = null; }
      if (bit && x.lock == null && !x.bad[c] && rest) x.lock = c;
    }
    x.last[c] = bit;
  }
  const xshare = x.lock != null && !x.bad[x.lock] && ((b[x.lock] | 0) & 1) === 1;
  return { kind: 'xbox', xshare, mask: 0, lx: 0, ly: 0 };
}

// The Windows calls, through koffi (loaded once: koffi type names must be unique).
let apiCache = null;
function loadApi() {
  if (apiCache) return apiCache;
  const koffi = require('koffi');
  const k32 = koffi.load('kernel32.dll');
  const hid = koffi.load('hid.dll');
  const sapi = koffi.load('setupapi.dll');
  const crt = koffi.load('msvcrt.dll');
  const GUID = koffi.struct('CL_HID_GUID', { Data1: 'uint32', Data2: 'uint16', Data3: 'uint16', Data4: koffi.array('uint8', 8) });
  const IFACE = koffi.struct('CL_SP_DEVICE_INTERFACE_DATA', { cbSize: 'uint32', InterfaceClassGuid: GUID, Flags: 'uint32', Reserved: 'uintptr_t' });
  const ATTR = koffi.struct('CL_HIDD_ATTRIBUTES', { Size: 'uint32', VendorID: 'uint16', ProductID: 'uint16', VersionNumber: 'uint16' });

  const HidD_GetHidGuid = hid.func('__stdcall', 'HidD_GetHidGuid', 'void', [koffi.out(koffi.pointer(GUID))]);
  const HidD_GetAttributes = hid.func('__stdcall', 'HidD_GetAttributes', 'uint8', ['intptr_t', koffi.inout(koffi.pointer(ATTR))]);
  const CAPS = koffi.struct('CL_HIDP_CAPS', {
    Usage: 'uint16', UsagePage: 'uint16', InputReportByteLength: 'uint16', OutputReportByteLength: 'uint16',
    FeatureReportByteLength: 'uint16', Reserved: koffi.array('uint16', 17), Counts: koffi.array('uint16', 10)
  });
  const HidD_GetPreparsedData = hid.func('__stdcall', 'HidD_GetPreparsedData', 'uint8', ['intptr_t', koffi.out(koffi.pointer('void *'))]);
  const HidD_FreePreparsedData = hid.func('__stdcall', 'HidD_FreePreparsedData', 'uint8', ['void *']);
  const HidP_GetCaps = hid.func('__stdcall', 'HidP_GetCaps', 'uint32', ['void *', koffi.out(koffi.pointer(CAPS))]);
  const HidD_SetNumInputBuffers = hid.func('__stdcall', 'HidD_SetNumInputBuffers', 'uint8', ['intptr_t', 'uint32']);
  const GetClassDevs = sapi.func('__stdcall', 'SetupDiGetClassDevsW', 'intptr_t', [koffi.pointer(GUID), 'void *', 'void *', 'uint32']);
  const EnumIfaces = sapi.func('__stdcall', 'SetupDiEnumDeviceInterfaces', 'int', ['intptr_t', 'void *', koffi.pointer(GUID), 'uint32', koffi.inout(koffi.pointer(IFACE))]);
  const IfaceDetail = sapi.func('__stdcall', 'SetupDiGetDeviceInterfaceDetailW', 'int', ['intptr_t', koffi.pointer(IFACE), 'void *', 'uint32', 'void *', 'void *']);
  const DestroyList = sapi.func('__stdcall', 'SetupDiDestroyDeviceInfoList', 'int', ['intptr_t']);
  const CreateFileW = k32.func('__stdcall', 'CreateFileW', 'intptr_t', ['str16', 'uint32', 'uint32', 'void *', 'uint32', 'uint32', 'intptr_t']);
  const ReadFile = k32.func('__stdcall', 'ReadFile', 'int', ['intptr_t', 'void *', 'uint32', 'void *', 'void *']);
  const GetOverlappedResult = k32.func('__stdcall', 'GetOverlappedResult', 'int', ['intptr_t', 'void *', koffi.out(koffi.pointer('uint32')), 'int']);
  const CancelIoEx = k32.func('__stdcall', 'CancelIoEx', 'int', ['intptr_t', 'void *']);
  const CloseHandle = k32.func('__stdcall', 'CloseHandle', 'int', ['intptr_t']);
  const memset = crt.func('void * memset(void *, int, size_t)');

  const guid = {};
  HidD_GetHidGuid(guid);
  const U16PATH = koffi.array('uint16', 4096 / 2);
  const u8 = new Map(); // report size -> koffi array type
  const ifaceSize = koffi.sizeof(IFACE);
  const DETAIL = 4096;

  apiCache = {
    // Device paths of the Sony controllers that are plugged in / paired and on.
    list() {
      const out = [];
      const devs = GetClassDevs(guid, null, null, 0x02 | 0x10); // DIGCF_PRESENT | DIGCF_DEVICEINTERFACE
      if (devs === -1 || devs === 0) return out;
      const detail = koffi.alloc('uint8', DETAIL);
      try {
        for (let i = 0; i < 256; i++) {
          const iface = { cbSize: ifaceSize };
          if (!EnumIfaces(devs, null, guid, i, iface)) break;
          memset(detail, 0, DETAIL);
          memset(detail, 8, 1); // cbSize = 8 (SP_DEVICE_INTERFACE_DETAIL_DATA_W on 64-bit)
          if (!IfaceDetail(devs, iface, detail, DETAIL, null, null)) continue;
          const w = koffi.decode(detail, U16PATH);
          let s = '';
          for (let j = 2; j < w.length && w[j]; j++) s += String.fromCharCode(w[j]); // path starts at byte 4
          if (/054c|045e/i.test(s)) out.push(s); // USB "vid_054c", Bluetooth "vid&0002054c"
        }
      } finally { DestroyList(devs); koffi.free(detail); }
      return out;
    },
    open(p) {
      const OPEN = 3, OVERLAPPED = 0x40000000, SHARE = 3;
      let h = CreateFileW(p, 0xC0000000, SHARE, null, OPEN, OVERLAPPED, 0); // read + write
      if (h === -1 || h === 0) h = CreateFileW(p, 0x80000000, SHARE, null, OPEN, OVERLAPPED, 0); // read only
      return h === -1 || h === 0 ? null : h;
    },
    ids(h) {
      const a = { Size: koffi.sizeof(ATTR) };
      if (!HidD_GetAttributes(h, a)) return null;
      return { vid: a.VendorID, pid: a.ProductID };
    },
    // The pad's input report size. Reads must be exactly this big: a bigger buffer can come
    // back holding several reports at once.
    reportSize(h) {
      const pp = [null];
      if (!HidD_GetPreparsedData(h, pp) || !pp[0]) return 0;
      try {
        const caps = {};
        return HidP_GetCaps(pp[0], caps) === 0x00110000 ? caps.InputReportByteLength : 0;
      } finally { HidD_FreePreparsedData(pp[0]); }
    },
    fewBuffers(h) { try { HidD_SetNumInputBuffers(h, 2); } catch (_) { /* fine */ } },
    alloc(n) { const p = koffi.alloc('uint8', n); memset(p, 0, n); return p; },
    free(p) { try { koffi.free(p); } catch (_) { /* fine */ } },
    zero(p, n) { memset(p, 0, n); },
    // Start a read; true when it's in flight or already done (the poll checks which).
    read(h, buf, n, ov) { ReadFile(h, buf, n, null, ov); return true; },
    status(ov) { return koffi.decode(ov, 'uint32'); }, // OVERLAPPED.Internal
    result(h, ov) { const n = [0]; return GetOverlappedResult(h, ov, n, 0) ? n[0] : -1; }, // never waits
    bytes(buf, n) {
      if (!u8.has(n)) u8.set(n, koffi.array('uint8', n));
      return koffi.decode(buf, u8.get(n));
    },
    cancel(h, ov) { try { CancelIoEx(h, ov); } catch (_) { /* fine */ } },
    close(h) { try { CloseHandle(h); } catch (_) { /* fine */ } }
  };
  return apiCache;
}

// read() -> one state per connected pad: [{ ps, cross, circle, share, options }]
function createSonyPads(opts) {
  opts = opts || {};
  const none = { read: () => [], close() {}, available: false };
  if (!opts.api && process.platform !== 'win32') return none;
  let api;
  try { api = opts.api || loadApi(); } catch (err) { return Object.assign(none, { error: String(err && err.message || err) }); }
  const now = opts.now || Date.now;
  const later = opts.later || setTimeout;
  const pads = new Map(); // path -> { h, pid, buf, ov, state }
  let lastScan = -Infinity;
  // PlayStation pads can be switched off in Settings; Xbox Share reading stays on either way.
  const wantPs = opts.wantPs || (() => true);
  const shareMap = opts.shareMap || (() => null);
  // Finding Share in Windows' report: while on, the first single bit (in the button bytes) that
  // turns on is taken as Share.
  let learn = null; // { until, found }
  const seenMs = new Map(); // other Microsoft controllers seen (for the Share button test)

  function drop(path) {
    const p = pads.get(path);
    if (!p) return;
    pads.delete(path);
    // Closing cancels the waiting read; give Windows a moment to finish with its memory
    // before freeing it (never wait for it here: that could freeze the launcher).
    api.cancel(p.h, p.ov);
    api.close(p.h);
    const t = later(() => { api.free(p.buf); api.free(p.ov); }, 5000);
    if (t && t.unref) t.unref();
  }
  function start(p) {
    api.zero(p.ov, 32);
    return api.read(p.h, p.buf, p.size, p.ov);
  }
  function scan() {
    lastScan = now();
    let paths;
    try { paths = api.list(); } catch (_) { return; }
    for (const path of [...pads.keys()]) {
      // Gone, or the handle stopped answering (unplugged / switched off).
      if (!paths.includes(path) || !api.ids(pads.get(path).h)) drop(path);
    }
    for (const path of paths) {
      if (pads.has(path)) continue;
      const h = api.open(path);
      if (!h) continue;
      const ids = api.ids(h);
      const isPs = ids && ids.vid === SONY && PADS.has(ids.pid) && wantPs();
      const isXbox = ids && ids.vid === MICROSOFT && XBOX_SHARE.has(ids.pid);
      if (ids && ids.vid === MICROSOFT && !isXbox) seenMs.set(ids.pid, now());
      if (!isPs && !isXbox) { api.close(h); continue; }
      let size = 0;
      try { size = api.reportSize(h); } catch (_) { size = 0; }
      if (size < 10 || size > 4096) { api.close(h); continue; }
      api.fewBuffers(h); // read fresh reports, not a backlog
      const p = { h, pid: ids.pid, kind: isXbox ? 'xbox' : 'ps', size, buf: api.alloc(size), ov: api.alloc(32), state: null, flips: [], muted: false };
      pads.set(path, p);
      start(p);
    }
  }
  function read() {
    if (now() - lastScan >= RESCAN_MS) scan();
    const out = [];
    for (const [path, p] of [...pads]) {
      // Take every report that's waiting (a few at most), keeping the newest state.
      for (let k = 0; k < 4; k++) {
        if (api.status(p.ov) === STATUS_PENDING) break;
        const n = api.result(p.h, p.ov);
        if (n < 0) { drop(path); break; }
        const bytes = n > 0 ? api.bytes(p.buf, p.size) : null;
        const st = !bytes ? null : p.kind === 'xbox' ? parseXbox(p, bytes, p.size, now(), shareMap()) : parseReport(p.pid, bytes, p.size);
        if (bytes && p.kind === 'xbox' && learn && !learn.found && now() < learn.until) learnFrom(p, bytes);
        if (bytes && p.kind === 'xbox') { p.last = Array.from(bytes); if (!p.first) p.first = p.last.slice(); p.reports = (p.reports || 0) + 1; }
        if (st && p.kind === 'xbox') { p.state = st; start(p); continue; }
        if (st) {
          if (p.state && st.ps !== p.state.ps) {
            const t = now();
            p.flips = p.flips.filter((x) => t - x < FLIP_WINDOW);
            p.flips.push(t);
            if (p.flips.length > FLIP_LIMIT) p.muted = true; // until it's reconnected
          }
          p.state = st;
        }
        start(p);
      }
      if (pads.has(path) && p.state && !p.muted) out.push(p.state);
    }
    return out;
  }
  function close() { for (const path of [...pads.keys()]) drop(path); }
  // PlayStation pads off: drop them (Xbox ones stay).
  function closePs() { for (const [path, p] of [...pads]) if (p.kind === 'ps') drop(path); }
  // Buttons live after the sticks (bytes 1-8) and the triggers (9-10) in Windows' report.
  function learnFrom(p, bytes) {
    const from = bytes[0] === 0x01 && p.size >= 17 ? 13 : 11;
    if (!learn.base) learn.base = {};
    const base = learn.base[p.pid] || (learn.base[p.pid] = Array.from(bytes));
    const on = [];
    for (let i = from; i < p.size; i++) {
      const diff = ((bytes[i] | 0) & ~(base[i] | 0)) & 0xff;
      for (let bit = 0; bit < 8; bit++) if (diff & (1 << bit)) on.push({ byte: i, mask: 1 << bit });
    }
    // Exactly one new bit: that's the button being pressed. (More than one: something else is held.)
    if (on.length === 1) learn.found = { pid: p.pid, size: p.size, byte: on[0].byte, mask: on[0].mask };
    else if (on.length > 1) learn.base[p.pid] = Array.from(bytes).map((v, i) => (i >= from ? (base[i] | 0) | (v | 0) : v));
  }
  function startLearn(ms) { learn = { until: now() + (ms || 15000), found: null, base: null }; return true; }
  function learnResult() { return learn ? { found: learn.found, waiting: !learn.found && now() < learn.until, timedOut: !learn.found && now() >= learn.until } : null; }
  // For Settings › Controllers › Test the Share button.
  function debug() {
    const xbox = [...pads.values()].filter((p) => p.kind === 'xbox').map((p) => ({
      pid: p.pid, size: p.size, reports: p.reports || 0, shareAt: p.x && p.x.lock != null ? p.x.lock : null,
      windowsReport: !!(p.state && p.state.generic), learned: (() => { const m = shareMap(); return m && m.pid === p.pid && m.size === p.size ? m : null; })(),
      bad: p.x ? Object.keys(p.x.bad || {}).map(Number) : [], share: !!(p.state && p.state.xshare),
      last: p.last || null, first: p.first || null
    }));
    return { xbox, otherMicrosoft: [...seenMs.keys()], learn: learnResult() };
  }
  return {
    read, close, closePs, debug, startLearn, learnResult, available: true,
    get count() { return pads.size; },
    get xboxCount() { return [...pads.values()].filter((p) => p.kind === 'xbox').length; },
    // An Xbox pad whose Share button can actually be read: its own report, or Windows' report
    // once Share has been found in it. (Otherwise the View + RB combo stays on.)
    get xboxShareReadable() {
      const m = shareMap();
      return [...pads.values()].some((p) => p.kind === 'xbox' && p.state && (!p.state.generic || (m && m.pid === p.pid && m.size === p.size)));
    }
  };
}

module.exports = { createSonyPads, parseReport, parseXbox, XBOX_SHARE };
