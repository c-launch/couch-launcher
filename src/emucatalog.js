'use strict';
// More emulators, kept in one list so the Platforms page stays small (they live on their own
// Emulators page). Each one says: the programs to look for, the systems it plays, its game
// files, the EmuDeck ROM folders, and how to start a game in full screen.
// Finding: EmuDeck, Program Files, %LOCALAPPDATA%\Programs, scoop, winget, common "Emulators"
// folders, and next to the emulators you already have.

const fs = require('fs');
const path = require('path');

const exists = (p) => { try { return !!p && fs.existsSync(p); } catch (_) { return false; } };
const listDir = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return []; } };

// RetroArch: one program, many systems. Cores are tried in this order (first one installed wins).
const RETRO_SYSTEMS = [
  { id: 'nes', name: 'NES', dirs: ['nes', 'famicom'], exts: ['.nes', '.fds', '.unf'], cores: ['mesen', 'nestopia', 'fceumm'] },
  { id: 'snes', name: 'SNES', dirs: ['snes', 'sfc', 'superfamicom'], exts: ['.sfc', '.smc', '.bs'], cores: ['snes9x', 'bsnes', 'bsnes_hd_beta', 'mesen-s'] },
  { id: 'n64', name: 'Nintendo 64', dirs: ['n64'], exts: ['.n64', '.z64', '.v64'], cores: ['mupen64plus_next', 'parallel_n64'] },
  { id: 'gb', name: 'Game Boy', dirs: ['gb', 'gameboy'], exts: ['.gb'], cores: ['gambatte', 'sameboy', 'mgba'] },
  { id: 'gbc', name: 'Game Boy Color', dirs: ['gbc'], exts: ['.gbc'], cores: ['gambatte', 'sameboy', 'mgba'] },
  { id: 'genesis', name: 'Genesis / Mega Drive', dirs: ['genesis', 'megadrive', 'md'], exts: ['.md', '.gen', '.smd', '.bin'], cores: ['genesis_plus_gx', 'picodrive'] },
  { id: 'sms', name: 'Master System', dirs: ['mastersystem', 'sms'], exts: ['.sms'], cores: ['genesis_plus_gx', 'picodrive'] },
  { id: 'gg', name: 'Game Gear', dirs: ['gamegear', 'gg'], exts: ['.gg'], cores: ['genesis_plus_gx'] },
  { id: 'segacd', name: 'Sega CD', dirs: ['segacd', 'megacd'], exts: ['.chd', '.cue', '.m3u'], cores: ['genesis_plus_gx', 'picodrive'] },
  { id: 'saturn', name: 'Saturn', dirs: ['saturn'], exts: ['.chd', '.cue', '.m3u'], cores: ['mednafen_saturn', 'yabasanshiro', 'kronos'] },
  { id: 'pce', name: 'PC Engine / TurboGrafx', dirs: ['pcengine', 'tg16', 'pcenginecd', 'tg-cd'], exts: ['.pce', '.chd', '.cue'], cores: ['mednafen_pce', 'mednafen_pce_fast'] },
  { id: 'atari2600', name: 'Atari 2600', dirs: ['atari2600'], exts: ['.a26', '.bin'], cores: ['stella', 'stella2014'] },
  { id: 'lynx', name: 'Atari Lynx', dirs: ['atarilynx', 'lynx'], exts: ['.lnx'], cores: ['handy', 'mednafen_lynx'] },
  { id: 'ngp', name: 'Neo Geo Pocket', dirs: ['ngp', 'ngpc'], exts: ['.ngp', '.ngc'], cores: ['mednafen_ngp'] },
  { id: 'wswan', name: 'WonderSwan', dirs: ['wonderswan', 'wonderswancolor', 'wswan', 'wswanc'], exts: ['.ws', '.wsc'], cores: ['mednafen_wswan'] },
  { id: 'vb', name: 'Virtual Boy', dirs: ['virtualboy', 'vb'], exts: ['.vb'], cores: ['mednafen_vb'] },
  { id: 'fbneo', name: 'Arcade (FinalBurn Neo)', dirs: ['fbneo', 'neogeo', 'cps1', 'cps2', 'cps3'], exts: ['.zip', '.7z'], cores: ['fbneo'] }
];

