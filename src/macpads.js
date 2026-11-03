'use strict';
// Controllers on a Mac, read in the background (also while a game is in front), so the Xbox / PS
// button opens the guide like it does on Windows.
//
// macOS's IOKit HID manager hands every input report from game pads to the launcher, whichever
// app is in front. It's used here through koffi (no compiled add-on): the manager runs on the
// app's main run loop and calls back with each report.
//
// Read: Xbox controllers over Bluetooth (One S, Series, Elite 2) and PlayStation controllers
// (DualShock 4, DualSense, over USB or Bluetooth). Each report becomes Xbox-style buttons
// (the same bits as XInput on Windows), so the rest of the launcher works the same way.

const MICROSOFT = 0x045e, SONY = 0x054c;
const { parseReport } = require('./sonypads');
const SONY_PADS = new Set([0x05c4, 0x09cc, 0x0ba0, 0x0ce6, 0x0df2]);

// ---------- report parsing (pure, tested on any computer) ----------
const HAT = [0, 0x0001, 0x0009, 0x0008, 0x000a, 0x0002, 0x0006, 0x0004, 0x0005]; // 1 = up ... 8 = up-left (0 = none)
const s16 = (v) => Math.max(-32768, Math.min(32767, v));
// Xbox over Bluetooth (newer firmware: Series, One S 2nd version, Elite 2), report 0x01:
//   1-8 sticks (16 bit, 0-65535), 9-12 triggers, 13 d-pad (1-8), 14 A B _ X Y _ LB RB,
//   15 _ _ View Menu Xbox LS RS, 16 Share (Series).
// The first One S firmware (0x02E0) puts the buttons in a different order and the Xbox button
// in its own report 0x02.
function parseXboxMac(pid, b, n, prev) {
  if (!b || n < 2) return null;
  if (b[0] === 0x02 && n >= 2) return Object.assign({}, prev || blank(), { guide: !!(b[1] & 0x01), mask: ((prev && prev.mask) || 0) & ~0x0400 | (b[1] & 0x01 ? 0x0400 : 0) });
  if (b[0] !== 0x01 || n < 16) return null;
  const u16 = (i) => b[i] | (b[i + 1] << 8);
  const lx = s16(u16(1) - 32768), ly = s16(32767 - u16(3)), rx = s16(u16(5) - 32768), ry = s16(32767 - u16(7));
  const lt = u16(9), rt = u16(11);
  let mask = HAT[b[13]] || 0;
  if (pid === 0x02e0) {
    const x = b[14], y = b[15];
    if (x & 0x01) mask |= 0x1000; if (x & 0x02) mask |= 0x2000; if (x & 0x04) mask |= 0x4000; if (x & 0x08) mask |= 0x8000;
    if (x & 0x10) mask |= 0x0100; if (x & 0x20) mask |= 0x0200; if (x & 0x40) mask |= 0x0020; if (x & 0x80) mask |= 0x0010;
    if (y & 0x01) mask |= 0x0040; if (y & 0x02) mask |= 0x0080;
    if (prev && prev.guide) mask |= 0x0400;
  } else {
    const x = b[14], y = b[15];
    if (x & 0x01) mask |= 0x1000; if (x & 0x02) mask |= 0x2000; if (x & 0x08) mask |= 0x4000; if (x & 0x10) mask |= 0x8000;
    if (x & 0x40) mask |= 0x0100; if (x & 0x80) mask |= 0x0200;
    if (y & 0x04) mask |= 0x0020; if (y & 0x08) mask |= 0x0010; if (y & 0x10) mask |= 0x0400; if (y & 0x20) mask |= 0x0040; if (y & 0x40) mask |= 0x0080;
  }
  return { kind: 'xbox', mask, lx, ly, rx, ry, lt: lt / 1023, rt: rt / 1023, guide: !!(mask & 0x0400), share: n >= 17 && !!(b[16] & 0x01) };
}
const blank = () => ({ kind: 'xbox', mask: 0, lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, guide: false, share: false });
function parsePs(pid, b, n) {
  const st = parseReport(pid, b, n);
  if (!st) return null;
  return { kind: 'ps', mask: st.mask, lx: st.lx, ly: st.ly, rx: 0, ry: 0, lt: 0, rt: 0, guide: st.ps, share: st.share, options: st.options, circle: st.circle };
}
// One report from a pad -> its state (null for reports that aren't input).
function parseMac(vid, pid, b, n, prev) {
  if (vid === MICROSOFT) return parseXboxMac(pid, b, n, prev);
  if (vid === SONY && SONY_PADS.has(pid)) return parsePs(pid, b, n);
  return null;
}
// The pad as the browser's standard gamepad (for the guide window, fed from here).
const BIT = [0x1000, 0x2000, 0x4000, 0x8000, 0x0100, 0x0200, -1, -2, 0x0020, 0x0010, 0x0040, 0x0080, 0x0001, 0x0002, 0x0004, 0x0008, 0x0400];
function asGamepad(st) {
  return {
    buttons: BIT.map((m) => (m === -1 ? st.lt > 0.5 : m === -2 ? st.rt > 0.5 : !!(st.mask & m))),
    axes: [st.lx / 32768, -st.ly / 32768, st.rx / 32768, -st.ry / 32768]
  };
}

