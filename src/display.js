'use strict';
// Per-game TV / monitor settings: resolution, refresh rate and HDR for the chosen display,
// switched when a game starts and put back when it ends. Windows only (user32 through koffi).
// Changes aren't saved to Windows' settings, so a restart always brings back your normal setup.

function createDisplay() {
  if (process.platform !== 'win32') return null;
  let koffi, u;
  try { koffi = require('koffi'); u = koffi.load('user32.dll'); } catch (_) { return null; }
  const fn = (name, ret, args) => { try { return u.func('__stdcall', name, ret, args); } catch (_) { return null; } };
  const EnumDisplayDevicesW = fn('EnumDisplayDevicesW', 'bool', ['str16', 'uint32', 'void *', 'uint32']);
  const EnumDisplaySettingsW = fn('EnumDisplaySettingsW', 'bool', ['str16', 'uint32', 'void *']);
  const ChangeDisplaySettingsExW = fn('ChangeDisplaySettingsExW', 'int32', ['str16', 'void *', 'void *', 'uint32', 'void *']);
  const GetDisplayConfigBufferSizes = fn('GetDisplayConfigBufferSizes', 'int32', ['uint32', koffi.out(koffi.pointer('uint32')), koffi.out(koffi.pointer('uint32'))]);
  const QueryDisplayConfig = fn('QueryDisplayConfig', 'int32', ['uint32', koffi.inout(koffi.pointer('uint32')), 'void *', koffi.inout(koffi.pointer('uint32')), 'void *', 'void *']);
  const DisplayConfigGetDeviceInfo = fn('DisplayConfigGetDeviceInfo', 'int32', ['void *']);
  const DisplayConfigSetDeviceInfo = fn('DisplayConfigSetDeviceInfo', 'int32', ['void *']);
  if (!EnumDisplayDevicesW || !EnumDisplaySettingsW || !ChangeDisplaySettingsExW) return null;

  // DEVMODEW (220 bytes): size @68, fields @72, position @76/@80, bits @168, width @172,
  // height @176, frequency @184.
  const DM_SIZE = 220;
  const newMode = () => { const b = Buffer.alloc(DM_SIZE); b.writeUInt16LE(DM_SIZE, 68); return b; };
  const readMode = (b) => ({ x: b.readInt32LE(76), y: b.readInt32LE(80), bits: b.readUInt32LE(168), w: b.readUInt32LE(172), h: b.readUInt32LE(176), hz: b.readUInt32LE(184) });

  // Attached displays: [{ name: '\\.\DISPLAY1', x, y, w, h, hz }]
  function devices() {
    const out = [];
    for (let i = 0; i < 16; i++) {
      const dd = Buffer.alloc(840);
      dd.writeUInt32LE(840, 0);
      if (!EnumDisplayDevicesW(null, i, dd, 0)) break;
      const flags = dd.readUInt32LE(324);
      if (!(flags & 1)) continue; // not part of the desktop
      const name = dd.toString('utf16le', 4, 68).replace(/\0.*$/s, '');
      const dm = newMode();
      if (!EnumDisplaySettingsW(name, 0xFFFFFFFF, dm)) continue;
      out.push(Object.assign({ name }, readMode(dm)));
    }
    return out;
  }
  // The device for a screen area (physical pixels), matched by its top-left corner.
  function deviceAt(rect) {
    const all = devices();
    return all.find((d) => d.x === rect.x && d.y === rect.y) || all.find((d) => rect.x >= d.x && rect.x < d.x + d.w && rect.y >= d.y && rect.y < d.y + d.h) || null;
  }
  function current(name) { const dm = newMode(); return EnumDisplaySettingsW(name, 0xFFFFFFFF, dm) ? readMode(dm) : null; }
  // Every resolution + refresh rate the display offers (32-bit colour).
  function modes(name) {
    const seen = new Set(), out = [];
    for (let i = 0; i < 2000; i++) {
      const dm = newMode();
      if (!EnumDisplaySettingsW(name, i, dm)) break;
      const m = readMode(dm);
      if (m.bits < 32) continue;
      const k = m.w + 'x' + m.h + '@' + m.hz;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ w: m.w, h: m.h, hz: m.hz });
    }
    return out.sort((a, b) => (b.w * b.h - a.w * a.h) || (b.hz - a.hz));
  }
  // Switches resolution / refresh (not saved: Windows' own setting comes back on restart).
  function setMode(name, want) {
    const cur = current(name);
    if (!cur) throw new Error('Display not found');
    const w = want.w || cur.w, h = want.h || cur.h, hz = want.hz || cur.hz;
    if (w === cur.w && h === cur.h && hz === cur.hz) return false;
    const dm = newMode();
    dm.writeUInt32LE(0x80000 | 0x100000 | 0x400000, 72); // width, height, frequency
    dm.writeUInt32LE(w, 172); dm.writeUInt32LE(h, 176); dm.writeUInt32LE(hz, 184);
    const rc = ChangeDisplaySettingsExW(name, dm, null, 0, null);
    if (rc !== 0) throw new Error('The display didn’t accept ' + w + '×' + h + ' at ' + hz + ' Hz');
    return true;
  }
  // Back to the display's normal (saved) mode.
  function restoreMode(name) { return ChangeDisplaySettingsExW(name, null, null, 0, null) === 0; }

  // ---- HDR through Windows' display configuration
  // DISPLAYCONFIG_PATH_INFO is 72 bytes: source adapter @0/@4, source id @8;
  // target adapter @20/@24, target id @28.
  function paths() {
    if (!GetDisplayConfigBufferSizes || !QueryDisplayConfig) return [];
    const np = [0], nm = [0];
    if (GetDisplayConfigBufferSizes(2, np, nm) !== 0) return []; // QDC_ONLY_ACTIVE_PATHS
    const pb = Buffer.alloc(72 * Math.max(1, np[0])), mb = Buffer.alloc(64 * Math.max(1, nm[0]));
    if (QueryDisplayConfig(2, np, pb, nm, mb, null) !== 0) return [];
    const out = [];
    for (let i = 0; i < np[0]; i++) {
      const o = i * 72;
      out.push({ sLow: pb.readUInt32LE(o), sHigh: pb.readInt32LE(o + 4), sId: pb.readUInt32LE(o + 8), tLow: pb.readUInt32LE(o + 20), tHigh: pb.readInt32LE(o + 24), tId: pb.readUInt32LE(o + 28) });
    }
    return out;
  }
  const header = (size, type, low, high, id) => { const b = Buffer.alloc(size); b.writeUInt32LE(type, 0); b.writeUInt32LE(size, 4); b.writeUInt32LE(low, 8); b.writeInt32LE(high, 12); b.writeUInt32LE(id, 16); return b; };
  function pathFor(name) {
    for (const p of paths()) {
      const pk = header(84, 1, p.sLow, p.sHigh, p.sId); // GET_SOURCE_NAME
      if (DisplayConfigGetDeviceInfo(pk) !== 0) continue;
      if (pk.toString('utf16le', 20, 84).replace(/\0.*$/s, '').toLowerCase() === name.toLowerCase()) return p;
    }
    return null;
  }
  // { supported, enabled } or null when unknown.
  // Windows 11 24H2+ has HDR-specific calls (types 15/16); older Windows uses "advanced color" (9/10),
  // which on newer Windows can also mean auto color management, so the new ones go first.
  function hdrNew(p) {
    const pk = header(36, 15, p.tLow, p.tHigh, p.tId); // GET_ADVANCED_COLOR_INFO_2
    if (DisplayConfigGetDeviceInfo(pk) !== 0) return null;
    const v = pk.readUInt32LE(20);
    return { supported: !!(v & 16), enabled: pk.readUInt32LE(32) === 2 }; // highDynamicRangeSupported; activeColorMode HDR
  }
  function hdr(name) {
    if (!DisplayConfigGetDeviceInfo) return null;
    const p = pathFor(name);
    if (!p) return null;
    const n = hdrNew(p);
    if (n) return n;
    const pk = header(32, 9, p.tLow, p.tHigh, p.tId); // GET_ADVANCED_COLOR_INFO
    if (DisplayConfigGetDeviceInfo(pk) !== 0) return null;
    const v = pk.readUInt32LE(20);
    return { supported: !!(v & 1), enabled: !!(v & 2) };
  }
  function setHdr(name, on) {
    if (!DisplayConfigSetDeviceInfo) throw new Error('HDR switching isn’t available on this PC');
    const p = pathFor(name);
    if (!p) throw new Error('Display not found');
    if (hdrNew(p)) {
      const pk = header(24, 16, p.tLow, p.tHigh, p.tId); // SET_HDR_STATE
      pk.writeUInt32LE(on ? 1 : 0, 20);
      if (DisplayConfigSetDeviceInfo(pk) === 0) return true;
    }
    const pk = header(24, 10, p.tLow, p.tHigh, p.tId); // SET_ADVANCED_COLOR_STATE
    pk.writeUInt32LE(on ? 1 : 0, 20);
    if (DisplayConfigSetDeviceInfo(pk) !== 0) throw new Error('The display didn’t switch HDR');
    return true;
  }

  // ---- Which display is the main one ("Make this my main display").
  // Older games (Need for Speed Underground 2, Rayman Legends…) always open on the main display,
  // whatever window tricks are tried. So for them the chosen display becomes the main one while
  // the game runs, and the layout before is put back afterwards.
  // layout: [{ name, x, y }]; the main display is the one at 0,0.
  function layout() { return devices().map((d) => ({ name: d.name, x: d.x, y: d.y })); }
  function primaryName() { const p = devices().find((d) => d.x === 0 && d.y === 0); return p ? p.name : null; }
  // CDS_UPDATEREGISTRY | CDS_NORESET (| CDS_SET_PRIMARY), then one apply for all of them.
  function applyLayout(list, primary) {
    for (const d of list) {
      const dm = newMode();
      dm.writeUInt32LE(0x20, 72); // DM_POSITION
      dm.writeInt32LE(d.x, 76); dm.writeInt32LE(d.y, 80);
      const rc = ChangeDisplaySettingsExW(d.name, dm, null, 0x1 | 0x10000000 | (d.name === primary ? 0x10 : 0), null);
      if (rc !== 0) throw new Error('Windows didn’t accept the display layout (' + rc + ')');
    }
    const rc = ChangeDisplaySettingsExW(null, null, null, 0, null);
    if (rc !== 0) throw new Error('Windows didn’t apply the display layout (' + rc + ')');
  }
  // Makes `name` the main display; returns the layout to put back, or null if it already was.
  function makePrimary(name) {
    const before = layout();
    const t = before.find((d) => d.name === name);
    if (!t) throw new Error('Display not found');
    if (t.x === 0 && t.y === 0) return null;
    applyLayout(before.map((d) => ({ name: d.name, x: d.x - t.x, y: d.y - t.y })), name);
    return { layout: before, primary: before.find((d) => d.x === 0 && d.y === 0) ? before.find((d) => d.x === 0 && d.y === 0).name : null };
  }
  function restoreLayout(saved) {
    if (!saved || !saved.layout || !saved.primary) return false;
    const now = layout().map((d) => d.name);
    const list = saved.layout.filter((d) => now.includes(d.name)); // a display unplugged since: leave it out
    if (!list.some((d) => d.name === saved.primary)) return false;
    applyLayout(list, saved.primary);
    return true;
  }

  return { devices, deviceAt, current, modes, setMode, restoreMode, hdr, setHdr, layout, primaryName, makePrimary, restoreLayout };
}

module.exports = { createDisplay };