const CATALOG = {
  pcsx2: { name: 'PCSX2', system: 'PS2', color: '#33406B', exes: ['pcsx2-qt.exe', 'pcsx2.exe', 'pcsx2-qtx64-avx2.exe', 'pcsx2-qtx64.exe'],
    exts: ['.iso', '.chd', '.cso', '.zso', '.gz', '.bin', '.cue', '.m3u', '.elf'], dirs: ['ps2'],
    // -batch closes PCSX2 when the game stops, so you land back in the launcher
    args: (f) => ['-batch', '-nogui', '-fullscreen', '--', f] },
  duckstation: { name: 'DuckStation', system: 'PS1', color: '#4A4A52', exes: ['duckstation-qt-x64-releaseltcg.exe', 'duckstation-qt.exe', 'duckstation-qt-arm64-releaseltcg.exe', 'duckstation.exe'],
    exts: ['.chd', '.cue', '.m3u', '.pbp', '.ecm', '.mds', '.img', '.iso', '.exe', '.psexe'], dirs: ['psx', 'ps1', 'playstation'],
    args: (f) => ['-batch', '-fullscreen', '--', f] },
  ppsspp: { name: 'PPSSPP', system: 'PSP', color: '#2E4D63', exes: ['ppssppwindows64.exe', 'ppssppwindows.exe', 'ppsspp.exe'],
    exts: ['.iso', '.cso', '.chd', '.pbp', '.elf', '.prx'], dirs: ['psp'],
    args: (f) => ['--fullscreen', f] },
  vita3k: { name: 'Vita3K', system: 'PS Vita', color: '#2C3E66', exes: ['vita3k.exe'], kind: 'vita3k', exts: [], dirs: [],
    args: (f, L) => ['-F', '-r', L.titleId] },
  shadps4: { name: 'shadPS4', system: 'PS4 (early)', color: '#253A66', exes: ['shadps4.exe'], kind: 'ps4', exts: [], dirs: ['ps4'],
    args: (f) => ['-f', 'true', '-g', f] },
  cemu: { name: 'Cemu', system: 'Wii U', color: '#2E5E6E', exes: ['cemu.exe'],
    exts: ['.wua', '.wud', '.wux', '.rpx', '.elf'], dirs: ['wiiu'],
    args: (f) => ['-f', '-g', f] },
  yuzufork: { name: 'Eden / Citron / Sudachi', system: 'Switch', color: '#3C5A3A', exes: ['eden.exe', 'citron.exe', 'sudachi.exe', 'suyu.exe', 'torzu.exe', 'yuzu.exe'],
    exts: ['.nsp', '.xci', '.nca', '.nro', '.nso'], dirs: ['switch'], switchFilter: true,
    args: (f) => ['-f', '-g', f] },
  azahar: { name: 'Azahar', system: '3DS', color: '#5A3540', exes: ['azahar.exe', 'azahar-qt.exe', 'lime3ds.exe', 'lime3ds-gui.exe', 'citra-qt.exe', 'citra.exe'],
    exts: ['.3ds', '.cci', '.cxi', '.3dsx', '.app', '.z3dsx', '.zcci', '.zcxi'], dirs: ['n3ds', '3ds'],
    args: (f) => ['-f', f] },
  melonds: { name: 'melonDS', system: 'DS', color: '#4F4A3A', exes: ['melonds.exe'],
    exts: ['.nds', '.dsi', '.srl'], dirs: ['nds'],
    args: (f) => ['-f', f] },
  mgba: { name: 'mGBA', system: 'Game Boy Advance', color: '#4A3A5E', exes: ['mgba.exe'],
    exts: ['.gba', '.gb', '.gbc', '.sgb'], dirs: ['gba'],
    args: (f) => ['-f', f] },
  xenia: { name: 'Xenia Canary', system: 'Xbox 360', color: '#2F5A36', exes: ['xenia_canary.exe', 'xenia.exe'],
    exts: ['.iso', '.xex', '.zar'], dirs: ['xbox360', 'x360'],
    args: (f) => ['--fullscreen=true', f] },
  xemu: { name: 'xemu', system: 'Xbox', color: '#35552F', exes: ['xemu.exe'],
    exts: ['.iso', '.xiso'], dirs: ['xbox'],
    args: (f) => ['-full-screen', '-dvd_path', f] },
  flycast: { name: 'Flycast', system: 'Dreamcast / NAOMI', color: '#5B4A2A', exes: ['flycast.exe'],
    exts: ['.chd', '.gdi', '.cdi', '.cue', '.m3u', '.zip', '.7z'], dirs: ['dreamcast', 'naomi', 'naomi2', 'atomiswave'],
    args: (f) => ['-config', 'window:fullscreen=yes', f] },
  redream: { name: 'Redream', system: 'Dreamcast', color: '#5B4A2A', exes: ['redream.exe'],
    exts: ['.chd', '.gdi', '.cdi', '.cue'], dirs: ['dreamcast'],
    args: (f) => [f] },
  retroarch: { name: 'RetroArch', system: 'Retro systems', color: '#4A4A4A', exes: ['retroarch.exe'], kind: 'retroarch', exts: [], dirs: [],
    args: (f, L) => ['-f', '-L', L.core, f] },
  mame: { name: 'MAME', system: 'Arcade', color: '#5A3A2A', exes: ['mame.exe', 'mame64.exe'], kind: 'mame', exts: ['.zip', '.7z', '.chd'], dirs: ['mame', 'arcade'],
    // MAME is full screen unless told otherwise; the ROM folder is passed so sets are found.
    args: (f) => ['-rompath', path.dirname(f), path.basename(f).replace(/\.(zip|7z)$/i, '')] },
  supermodel: { name: 'Supermodel', system: 'Sega Model 3', color: '#5A2A2A', exes: ['supermodel.exe'],
    exts: ['.zip'], dirs: ['model3'],
    args: (f) => [f, '-fullscreen'] },
  ares: { name: 'ares', system: 'Many systems', color: '#3A4A5A', exes: ['ares.exe'],
    exts: ['.nes', '.sfc', '.smc', '.n64', '.z64', '.v64', '.gb', '.gbc', '.gba', '.md', '.gen', '.sms', '.gg', '.pce', '.ws', '.wsc', '.ngp', '.ngc'], dirs: [],
    args: (f) => ['--fullscreen', f] },
  scummvm: { name: 'ScummVM', system: 'Classic adventure games', color: '#3A5A3A', exes: ['scummvm.exe'], kind: 'scummvm', exts: [], dirs: ['scummvm'],
    args: (f) => ['-f', '--path=' + f, '--auto-detect'] }
};

