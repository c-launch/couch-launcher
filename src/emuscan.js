'use strict';
// Finds games for the catalog emulators (emucatalog.js).
//  - Files: every game file in the emulator's folders. One tile per game: a multi-disc game is
//    one tile (its .m3u when there is one, otherwise disc 1), .bin files that belong to a .cue
//    are left out, and the same game in several regions is one tile (USA, then World, Europe,
//    Japan) with the other versions kept so you can switch in the game's menu.
//  - Vita3K: games installed in Vita3K (title from each game's param.sfo).
//  - shadPS4: game folders with eboot.bin (from your folders and shadPS4's own list).
//  - ScummVM: the games you've added in ScummVM, else each folder in your ScummVM folder.
//  - MAME: ROM sets, with their real names from MAME itself.
//  - RetroArch: each system folder whose core is installed.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { CATALOG, RETRO_SYSTEMS } = require('./emucatalog');

const exists = (p) => { try { return !!p && fs.existsSync(p); } catch (_) { return false; } };
const listDir = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return []; } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } };
const dirsOf = (v) => String(v || '').split(';').map((s) => s.trim()).filter(Boolean);

function cleanTitle(fileName) {
  let t = fileName.replace(/\.[^.\\/]+$/, '');
  t = t.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');
  t = t.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t || fileName;
}
const DISC = /[\s_-]*[([]\s*(disc|disk|cd|side)\s*([0-9]+|[a-d])(\s*of\s*\d+)?\s*[)\]]/i;
const REGIONS = [['usa', /\((usa|us|u|america)[,)\s]/i], ['world', /\((world|w)[,)\s]/i], ['europe', /\((europe|eur|e|uk|en)[,)\s]/i], ['japan', /\((japan|jpn|j)[,)\s]/i]];
function regionOf(name) { for (const [r, re] of REGIONS) if (re.test(name + ' ')) return r; return null; }
const regionRank = (r) => (r ? ['usa', 'world', 'europe', 'japan'].indexOf(r) : 4);
const BIOS = /(^|[\s_(\[-])(bios|scph[-_ ]?\d{3,5}|ps2-\d+|syscard|\[bios\])/i;

function walk(root, exts, maxDepth) {
  const out = [];
  const want = new Set(exts.map((e) => e.toLowerCase()));
  (function go(dir, d) {
    if (d > maxDepth || out.length > 20000) return;
    for (const ent of listDir(dir)) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (!/^(bios|saves?|states?|media|images|videos|manuals|downloaded_media|\.)/i.test(ent.name)) go(full, d + 1); }
      else if (ent.isFile() && want.has(path.extname(ent.name).toLowerCase())) out.push(full);
    }
  })(root, 0);
  return out;
}
function isSwitchExtra(file) {
  const name = path.basename(file);
  const id = (/\[(0100[0-9A-Fa-f]{12})\]/.exec(name) || /\b(0100[0-9A-Fa-f]{12})\b/.exec(name) || [])[1];
  if (id) return !/000$/.test(id);
  return /[[(\s_-](update|upd|dlc|patch)[\])\s_.-]/i.test(name) || /\[v[1-9]\d*\]/i.test(name);
}

// Game files -> one entry per game.
function groupFiles(files) {
  const byDir = new Map();
  for (const f of files) { const d = path.dirname(f).toLowerCase(); if (!byDir.has(d)) byDir.set(d, []); byDir.get(d).push(f); }
  const keep = [];
  for (const list of byDir.values()) {
    const names = new Set(list.map((f) => path.basename(f).toLowerCase()));
    const skip = new Set();
    // files listed in an .m3u, and the .bin / .img files of a .cue, belong to that game
    for (const f of list) {
      const ext = path.extname(f).toLowerCase();
      if (ext === '.m3u' || ext === '.cue' || ext === '.gdi') {
        const text = readText(f) || '';
        const refs = ext === '.m3u' ? text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
          : [...text.matchAll(/FILE\s+"([^"]+)"/gi)].map((m) => m[1]).concat(ext === '.gdi' ? [...text.matchAll(/\s"?([^\s"]+\.(bin|raw))"?\s/gi)].map((m) => m[1]) : []);
        for (const r of refs) skip.add(path.basename(r).toLowerCase());
      }
    }
    const hasCue = [...names].some((n) => n.endsWith('.cue'));
    for (const f of list) {
      const n = path.basename(f).toLowerCase();
      if (skip.has(n) || BIOS.test(path.basename(f))) continue;
      if (hasCue && /\.(bin|img)$/.test(n)) continue;
      keep.push(f);
    }
  }
  // Same game: same clean title in the same system folder (discs and regions folded together)
  const games = new Map();
  for (const f of keep) {
    const base = path.basename(f);
    const disc = DISC.exec(base);
    const title = cleanTitle(base.replace(DISC, ''));
    const k = path.dirname(path.dirname(f)).toLowerCase() + '|' + title.toLowerCase();
    if (!games.has(k)) games.set(k, { title, files: [] });
    games.get(k).files.push({ file: f, region: regionOf(base), disc: disc ? disc[2] : null, m3u: /\.m3u$/i.test(f) });
  }
  const out = [];
  for (const g of games.values()) {
    const versions = new Map(); // region -> best file for that region
    for (const v of g.files) {
      const cur = versions.get(v.region || '');
      const better = !cur || (v.m3u && !cur.m3u) || (!cur.m3u && v.disc != null && cur.disc != null && String(v.disc) < String(cur.disc)) || (!cur.m3u && cur.disc != null && v.disc == null);
      if (better) versions.set(v.region || '', v);
    }
    const sorted = [...versions.values()].sort((a, b) => regionRank(a.region) - regionRank(b.region));
    const main = sorted[0];
    out.push({ title: g.title, file: main.file, alts: sorted.length > 1 ? sorted.map((v) => ({ file: v.file, region: v.region || 'other' })) : null });
  }
  return out;
}
function entry(id, title, file, extra) {
  return {
    key: id + ':' + String((extra && extra.titleId) || file).toLowerCase(),
    source: id,
    title,
    launch: Object.assign({ type: 'emu', emu: id, file }, extra || {}),
    art: {}
  };
}
function scanFiles(id, cfg) {
  const e = CATALOG[id];
  const dirs = dirsOf(cfg.dir).filter(exists);
  let files = [].concat(...dirs.map((d) => walk(d, e.exts, 4)));
  if (e.switchFilter) files = files.filter((f) => !isSwitchExtra(f));
  return groupFiles(files).map((g) => entry(id, g.title, g.file, g.alts ? { alts: g.alts } : null));
}

