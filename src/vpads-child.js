'use strict';
// Steady players: a small separate process (Couch Launcher in Node mode) that plugs in one
// virtual controller per player through the ViGEmBus driver, and passes each real controller's
// buttons to its player's virtual one. If a real controller dies, its virtual one stays
// plugged in, so the emulator never shuffles the players; when it comes back (or another
// controller presses A) it takes that player's spot again.
//
// The virtual controllers are PlayStation-style (DualShock 4 reports) with their own maker
// numbers, so they don't use up Windows' four Xbox-controller spots, and the launcher can tell
// them apart from real controllers (VPAD_VID / VPAD_PID).
//
// stdin (one JSON line each): { players: [slot, slot, …] } (real Xbox-style slot per player,
// null for a free spot) | { stop: true }
// stdout: { ready: true, players: n } | { error, code } | { state: [{ p, slot, on }] } on changes

const VPAD_VID = 0x1532, VPAD_PID = 0x1000; // reported as a DS4-type pad (Razer Raiju numbers)

// ------------------------------------------------------------------ pure parts (tested)
// XInput state -> DualShock 4 report (9 bytes as the driver wants them).
const HAT = { 1: 0, 9: 1, 8: 2, 10: 3, 2: 4, 6: 5, 4: 6, 5: 7 }; // up=1 down=2 left=4 right=8
function ds4Report(g) {
  const r = Buffer.alloc(10);
  const b = g ? g.wButtons | 0 : 0;
  const x8 = (v) => Math.max(0, Math.min(255, ((v | 0) + 32768) >> 8));
  const y8 = (v) => 255 - x8(v); // XInput up is +, DS4 up is 0
  r[0] = g ? x8(g.sThumbLX) : 0x80;
  r[1] = g ? y8(g.sThumbLY) : 0x80;
  r[2] = g ? x8(g.sThumbRX) : 0x80;
  r[3] = g ? y8(g.sThumbRY) : 0x80;
  const dir = b & 0xF;
  let w = HAT[dir] !== undefined ? HAT[dir] : 8;
  if (b & 0x4000) w |= 1 << 4;  // X -> Square
  if (b & 0x1000) w |= 1 << 5;  // A -> Cross
  if (b & 0x2000) w |= 1 << 6;  // B -> Circle
  if (b & 0x8000) w |= 1 << 7;  // Y -> Triangle
  if (b & 0x0100) w |= 1 << 8;  // LB
  if (b & 0x0200) w |= 1 << 9;  // RB
  const lt = g ? g.bLeftTrigger | 0 : 0, rt = g ? g.bRightTrigger | 0 : 0;
  if (lt > 30) w |= 1 << 10;
  if (rt > 30) w |= 1 << 11;
  if (b & 0x0020) w |= 1 << 12; // View -> Share
  if (b & 0x0010) w |= 1 << 13; // Menu -> Options
  if (b & 0x0040) w |= 1 << 14; // L3
  if (b & 0x0080) w |= 1 << 15; // R3
  r.writeUInt16LE(w, 4);
  r[6] = 0; // PS / touch pad: never sent (the guide button stays the launcher's)
  r[7] = lt; r[8] = rt;
  return r;
}

// Who drives which player. players: real slot per player (null = no controller yet).
// live: real slots connected now; appeared: slots that just connected; aPressed: slots whose
// A just went down. A player whose controller went away keeps waiting for it (Windows usually
// gives it the same slot back). Another controller takes a waiting player's spot when it
// presses A, or when it was just turned on and only one player is waiting. Controllers that
// were already there and nobody's (say, one lying on the table) are left alone.
function reassign(players, live, appeared, aPressed) {
  const out = players.slice();
  const isWaiting = (i) => out[i] == null || !live.has(out[i]);
  const owned = new Set(out.filter((s, i) => s != null && !isWaiting(i)));
  for (const s of [...live].sort((x, y) => x - y)) {
    if (owned.has(s)) continue;
    const w = out.map((_, i) => i).filter(isWaiting);
    if (!w.length) break;
    if (aPressed.has(s) || (appeared.has(s) && w.length === 1)) { out[w[0]] = s; owned.add(s); }
  }
  return out;
}

module.exports = { ds4Report, reassign, VPAD_VID, VPAD_PID };
if (require.main !== module) return;

// ------------------------------------------------------------------ the driver
const say = (o) => { try { process.stdout.write(JSON.stringify(o) + '\n'); } catch (_) { /* parent gone */ } };
let bus = null, plugged = [], api = null;
function cleanup() {
  if (api && bus) for (const sn of plugged) { try { api.unplug(sn); } catch (_) { /* gone */ } }
  plugged = [];
  if (api && bus) { try { api.CloseHandle(bus); } catch (_) { /* gone */ } }
  bus = null;
}
process.on('exit', cleanup);
const quit = () => { cleanup(); process.exit(0); };
process.stdin.on('end', quit);
process.stdin.on('error', quit);

