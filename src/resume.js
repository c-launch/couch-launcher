'use strict';
// "Pick up where you left off" for more emulators (Dolphin has its own, in main.js).
//  - RetroArch: its own auto save / auto load of a state, switched on for launcher games
//    (an extra settings file passed with --appendconfig, so your RetroArch settings stay as they are).
//  - DuckStation: "save state on exit" turned on in its settings; resuming starts it with -resume.
//  - PCSX2: "save state on shutdown" turned on; resuming passes that game's .resume.p2s file.
// After a game closes, the state it just saved is remembered for that game.

const fs = require('fs');
const path = require('path');

const SUPPORTED = ['retroarch', 'duckstation', 'pcsx2'];
const exists = (p) => { try { return !!p && fs.existsSync(p); } catch (_) { return false; } };
const listDir = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return []; } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } };

// Sets key = value in [section] of an .ini file (keeps everything else; one backup first).
function setIni(file, section, key, value) {
  const text = readText(file);
  if (text == null) return false;
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let inSec = false, secAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const h = /^\s*\[([^\]]+)\]\s*$/.exec(lines[i]);
    if (h) { inSec = h[1].trim().toLowerCase() === section.toLowerCase(); if (inSec) secAt = i; continue; }
    if (inSec) {
      const m = /^\s*([^=;#]+?)\s*=\s*(.*)$/.exec(lines[i]);
      if (m && m[1].toLowerCase() === key.toLowerCase()) {
        if (m[2].trim().toLowerCase() === String(value).toLowerCase()) return true;
        lines[i] = key + ' = ' + value;
        return write();
      }
    }
  }
  if (secAt >= 0) lines.splice(secAt + 1, 0, key + ' = ' + value);
  else { if (lines.length && lines[lines.length - 1] !== '') lines.push(''); lines.push('[' + section + ']', key + ' = ' + value); }
  return write();
  function write() {
    try {
      if (!exists(file + '.couch-original')) fs.copyFileSync(file, file + '.couch-original');
      fs.writeFileSync(file, lines.join(eol));
      return true;
    } catch (_) { return false; }
  }
}

function docs(env) { return path.join((env || process.env).USERPROFILE || '', 'Documents'); }
function duckBase(exe, env) {
  const dir = path.dirname(exe);
  if (exists(path.join(dir, 'portable.txt')) || exists(path.join(dir, 'settings.ini'))) return dir;
  return path.join(docs(env), 'DuckStation');
}
function pcsx2Base(exe, env) {
  const dir = path.dirname(exe);
  if (exists(path.join(dir, 'portable.ini')) || exists(path.join(dir, 'portable.txt')) || exists(path.join(dir, 'inis', 'PCSX2.ini'))) return dir;
  return path.join(docs(env), 'PCSX2');
}
// RetroArch's states folder (its setting, ":" meaning RetroArch's own folder).
function raStates(exe) {
  const dir = path.dirname(exe);
  const cfg = readText(path.join(dir, 'retroarch.cfg')) || '';
  const m = /^\s*savestate_directory\s*=\s*"([^"]*)"/m.exec(cfg);
  let v = m ? m[1] : '';
  if (!v || v === 'default') return path.join(dir, 'states');
  if (v.startsWith(':')) return path.join(dir, ...v.slice(1).split(/[\\/]+/).filter(Boolean));
  return v;
}
// Newest file under dir (2 levels) whose name passes test and that changed after `since`.
function newest(dir, test, since) {
  let best = null;
  (function go(d, depth) {
    if (depth > 2) return;
    for (const ent of listDir(d)) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) { go(full, depth + 1); continue; }
      if (!test(ent.name)) continue;
      let m = 0;
      try { m = fs.statSync(full).mtimeMs; } catch (_) { continue; }
      if (m >= since && (!best || m > best.m)) best = { file: full, m };
    }
  })(dir, 0);
  return best;
}

function createResume({ userDataDir, env }) {
  const file = path.join(userDataDir, 'resume.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) { return {}; } };
  const write = (all) => { try { fs.mkdirSync(userDataDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(all)); } catch (_) { /* not critical */ } };

  // Turns on the emulator's own "save a state when closing" (once; quick when already on).
  function prepare(emu, exe) {
    if (!exe) return false;
    if (emu === 'duckstation') return setIni(path.join(duckBase(exe, env), 'settings.ini'), 'Main', 'SaveStateOnExit', 'true');
    if (emu === 'pcsx2') return setIni(path.join(pcsx2Base(exe, env), 'inis', 'PCSX2.ini'), 'EmuCore', 'SaveStateOnShutdown', 'true');
    return emu === 'retroarch';
  }
  function raConfig(load) {
    const f = path.join(userDataDir, 'retroarch-' + (load ? 'resume' : 'fresh') + '.cfg');
    try { fs.mkdirSync(userDataDir, { recursive: true }); fs.writeFileSync(f, 'savestate_auto_save = "true"\nsavestate_auto_load = "' + (load ? 'true' : 'false') + '"\n'); } catch (_) { /* fine */ }
    return f;
  }
  // Extra start options: resume when asked, otherwise start fresh (the state is still saved on exit).
  function args(emu, gameId, wantResume) {
    if (emu === 'retroarch') return ['--appendconfig', raConfig(!!wantResume)];
    const s = has(gameId);
    if (!wantResume || !s) return [];
    if (emu === 'duckstation') return ['-resume'];
    if (emu === 'pcsx2') return ['-statefile', s.file];
    return [];
  }
  // After the game closed: remember the state it saved.
  function recordAfter(emu, exe, gameId, launch, startedAt) {
    if (!exe || !SUPPORTED.includes(emu)) return null;
    const since = (startedAt || 0) - 2000;
    let hit = null;
    if (emu === 'duckstation') hit = newest(path.join(duckBase(exe, env), 'savestates'), (n) => /resume/i.test(n), since);
    else if (emu === 'pcsx2') hit = newest(path.join(pcsx2Base(exe, env), 'sstates'), (n) => /\.resume\.p2s$/i.test(n), since);
    else if (emu === 'retroarch' && launch && launch.file) {
      const base = path.basename(launch.file).replace(/\.[^.]+$/, '').toLowerCase();
      hit = newest(raStates(exe), (n) => n.toLowerCase() === base + '.state.auto', since);
    }
    if (!hit) return null;
    const all = read();
    all[gameId] = { file: hit.file, at: Date.now(), emu };
    write(all);
    return all[gameId];
  }
  function has(gameId) {
    const s = read()[gameId];
    return s && s.file && exists(s.file) ? s : null;
  }
  return { supported: (emu) => SUPPORTED.includes(emu), prepare, args, recordAfter, has };
}

module.exports = { createResume, setIni, SUPPORTED };