// ---------- IOKit, through koffi ----------
function createMacPads(opts) {
  opts = opts || {};
  const off = { available: false, states: () => [], debug: () => ({ available: false, error: off.error || null, pads: [] }), close() {} };
  if (process.platform !== 'darwin') { off.error = 'Not a Mac'; return off; }
  let k, cf, io, libc;
  try {
    k = require('koffi');
    cf = k.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
    io = k.load('/System/Library/Frameworks/IOKit.framework/IOKit');
    libc = k.load('/usr/lib/libSystem.B.dylib');
  } catch (e) { off.error = 'Couldn’t load macOS’s controller support: ' + (e && e.message || e); return off; }
  const pads = new Map(); // device address -> { vid, pid, name, state, reports, at, buf }
  let error = null, manager = null;
  try {
    const F = (lib, ret, name, args) => lib.func(ret + ' ' + name + '(' + args + ')');
    const CFStringCreateWithCString = F(cf, 'void *', 'CFStringCreateWithCString', 'void *alloc, const char *s, uint32_t enc');
    const CFDataCreate = F(cf, 'void *', 'CFDataCreate', 'void *alloc, const uint8_t *bytes, long len');
    const CFPropertyListCreateWithData = F(cf, 'void *', 'CFPropertyListCreateWithData', 'void *alloc, void *data, unsigned long opts, void *fmt, void *err');
    const CFNumberGetValue = F(cf, 'uint8_t', 'CFNumberGetValue', 'void *num, long type, _Out_ int32_t *out');
    const CFGetTypeID = F(cf, 'unsigned long', 'CFGetTypeID', 'void *cf');
    const CFNumberGetTypeID = F(cf, 'unsigned long', 'CFNumberGetTypeID', '');
    const CFStringGetTypeID = F(cf, 'unsigned long', 'CFStringGetTypeID', '');
    const CFStringGetCString = F(cf, 'uint8_t', 'CFStringGetCString', 'void *s, _Out_ uint8_t *buf, long size, uint32_t enc');
    const CFRunLoopGetMain = F(cf, 'void *', 'CFRunLoopGetMain', '');
    const IOHIDManagerCreate = F(io, 'void *', 'IOHIDManagerCreate', 'void *alloc, uint32_t opts');
    const IOHIDManagerSetDeviceMatchingMultiple = F(io, 'void', 'IOHIDManagerSetDeviceMatchingMultiple', 'void *mgr, void *arr');
    const DevCB = k.proto('void CL_MacHidDeviceCB(void *ctx, int32_t res, void *sender, void *dev)');
    const RepCB = k.proto('void CL_MacHidReportCB(void *ctx, int32_t res, void *sender, uint32_t type, uint32_t id, void *report, long len)');
    const IOHIDManagerRegisterDeviceMatchingCallback = F(io, 'void', 'IOHIDManagerRegisterDeviceMatchingCallback', 'void *mgr, CL_MacHidDeviceCB *cb, void *ctx');
    const IOHIDManagerRegisterDeviceRemovalCallback = F(io, 'void', 'IOHIDManagerRegisterDeviceRemovalCallback', 'void *mgr, CL_MacHidDeviceCB *cb, void *ctx');
    const IOHIDManagerScheduleWithRunLoop = F(io, 'void', 'IOHIDManagerScheduleWithRunLoop', 'void *mgr, void *loop, void *mode');
    const IOHIDManagerOpen = F(io, 'int32_t', 'IOHIDManagerOpen', 'void *mgr, uint32_t opts');
    const IOHIDDeviceGetProperty = F(io, 'void *', 'IOHIDDeviceGetProperty', 'void *dev, void *key');
    const IOHIDDeviceRegisterInputReportCallback = F(io, 'void', 'IOHIDDeviceRegisterInputReportCallback', 'void *dev, void *report, long len, CL_MacHidReportCB *cb, void *ctx');
    const malloc = F(libc, 'void *', 'malloc', 'size_t n');
    const UTF8 = 0x08000100;
    const str = (s) => CFStringCreateWithCString(null, s, UTF8);
    const KEY = { vid: str('VendorID'), pid: str('ProductID'), size: str('MaxInputReportSize'), name: str('Product') };
    const numProp = (dev, key) => {
      const v = IOHIDDeviceGetProperty(dev, key);
      if (!v || CFGetTypeID(v) !== CFNumberGetTypeID()) return 0;
      const out = [0];
      return CFNumberGetValue(v, 3 /* kCFNumberSInt32Type */, out) ? out[0] : 0;
    };
    const strProp = (dev, key) => {
      const v = IOHIDDeviceGetProperty(dev, key);
      if (!v || CFGetTypeID(v) !== CFStringGetTypeID()) return '';
      const buf = Buffer.alloc(256);
      return CFStringGetCString(v, buf, 256, UTF8) ? buf.toString('utf8').replace(/\0[\s\S]*$/, '') : '';
    };
    const arrTypes = new Map();
    const bytesOf = (ptr, len) => {
      let t = arrTypes.get(len);
      if (!t) { t = k.array('uint8', len, 'Array'); arrTypes.set(len, t); }
      return k.decode(ptr, t);
    };
    const addr = (p) => (typeof k.address === 'function' ? String(k.address(p)) : String(p));
    const keyOf = (dev) => addr(dev);

    // Only game pads and joysticks (never keyboards or mice, so macOS doesn't ask about typing).
    const plist = '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><array>' +
      [5, 4, 8].map((u) => '<dict><key>DeviceUsagePage</key><integer>1</integer><key>DeviceUsage</key><integer>' + u + '</integer></dict>').join('') + '</array></plist>';
    const xml = Buffer.from(plist, 'utf8');
    const matching = CFPropertyListCreateWithData(null, CFDataCreate(null, xml, xml.length), 0, null, null);
    if (!matching) throw new Error('Couldn’t describe game pads to macOS');

    const onReport = k.register((ctx, res, sender, type, id, report, len) => {
      try {
        const key = addr(ctx);
        const p = pads.get(key);
        if (!p || !report || len <= 0) return;
        const n = Math.min(Number(len), 128);
        const b = bytesOf(report, n);
        const st = parseMac(p.vid, p.pid, b, n, p.state);
        p.reports++; p.at = Date.now();
        if (st) p.state = st;
      } catch (_) { /* skip this one */ }
    }, k.pointer(RepCB));
    const onAdd = k.register((ctx, res, sender, dev) => {
      try {
        const vid = numProp(dev, KEY.vid), pid = numProp(dev, KEY.pid);
        if (!(vid === MICROSOFT || (vid === SONY && SONY_PADS.has(pid)))) return;
        const key = keyOf(dev);
        if (pads.has(key)) return;
        const size = Math.max(64, Math.min(1024, numProp(dev, KEY.size) || 64));
        const buf = malloc(size); // kept for as long as the pad is connected (macOS writes into it)
        const p = { vid, pid, name: strProp(dev, KEY.name), state: null, reports: 0, at: 0, buf };
        pads.set(key, p);
        IOHIDDeviceRegisterInputReportCallback(dev, buf, size, onReport, dev);
      } catch (e) { error = String(e && e.message || e); }
    }, k.pointer(DevCB));
    const onRemove = k.register((ctx, res, sender, dev) => { try { pads.delete(keyOf(dev)); } catch (_) { /* gone */ } }, k.pointer(DevCB));

    manager = IOHIDManagerCreate(null, 0);
    if (!manager) throw new Error('macOS didn’t give the launcher its controller manager');
    IOHIDManagerSetDeviceMatchingMultiple(manager, matching);
    IOHIDManagerRegisterDeviceMatchingCallback(manager, onAdd, null);
    IOHIDManagerRegisterDeviceRemovalCallback(manager, onRemove, null);
    IOHIDManagerScheduleWithRunLoop(manager, CFRunLoopGetMain(), str('kCFRunLoopDefaultMode'));
    const rc = IOHIDManagerOpen(manager, 0);
    if (rc !== 0) error = 'macOS said no to reading controllers (code ' + (rc >>> 0).toString(16) + '). Allow Couch Launcher in System Settings › Privacy & Security › Input Monitoring.';
  } catch (e) { off.error = String(e && e.message || e); return off; }

  return {
    available: true,
    // Latest state of each pad that has sent something lately.
    states() { const t = Date.now(); return [...pads.values()].filter((p) => p.state && t - p.at < 10 * 60e3).map((p) => p.state); },
    gamepads() { return [...pads.values()].filter((p) => p.state).map((p) => Object.assign({ id: p.name || (p.vid === SONY ? 'PlayStation controller' : 'Xbox Wireless Controller'), kind: p.state.kind }, asGamepad(p.state))); },
    debug() { return { available: true, error, pads: [...pads.values()].map((p) => ({ vid: p.vid, pid: p.pid, name: p.name, reports: p.reports, at: p.at, kind: p.state && p.state.kind, guide: !!(p.state && p.state.guide) })) }; },
    close() { /* the manager lives as long as the app */ }
  };
}

module.exports = { createMacPads, parseMac, parseXboxMac, asGamepad };
