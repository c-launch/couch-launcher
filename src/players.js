'use strict';
// "Press A to join": puts the controllers your friends picked into Player 1-4 of each emulator,
// before the game starts. Works with Xbox-style (XInput) controllers, identified by their slot
// (Windows numbers them 1-4 in the order they connected).
//
// Every edit keeps a backup next to the file (<name>.couch-original the first time,
// <name>.couch-backup each time), and only changes which controller each player uses: your
// button layout stays as you set it in the emulator.

const fs = require('fs');
const path = require('path');

const exists = (p) => { try { return !!p && fs.existsSync(p); } catch (_) { return false; } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } };

function backup(file) {
  try {
    if (!exists(file + '.couch-original')) fs.copyFileSync(file, file + '.couch-original');
    fs.copyFileSync(file, file + '.couch-backup');
  } catch (_) { /* best effort */ }
}
function writeSafe(file, text) {
  backup(file);
  fs.writeFileSync(file + '.couch-tmp', text);
  fs.renameSync(file + '.couch-tmp', file);
}

// ---------------------------------------------------------------- Ryujinx
// Config.json › input_config: one entry per player. Xbox-style controllers all share one SDL
// "GUID"; the number before it ("0-", "1-") is which of them it is, in slot order.
function ryujinxConfigPath(exe, env) {
  const dir = exe ? path.dirname(exe) : '';
  const portable = path.join(dir, 'portable', 'Config.json');
  if (dir && exists(portable)) return portable;
  const appdata = path.join((env || process.env).APPDATA || '', 'Ryujinx', 'Config.json');
  return exists(appdata) ? appdata : null;
}

function setRyujinxPlayers(file, slots, connected) {
  const text = readText(file);
  if (!text) throw new Error('Ryujinx settings not found');
  const crlf = text.includes('\r\n');
  const cfg = JSON.parse(text);
  const list = Array.isArray(cfg.input_config) ? cfg.input_config : [];
  // Your current controller setup is the template (Player 1's, if it's a controller).
  const isPad = (e) => e && /^GamepadSDL/i.test(String(e.backend || '')) && /^\d+-/.test(String(e.id || ''));
  const template = list.find((e) => isPad(e) && e.player_index === 'Player1') || list.find(isPad);
  if (!template) throw new Error('Set up Player 1 with a controller in Ryujinx once (Options › Settings › Input), then try again');
  const guid = String(template.id).replace(/^\d+-/, '');
  const order = connected.slice().sort((a, b) => a - b); // SDL lists Xbox-style pads in slot order
  // A controller that isn't connected any more is left out.
  const players = slots.filter((slot) => order.includes(slot)).map((slot, i) => ({ n: i + 1, rank: order.indexOf(slot) }));
  if (!players.length) throw new Error('None of those controllers are connected');
  const taken = new Set(players.map((p) => 'Player' + p.n));
  // Keep other players' setups (keyboard, handheld, other controller types); replace the rest.
  const keep = list.filter((e) => !taken.has(e.player_index) && !(isPad(e) && String(e.id).replace(/^\d+-/, '') === guid));
  const made = players.map((p) => Object.assign(JSON.parse(JSON.stringify(template)), {
    id: p.rank + '-' + guid,
    name: String(template.name || 'Controller').replace(/\(\d+\)\s*$/, '').trim() + ' (' + p.rank + ')',
    player_index: 'Player' + p.n
  }));
  cfg.input_config = made.concat(keep);
  let out = JSON.stringify(cfg, null, 2);
  if (crlf) out = out.replace(/\n/g, '\r\n');
  writeSafe(file, out);
  return players.length;
}

// Controller profiles "Player 1" ... "Player 4", copies of your setup, to load by hand in
// Ryujinx's input settings. Made once; existing files are left alone.
function makeRyujinxProfiles(file) {
  const cfg = JSON.parse(readText(file) || '{}');
  const list = Array.isArray(cfg.input_config) ? cfg.input_config : [];
  const template = list.find((e) => /^GamepadSDL/i.test(String(e.backend || '')) && e.player_index === 'Player1') || list.find((e) => /^GamepadSDL/i.test(String(e.backend || '')));
  if (!template) return 0;
  const dir = path.join(path.dirname(file), 'profiles', 'controller');
  fs.mkdirSync(dir, { recursive: true });
  let made = 0;
  for (let n = 1; n <= 4; n++) {
    const f = path.join(dir, 'Player ' + n + '.json');
    if (exists(f)) continue;
    const p = JSON.parse(JSON.stringify(template));
    p.player_index = 'Player' + n;
    fs.writeFileSync(f, JSON.stringify(p, null, 2));
    made++;
  }
  return made;
}