// PS Vita / PS4 param.sfo: the game's name and title ID
function readSfo(file) {
  let b;
  try { b = fs.readFileSync(file); } catch (_) { return null; }
  if (b.length < 20 || b.readUInt32LE(0) !== 0x46535000) return null;
  const keyTable = b.readUInt32LE(8), dataTable = b.readUInt32LE(12), n = b.readUInt32LE(16);
  const out = {};
  for (let i = 0; i < n && 20 + i * 16 + 16 <= b.length; i++) {
    const at = 20 + i * 16;
    const keyOff = b.readUInt16LE(at), fmt = b.readUInt16LE(at + 2), len = b.readUInt32LE(at + 4), dataOff = b.readUInt32LE(at + 12);
    let ke = keyTable + keyOff; while (ke < b.length && b[ke]) ke++;
    const key = b.toString('utf8', keyTable + keyOff, ke);
    const start = dataTable + dataOff;
    if (fmt === 0x0204 || fmt === 0x0004) out[key] = b.toString('utf8', start, Math.min(b.length, start + len)).replace(/\0+$/, '');
  }
  return out;
}
function scanVita3k(cfg, env) {
  env = env || process.env;
  const bases = [];
  if (cfg.exe) bases.push(path.join(path.dirname(cfg.exe), 'ux0'));
  bases.push(path.join(env.APPDATA || '', 'Vita3K', 'Vita3K', 'ux0'));
  // config.yml can point somewhere else (pref-path)
  for (const c of [cfg.exe && path.join(path.dirname(cfg.exe), 'config.yml'), path.join(env.APPDATA || '', 'Vita3K', 'Vita3K', 'config.yml')]) {
    const m = /pref-path:\s*['"]?([^'"\r\n]+)/.exec(readText(c) || '');
    if (m) bases.unshift(path.join(m[1].trim(), 'ux0'));
  }
  const out = [];
  const seen = new Set();
  for (const ux0 of bases) {
    for (const ent of listDir(path.join(ux0, 'app'))) {
      if (!ent.isDirectory() || seen.has(ent.name)) continue;
      const appDir = path.join(ux0, 'app', ent.name);
      const sfo = readSfo(path.join(appDir, 'sce_sys', 'param.sfo')) || {};
      seen.add(ent.name);
      out.push(entry('vita3k', sfo.STITLE || sfo.TITLE || ent.name, appDir, { titleId: ent.name }));
    }
  }
  return out;
}
function scanPs4(cfg, env) {
  env = env || process.env;
  const dirs = dirsOf(cfg.dir);
  const conf = readText(path.join(env.APPDATA || '', 'shadPS4', 'config.toml')) || (cfg.exe ? readText(path.join(path.dirname(cfg.exe), 'user', 'config.toml')) : null) || '';
  for (const m of conf.matchAll(/"([A-Za-z]:[\\/][^"]+)"/g)) dirs.push(m[1].replace(/\\\\/g, '\\'));
  const out = [], seen = new Set();
  for (const d of dirs.filter(exists)) {
    (function go(dir, depth) {
      if (depth > 3) return;
      if (exists(path.join(dir, 'eboot.bin')) && exists(path.join(dir, 'sce_sys', 'param.sfo'))) {
        if (seen.has(dir.toLowerCase())) return;
        seen.add(dir.toLowerCase());
        const sfo = readSfo(path.join(dir, 'sce_sys', 'param.sfo')) || {};
        out.push(entry('shadps4', sfo.TITLE || cleanTitle(path.basename(dir)), path.join(dir, 'eboot.bin')));
        return;
      }
      for (const ent of listDir(dir)) if (ent.isDirectory()) go(path.join(dir, ent.name), depth + 1);
    })(d, 0);
  }
  return out;
}
function scanScummvm(cfg, env) {
  env = env || process.env;
  const ini = readText(path.join(env.APPDATA || '', 'ScummVM', 'scummvm.ini')) || (env.HOME ? readText(path.join(env.HOME, 'Library', 'Preferences', 'ScummVM Preferences')) : null) || (cfg.exe ? readText(path.join(path.dirname(cfg.exe), 'scummvm.ini')) : null) || '';
  const out = [];
  let cur = null;
  for (const raw of ini.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) { cur = sec[1] === 'scummvm' ? null : { target: sec[1], description: '', path: '' }; if (cur) out.push(cur); continue; }
    if (!cur) continue;
    const kv = /^(description|path)=(.*)$/.exec(line);
    if (kv) cur[kv[1]] = kv[2].trim();
  }
  const games = out.filter((g) => g.path && exists(g.path)).map((g) => entry('scummvm', cleanTitle(g.description || g.target), g.path, { target: g.target }));
  if (games.length) return games;
  // Nothing added in ScummVM yet: each folder in your ScummVM folder is a game.
  const res = [];
  for (const d of dirsOf(cfg.dir).filter(exists)) for (const ent of listDir(d)) if (ent.isDirectory()) res.push(entry('scummvm', cleanTitle(ent.name), path.join(d, ent.name)));
  return res;
}
// MAME's own names for its ROM sets ("sf2" -> "Street Fighter II: The World Warrior").
function mameNames(exe) {
  try {
    const text = execFileSync(exe, ['-listfull'], { encoding: 'utf8', timeout: 30000, maxBuffer: 128 * 1024 * 1024, windowsHide: true, cwd: path.dirname(exe) });
    const map = new Map();
    for (const line of text.split(/\r?\n/)) { const m = /^(\S+)\s+"(.*)"\s*$/.exec(line); if (m) map.set(m[1].toLowerCase(), m[2]); }
    return map;
  } catch (_) { return new Map(); }
}
function scanMame(cfg, names) {
  const dirs = dirsOf(cfg.dir).filter(exists);
  const files = [].concat(...dirs.map((d) => walk(d, ['.zip', '.7z'], 0)));
  names = names || (cfg.exe ? mameNames(cfg.exe) : new Map());
  return files.map((f) => {
    const set = path.basename(f).replace(/\.(zip|7z)$/i, '').toLowerCase();
    const title = names.get(set);
    if (names.size && !title) return null; // not a game MAME knows (BIOS, sample packs, other sets)
    return entry('mame', title ? title.replace(/\s*\(.*\)\s*$/, '') : cleanTitle(path.basename(f)), f);
  }).filter(Boolean);
}
function retroCore(exe, sys) {
  const dir = path.join(path.dirname(exe), 'cores');
  for (const c of sys.cores) { const p = path.join(dir, c + '_libretro.dll'); if (exists(p)) return p; }
  return null;
}
function scanRetroarch(cfg) {
  if (!cfg.exe) return [];
  const out = [];
  // Your folders can be the system folders themselves or one folder holding them (Emulation\roms).
  const sysDirs = [];
  for (const d of dirsOf(cfg.dir).filter(exists)) {
    const own = RETRO_SYSTEMS.find((s) => s.dirs.includes(path.basename(d).toLowerCase()));
    if (own) { sysDirs.push([own, d]); continue; }
    for (const ent of listDir(d)) {
      if (!ent.isDirectory()) continue;
      const s = RETRO_SYSTEMS.find((x) => x.dirs.includes(ent.name.toLowerCase()));
      if (s) sysDirs.push([s, path.join(d, ent.name)]);
    }
  }
  for (const [sys, dir] of sysDirs) {
    const core = retroCore(cfg.exe, sys);
    if (!core) continue; // no core for this system installed in RetroArch
    for (const g of groupFiles(walk(dir, sys.exts, 3))) out.push(entry('retroarch', g.title, g.file, Object.assign({ core, system: sys.name }, g.alts ? { alts: g.alts } : null)));
  }
  return out;
}

function scanCatalog(id, cfg, opts) {
  const e = CATALOG[id];
  if (!e || !cfg || !cfg.exe) return [];
  opts = opts || {};
  switch (e.kind) {
    case 'vita3k': return scanVita3k(cfg, opts.env);
    case 'ps4': return scanPs4(cfg, opts.env);
    case 'scummvm': return scanScummvm(cfg, opts.env);
    case 'mame': return scanMame(cfg, opts.mameNames);
    case 'retroarch': return scanRetroarch(cfg);
    default: return scanFiles(id, cfg);
  }
}
// Emulators that find games without a games folder of their own.
const needsNoFolder = (id) => ['vita3k', 'shadps4', 'scummvm'].includes(id);

module.exports = { scanCatalog, groupFiles, readSfo, regionOf, needsNoFolder, retroCore };