// Places emulators usually live.
function searchRoots(env, drives, known) {
  env = env || process.env;
  const home = env.USERPROFILE || '';
  const la = env.LOCALAPPDATA || '';
  const roots = [];
  const add = (p, depth) => { if (p && exists(p) && !roots.some((r) => r.p.toLowerCase() === p.toLowerCase())) roots.push({ p, depth }); };
  for (const d of drives) {
    add(path.join(d, 'Emulation', 'tools'), 4);
    add(path.join(d, 'Emulators'), 3);
    add(path.join(d, 'Emulation'), 3);
    add(path.join(d, 'Games', 'Emulators'), 3);
    add(path.join(d, 'RetroArch-Win64'), 1);
    add(path.join(d, 'RetroArch'), 1);
  }
  add(path.join(home, 'emudeck'), 4); add(path.join(env.APPDATA || '', 'emudeck'), 4); add(path.join(la, 'emudeck'), 4);
  add(path.join(la, 'Programs'), 2);
  add(env.ProgramFiles || 'C:\\Program Files', 2);
  add(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 2);
  add(path.join(home, 'scoop', 'apps'), 3);
  add(path.join(la, 'Microsoft', 'WinGet', 'Packages'), 3);
  add(path.join(la, 'Microsoft', 'WinGet', 'Links'), 0);
  add(path.join(home, 'Emulators'), 3);
  add(path.join(home, 'Desktop'), 2);
  add(path.join(home, 'Downloads'), 2);
  add(path.join(home, 'Documents'), 2);
  // Next to the emulators you already set up (C:\Emulators\Dolphin -> look in C:\Emulators).
  for (const exe of known || []) if (exe) add(path.dirname(path.dirname(exe)), 3);
  return roots;
}
const SKIP = /^(windows|\$recycle\.bin|system volume information|programdata|node_modules|steamapps|common redist|roms|saves|bios|cache|shaders|logs|storage|downloaded_media)$/i;
// One walk over all places, collecting every known emulator program at once.
function detect(env, drives, known, extraExes) {
  const want = new Map();
  for (const [id, e] of Object.entries(CATALOG)) for (const x of e.exes) if (!want.has(x)) want.set(x, id);
  for (const [id, xs] of Object.entries(extraExes || {})) for (const x of xs) if (!want.has(x)) want.set(x, id);
  const found = {};
  let budget = 40000; // folders looked at, at most (keeps a slow drive from hanging the scan)
  for (const { p, depth } of searchRoots(env, drives, known)) {
    (function walk(dir, d) {
      if (d > depth || budget-- <= 0) return;
      for (const ent of listDir(dir)) {
        const name = ent.name.toLowerCase();
        if (ent.isFile() || ent.isSymbolicLink()) {
          const id = want.get(name);
          if (id && !found[id]) found[id] = path.join(dir, ent.name);
        } else if (ent.isDirectory() && !SKIP.test(ent.name)) walk(path.join(dir, ent.name), d + 1);
      }
    })(p, 0);
  }
  return found;
}
// EmuDeck-style ROM folders for an emulator, on every drive.
function romDirs(id, drives) {
  const e = CATALOG[id];
  if (!e) return [];
  const out = [];
  const subs = e.kind === 'retroarch' ? [].concat(...RETRO_SYSTEMS.map((s) => s.dirs)) : e.dirs;
  for (const d of drives) for (const sub of subs) { const full = path.join(d, 'Emulation', 'roms', sub); if (exists(full)) out.push(full); }
  return out;
}

module.exports = { CATALOG, RETRO_SYSTEMS, detect, romDirs, searchRoots };