try {
  const koffi = require(process.env.COUCH_KOFFI || 'koffi');
  const k32 = koffi.load('kernel32.dll');
  const sapi = koffi.load('setupapi.dll');
  const CreateFileW = k32.func('__stdcall', 'CreateFileW', 'intptr_t', ['str16', 'uint32', 'uint32', 'void *', 'uint32', 'uint32', 'intptr_t']);
  const DeviceIoControl = k32.func('__stdcall', 'DeviceIoControl', 'int', ['intptr_t', 'uint32', 'void *', 'uint32', 'void *', 'uint32', koffi.out(koffi.pointer('uint32')), 'void *']);
  const CloseHandle = k32.func('__stdcall', 'CloseHandle', 'int', ['intptr_t']);
  const GetLastError = k32.func('__stdcall', 'GetLastError', 'uint32', []);
  const SetupDiGetClassDevsW = sapi.func('__stdcall', 'SetupDiGetClassDevsW', 'intptr_t', ['void *', 'void *', 'intptr_t', 'uint32']);
  const SetupDiEnumDeviceInterfaces = sapi.func('__stdcall', 'SetupDiEnumDeviceInterfaces', 'int', ['intptr_t', 'void *', 'void *', 'uint32', 'void *']);
  const SetupDiGetDeviceInterfaceDetailW = sapi.func('__stdcall', 'SetupDiGetDeviceInterfaceDetailW', 'int', ['intptr_t', 'void *', 'void *', 'uint32', koffi.out(koffi.pointer('uint32')), 'void *']);
  const SetupDiDestroyDeviceInfoList = sapi.func('__stdcall', 'SetupDiDestroyDeviceInfoList', 'int', ['intptr_t']);
  let timeBeginPeriod = null;
  try { timeBeginPeriod = koffi.load('winmm.dll').func('__stdcall', 'timeBeginPeriod', 'uint32', ['uint32']); } catch (_) { /* coarse timers then */ }
  // XInput, loaded here with the same koffi (the child can't always find it the usual way).
  let xdll = null;
  for (const n of ['xinput1_4.dll', 'xinput1_3.dll', 'xinput9_1_0.dll']) { try { xdll = koffi.load(n); break; } catch (_) { /* next */ } }
  if (!xdll) throw new Error('XInput not found');
  const XPAD = koffi.struct('VP_XINPUT_GAMEPAD', { wButtons: 'uint16', bLeftTrigger: 'uint8', bRightTrigger: 'uint8', sThumbLX: 'int16', sThumbLY: 'int16', sThumbRX: 'int16', sThumbRY: 'int16' });
  const XSTATE = koffi.struct('VP_XINPUT_STATE', { dwPacketNumber: 'uint32', Gamepad: XPAD });
  const xi = { getState: xdll.func('__stdcall', 'XInputGetState', 'uint32', ['uint32', koffi.out(koffi.pointer(XSTATE))]) };

  const X64 = process.arch === 'x64' || process.arch === 'arm64';
  // {96E42B22-F5E9-42F8-B043-ED0F932F014F}: ViGEmBus
  const guid = Buffer.from([0x22, 0x2B, 0xE4, 0x96, 0xE9, 0xF5, 0xF8, 0x42, 0xB0, 0x43, 0xED, 0x0F, 0x93, 0x2F, 0x01, 0x4F]);
  const ctl = (fn, access) => ((0x2A << 16) | (access << 14) | (fn << 2)) >>> 0; // FILE_DEVICE_BUS_EXTENDER, METHOD_BUFFERED
  const IOCTL = {
    plug: ctl(0x801, 2), unplug: ctl(0x802, 2), version: ctl(0x803, 2), ready: ctl(0x804, 2),
    ds4: ctl(0x801 + 0x202, 2)
  };

  function busPath() {
    const set = SetupDiGetClassDevsW(guid, null, 0, 0x12); // DIGCF_PRESENT | DIGCF_DEVICEINTERFACE
    if (!set || set === -1) return null;
    try {
      const ifd = Buffer.alloc(X64 ? 32 : 28);
      ifd.writeUInt32LE(ifd.length, 0);
      for (let i = 0; i < 8; i++) {
        if (!SetupDiEnumDeviceInterfaces(set, null, guid, i, ifd)) return null;
        const need = [0];
        SetupDiGetDeviceInterfaceDetailW(set, ifd, null, 0, need, null);
        if (!need[0] || need[0] > 4096) continue;
        const det = Buffer.alloc(need[0]);
        det.writeUInt32LE(X64 ? 8 : 6, 0);
        if (!SetupDiGetDeviceInterfaceDetailW(set, ifd, det, need[0], need, null)) continue;
        return det.subarray(4).toString('utf16le').replace(/\0[\s\S]*$/, '');
      }
      return null;
    } finally { SetupDiDestroyDeviceInfoList(set); }
  }
  const io = (code, inBuf, outBuf) => {
    const got = [0];
    return !!DeviceIoControl(bus, code, inBuf, inBuf.length, outBuf || null, outBuf ? outBuf.length : 0, got, null);
  };
  function plug(sn) {
    const b = Buffer.alloc(16);
    b.writeUInt32LE(16, 0); b.writeUInt32LE(sn, 4); b.writeUInt32LE(2, 8); // DualShock4Wired
    b.writeUInt16LE(VPAD_VID, 12); b.writeUInt16LE(VPAD_PID, 14);
    if (!io(IOCTL.plug, b)) return false;
    const w = Buffer.alloc(8); w.writeUInt32LE(8, 0); w.writeUInt32LE(sn, 4);
    io(IOCTL.ready, w); // older drivers don't know this one: fine
    return true;
  }
  function unplug(sn) { const b = Buffer.alloc(8); b.writeUInt32LE(8, 0); b.writeUInt32LE(sn, 4); return io(IOCTL.unplug, b); }
  let reportSize = 20; // DS4_SUBMIT_REPORT as the driver measures it (18 if packed)
  function send(sn, rep) {
    const b = Buffer.alloc(reportSize);
    b.writeUInt32LE(reportSize, 0); b.writeUInt32LE(sn, 4); rep.copy(b, 8, 0, Math.min(rep.length, reportSize - 8));
    if (io(IOCTL.ds4, b)) return true;
    if (reportSize === 20) { reportSize = 18; return send(sn, rep); }
    return false;
  }
  api = { unplug, CloseHandle };

  const p = busPath();
  if (!p) { say({ error: 'ViGEmBus isn’t installed', code: 'nobus' }); process.exit(0); }
  bus = CreateFileW(p, 0xC0000000, 3, null, 3, 0x80, 0); // read/write, share read/write, OPEN_EXISTING
  if (!bus || bus === -1) { say({ error: 'Couldn’t open ViGEmBus (' + GetLastError() + ')', code: 'open' }); process.exit(0); }
  const v = Buffer.alloc(8); v.writeUInt32LE(8, 0); v.writeUInt32LE(1, 4);
  if (!io(IOCTL.version, v)) { say({ error: 'This ViGEmBus version doesn’t fit', code: 'version' }); process.exit(0); }
  if (timeBeginPeriod) { try { timeBeginPeriod(1); } catch (_) { /* ignore */ } }

  let players = [];      // real slot per player
  const serials = [];    // virtual controller per player
  const last = [];       // last report sent per player (hex), to send only changes
  const prevA = new Map(); // slot -> A held (a slot is in here while it's connected)
  let firstTick = true, lastPlayerA = 0;
  let lastSay = '';

  function setPlayers(list) {
    const want = Math.max(0, Math.min(4, list.length));
    while (serials.length < want) {
      let sn = 0;
      for (let s = 1; s <= 16 && !sn; s++) if (!plugged.includes(s) && plug(s)) sn = s;
      if (!sn) { say({ error: 'Couldn’t plug in virtual controller ' + (serials.length + 1), code: 'plug' }); break; }
      plugged.push(sn); serials.push(sn); last.push('');
    }
    players = list.slice(0, serials.length).map((s) => (Number.isInteger(s) ? s : null));
    say({ ready: true, players: serials.length });
  }

  function tick() {
    const live = new Set(), states = new Map(), aPressed = new Set(), appeared = new Set();
    for (let i = 0; i < 4; i++) {
      const st = {};
      let rc = 1;
      try { rc = xi.getState(i, st); } catch (_) { rc = 1; }
      if (rc !== 0) { prevA.delete(i); continue; }
      if (!prevA.has(i)) appeared.add(i);
      live.add(i); states.set(i, st.Gamepad);
      const a = !!(st.Gamepad.wButtons & 0x1000);
      if (a && !prevA.get(i)) aPressed.add(i);
      prevA.set(i, a);
    }
    // An A press right after a player's own A press is most likely an echo (Steam Input can make
    // a stand-in of a virtual controller): it never takes a spot.
    const t = Date.now();
    for (const s of aPressed) if (players.includes(s)) lastPlayerA = t;
    if (t - lastPlayerA < 200) for (const s of [...aPressed]) if (!players.includes(s)) aPressed.delete(s);
    if (players.length && !firstTick) players = reassign(players, live, appeared, aPressed);
    firstTick = false;
    for (let n = 0; n < serials.length; n++) {
      const s = players[n];
      const rep = ds4Report(s != null && live.has(s) ? states.get(s) : null);
      const hex = rep.toString('hex');
      if (hex !== last[n]) { if (send(serials[n], rep)) last[n] = hex; }
    }
    const now = JSON.stringify(players.map((s, n) => ({ p: n + 1, slot: s, on: s != null && live.has(s) })));
    if (now !== lastSay) { lastSay = now; say({ state: JSON.parse(now) }); }
  }

  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      let o = null; try { o = JSON.parse(l); } catch (_) { continue; }
      if (o && o.stop) quit();
      if (o && Array.isArray(o.players)) setPlayers(o.players);
    }
  });
  setInterval(tick, 4);
  say({ bus: true });
} catch (e) {
  say({ error: String(e && e.message || e).slice(0, 200), code: 'crash' });
  cleanup();
  process.exit(0);
}