// ---------------------------------------------------------------- Dolphin
// GCPadNew.ini / WiimoteNew.ini: [GCPad1] … Device = XInput/0/Gamepad
// Same order Dolphin uses: portable.txt next to the program, then Documents, then AppData;
// a "User" folder next to the program without portable.txt only as a last resort.
function dolphinUserDir(exe, env) {
  env = env || process.env;
  const dir = exe ? path.dirname(exe) : '';
  if (dir && exists(path.join(dir, 'portable.txt'))) return path.join(dir, 'User');
  for (const d of [path.join(env.USERPROFILE || '', 'Documents', 'Dolphin Emulator'), path.join(env.APPDATA || '', 'Dolphin Emulator')]) if (exists(path.join(d, 'Config'))) return d;
  if (dir && exists(path.join(dir, 'User', 'Config'))) return path.join(dir, 'User');
  return null;
}

function iniSections(text) {
  const out = [];
  let cur = { name: null, lines: [] };
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (m) { out.push(cur); cur = { name: m[1], lines: [line] }; } else cur.lines.push(line);
  }
  out.push(cur);
  return out;
}
const deviceOf = (sec) => { const l = sec.lines.find((x) => /^\s*Device\s*=/.test(x)); return l ? l.split('=').slice(1).join('=').trim() : ''; };

