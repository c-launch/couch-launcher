'use strict';
// A small separate process (Couch Launcher in Node mode) that reads Xbox controllers through
// Windows' Raw Input with "input sink" turned on, so it keeps getting the controller's Bluetooth
// data while a game is in front. Windows only gives that data to the app in front when it's
// read directly, which is why Share did nothing during games.
// It runs on its own because a process can only take Raw Input for game pads once, and the
// launcher's own window uses it for the controller in its menus.
//
// Output, one JSON line each: { ready: true } | { error } | { d, pid, size, b: 'hex' } when a
// controller's report changes | { n } (reports so far, about once a second while they come in).

const say = (o) => { try { process.stdout.write(JSON.stringify(o) + '\n'); } catch (_) { /* parent gone */ } };
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();

try {
  const koffi = require(process.env.COUCH_KOFFI || 'koffi');
  const u = koffi.load('user32.dll');
  const POINT = koffi.struct('RP_POINT', { x: 'int32', y: 'int32' });
  const MSG = koffi.struct('RP_MSG', { hwnd: 'intptr_t', message: 'uint32', wParam: 'uintptr_t', lParam: 'intptr_t', time: 'uint32', pt: POINT, lPrivate: 'uint32' });
  const RID = koffi.struct('RP_RAWINPUTDEVICE', { usUsagePage: 'uint16', usUsage: 'uint16', dwFlags: 'uint32', hwndTarget: 'intptr_t' });
  const CreateWindowExW = u.func('__stdcall', 'CreateWindowExW', 'intptr_t', ['uint32', 'str16', 'str16', 'uint32', 'int', 'int', 'int', 'int', 'intptr_t', 'intptr_t', 'intptr_t', 'intptr_t']);
  const RegisterRawInputDevices = u.func('__stdcall', 'RegisterRawInputDevices', 'int', [koffi.pointer(RID), 'uint32', 'uint32']);
  const PeekMessageW = u.func('__stdcall', 'PeekMessageW', 'int', [koffi.out(koffi.pointer(MSG)), 'intptr_t', 'uint32', 'uint32', 'uint32']);
  const DispatchMessageW = u.func('__stdcall', 'DispatchMessageW', 'intptr_t', [koffi.pointer(MSG)]);
  const GetRawInputData = u.func('__stdcall', 'GetRawInputData', 'uint32', ['intptr_t', 'uint32', 'void *', koffi.inout(koffi.pointer('uint32')), 'uint32']);
  const GetRawInputDeviceInfoW = u.func('__stdcall', 'GetRawInputDeviceInfoW', 'uint32', ['intptr_t', 'uint32', 'void *', koffi.inout(koffi.pointer('uint32'))]);

  const WM_INPUT = 0x00FF, PM_REMOVE = 1, RID_INPUT = 0x10000003, RIDI_DEVICENAME = 0x20000007;
  const RIM_TYPEHID = 2, RIDEV_INPUTSINK = 0x00000100;
  const X64 = process.arch === 'x64' || process.arch === 'arm64';
  const HEADER = X64 ? 24 : 16; // RAWINPUTHEADER: dwType, dwSize, hDevice, wParam

  // A hidden window to receive the input (never shown).
  const hwnd = CreateWindowExW(0, 'STATIC', 'Couch Launcher controller reader', 0, 0, 0, 0, 0, 0, 0, 0, 0);
  if (!hwnd) throw new Error('Couldn’t make the reader window');
  // Generic Desktop › Game Pad (Xbox controllers over Bluetooth) and Joystick.
  const okPad = RegisterRawInputDevices({ usUsagePage: 1, usUsage: 5, dwFlags: RIDEV_INPUTSINK, hwndTarget: hwnd }, 1, koffi.sizeof(RID));
  const okStick = RegisterRawInputDevices({ usUsagePage: 1, usUsage: 4, dwFlags: RIDEV_INPUTSINK, hwndTarget: hwnd }, 1, koffi.sizeof(RID));
  if (!okPad && !okStick) throw new Error('Windows didn’t allow reading controllers in the background');

  const devices = new Map(); // hDevice -> { i, pid } (or null: not an Xbox controller)
  let nextIndex = 0;
  function deviceOf(h) {
    const key = String(h);
    if (devices.has(key)) return devices.get(key);
    let info = null;
    try {
      const size = [0];
      GetRawInputDeviceInfoW(h, RIDI_DEVICENAME, null, size);
      if (size[0] > 0 && size[0] < 2048) {
        const buf = Buffer.alloc(size[0] * 2);
        const got = GetRawInputDeviceInfoW(h, RIDI_DEVICENAME, buf, size);
        if (got > 0 && got !== 0xFFFFFFFF) {
          const name = buf.toString('utf16le').replace(/\0[\s\S]*$/, '');
          const m = /VID_045E&PID_([0-9A-F]{4})/i.exec(name);
          if (m) info = { i: nextIndex++, pid: parseInt(m[1], 16) };
        }
      }
    } catch (_) { info = null; }
    devices.set(key, info);
    return info;
  }

  const last = new Map();
  let reports = 0, told = 0, buf = Buffer.alloc(256);
  function onInput(lParam) {
    const size = [0];
    if (GetRawInputData(lParam, RID_INPUT, null, size, HEADER) !== 0 || !size[0] || size[0] > 4096) return;
    if (buf.length < size[0]) buf = Buffer.alloc(size[0]);
    const got = GetRawInputData(lParam, RID_INPUT, buf, size, HEADER);
    if (got === 0xFFFFFFFF || got < HEADER + 8) return;
    if (buf.readUInt32LE(0) !== RIM_TYPEHID) return;
    const h = X64 ? Number(buf.readBigUInt64LE(8)) : buf.readUInt32LE(8);
    const dev = deviceOf(h);
    if (!dev) return;
    const each = buf.readUInt32LE(HEADER), count = buf.readUInt32LE(HEADER + 4);
    if (!each || each > 128 || HEADER + 8 + each * count > got) return;
    for (let k = 0; k < count; k++) {
      reports++;
      const hex = buf.toString('hex', HEADER + 8 + k * each, HEADER + 8 + (k + 1) * each);
      if (last.get(dev.i) === hex) continue;
      last.set(dev.i, hex);
      say({ d: dev.i, pid: dev.pid, size: each, b: hex });
    }
  }

  const msg = {};
  setInterval(() => {
    for (let k = 0; k < 200 && PeekMessageW(msg, 0, 0, 0, PM_REMOVE); k++) {
      if (msg.message === WM_INPUT) { try { onInput(msg.lParam); } catch (_) { /* skip this one */ } }
      DispatchMessageW(msg);
    }
  }, 8);
  setInterval(() => { if (reports !== told) { told = reports; say({ n: reports }); } }, 1000);
  say({ ready: true, pad: !!okPad, stick: !!okStick });
} catch (e) {
  say({ error: String((e && e.message) || e) });
  setTimeout(() => process.exit(1), 50);
}