function setDolphinFile(file, prefix, slots) {
  const text = readText(file);
  if (!text) return 0;
  const crlf = text.includes('\r\n');
  const secs = iniSections(text);
  const first = secs.find((s) => s.name === prefix + '1');
  if (!first || !/^XInput\//i.test(deviceOf(first))) return 0; // only Xbox-style setups
  let n = 0;
  slots.forEach((slot, i) => {
    const name = prefix + (i + 1);
    let sec = secs.find((s) => s.name === name);
    if (!sec || !/^XInput\//i.test(deviceOf(sec))) {
      // A player without a controller setup gets a copy of Player 1's.
      const copy = { name, lines: first.lines.map((l, j) => (j === 0 ? '[' + name + ']' : l)) };
      if (sec) secs.splice(secs.indexOf(sec), 1, copy); else secs.push(copy);
      sec = copy;
    }
    sec.lines = sec.lines.map((l) => (/^\s*Device\s*=/.test(l) ? 'Device = XInput/' + slot + '/Gamepad' : l));
    // Wii Remotes: make sure this player's remote is the emulated one, connected.
    if (prefix === 'Wiimote') {
      if (sec.lines.some((l) => /^\s*Source\s*=/.test(l))) sec.lines = sec.lines.map((l) => (/^\s*Source\s*=/.test(l) ? 'Source = 1' : l));
      else sec.lines.splice(1, 0, 'Source = 1');
    }
    n++;
  });
  // Players past this session's count lose their controller, so one pad never drives two players.
  for (let i = slots.length + 1; i <= 4; i++) {
    const sec = secs.find((x) => x.name === prefix + i);
    if (!sec || !/^XInput\//i.test(deviceOf(sec))) continue;
    sec.lines = sec.lines.map((l) => (/^\s*Device\s*=/.test(l) ? 'Device = ' : (prefix === 'Wiimote' && /^\s*Source\s*=/.test(l)) ? 'Source = 0' : l));
  }
  let out = secs.filter((s) => s.name !== null || s.lines.length).map((s) => s.lines.join('\n')).join('\n');
  if (crlf) out = out.replace(/\n/g, '\r\n');
  writeSafe(file, out);
  return n;
}

function setDolphinPlayers(userDir, slots) {
  const cfg = path.join(userDir, 'Config');
  const pads = setDolphinFile(path.join(cfg, 'GCPadNew.ini'), 'GCPad', slots);
  const motes = setDolphinFile(path.join(cfg, 'WiimoteNew.ini'), 'Wiimote', slots);
  if (!pads && !motes) throw new Error('Set up Player 1 with an Xbox-style controller (XInput) in Dolphin once, then try again');
  return Math.max(pads, motes);
}

// ---------------------------------------------------------------- RPCS3
// config/input_configs/global/Default.yml: "Player 1 Input:" blocks with Handler: XInput and
// Device: XInput Pad #1 (slot + 1).
function rpcs3InputFile(exe) {
  const dir = exe ? path.dirname(exe) : '';
  for (const f of [path.join(dir, 'config', 'input_configs', 'global', 'Default.yml'), path.join(dir, 'input_configs', 'global', 'Default.yml')]) if (exists(f)) return f;
  return null;
}

function setRpcs3Players(file, slots) {
  const text = readText(file);
  if (!text) throw new Error('RPCS3 controller settings not found');
  const crlf = text.includes('\r\n');
  const lines = text.split(/\r?\n/);
  // Split into top-level blocks.
  const blocks = [];
  let cur = null;
  for (const l of lines) {
    if (/^\S/.test(l)) { cur = { head: l, body: [] }; blocks.push(cur); } else if (cur) cur.body.push(l); else blocks.push({ head: null, body: [l] });
  }
  const find = (n) => blocks.find((b) => b.head && new RegExp('^Player ' + n + ' Input:').test(b.head));
  const handler = (b) => { const l = b && b.body.find((x) => /^\s+Handler:/.test(x)); return l ? l.split(':').slice(1).join(':').trim() : ''; };
  const p1 = find(1);
  if (!p1 || !/^XInput$/i.test(handler(p1))) throw new Error('Set up Player 1 with an Xbox-style controller (XInput handler) in RPCS3 once, then try again');
  let n = 0;
  slots.forEach((slot, i) => {
    let b = find(i + 1);
    if (!b) { b = { head: 'Player ' + (i + 1) + ' Input:', body: [] }; blocks.push(b); }
    if (!/^XInput$/i.test(handler(b))) b.body = p1.body.slice(); // copy Player 1's setup
    let done = false;
    b.body = b.body.map((l) => {
      // Quoted: in YAML " #" would otherwise start a comment.
      if (!done && /^\s{2}Device:/.test(l)) { done = true; return l.replace(/Device:.*$/, 'Device: "XInput Pad #' + (slot + 1) + '"'); }
      return l;
    });
    n++;
  });
  // Players past this session's count: no controller.
  for (let i = slots.length + 1; i <= 7; i++) {
    const b = find(i);
    if (!b || !/^XInput$/i.test(handler(b))) continue;
    b.body = b.body.map((l) => (/^\s{2}Handler:/.test(l) ? '  Handler: "Null"' : /^\s{2}Device:/.test(l) ? '  Device: "Null"' : l));
  }
  let out = blocks.map((b) => (b.head !== null ? [b.head].concat(b.body) : b.body).join('\n')).join('\n');
  if (crlf) out = out.replace(/\n/g, '\r\n');
  writeSafe(file, out);
  return n;
}

// slots: XInput slot for Player 1, 2, ... ; connected: all connected XInput slots.
function setPlayers(emu, exe, slots, connected, env) {
  if (!Array.isArray(slots) || !slots.length || slots.length > 4) throw new Error('Pick 1 to 4 players');
  if (emu === 'ryujinx') {
    const f = ryujinxConfigPath(exe, env);
    if (!f) throw new Error('Ryujinx settings not found (start Ryujinx once first)');
    const n = setRyujinxPlayers(f, slots, connected);
    makeRyujinxProfiles(f);
    return n;
  }
  if (emu === 'dolphin') {
    const d = dolphinUserDir(exe, env);
    if (!d) throw new Error('Dolphin settings not found (start Dolphin once first)');
    return setDolphinPlayers(d, slots);
  }
  if (emu === 'rpcs3') {
    const f = rpcs3InputFile(exe);
    if (!f) throw new Error('RPCS3 controller settings not found (set up a controller in RPCS3 once)');
    return setRpcs3Players(f, slots);
  }
  throw new Error('Unknown emulator');
}

module.exports = { setPlayers, setRyujinxPlayers, makeRyujinxProfiles, setDolphinFile, setRpcs3Players, ryujinxConfigPath, dolphinUserDir, rpcs3InputFile };
