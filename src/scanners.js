'use strict';
// Finds installed games: Steam, Epic, and emulator game folders (Dolphin, RPCS3, Ryujinx).
// Every function here is defensive: a missing folder or a bad file never throws, it just finds nothing.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const EMULATORS = {
  dolphin: {
    name: 'Dolphin',
    system: 'GameCube / Wii',
    exts: ['.iso', '.gcm', '.ciso', '.gcz', '.wbfs', '.rvz', '.wia', '.wad', '.dol', '.elf'],
    // -b closes Dolphin when the game stops, so you land back in the launcher;
    // the -C setting skips Dolphin's "stop emulation?" box when the launcher closes the game.
    args: (file) => ['-b', '-C', 'Dolphin.Interface.ConfirmStop=False', '-e', file]
  },
  rpcs3: {
    name: 'RPCS3',
    system: 'PS3',
    exts: [], // PS3 games are folders (or .iso files), found by scanRpcs3
    args: (file) => ['--no-gui', file]
  },
  ryujinx: {
    name: 'Ryujinx',
    system: 'Switch',
    exts: ['.nsp', '.xci', '.nca', '.nro', '.nso'],
    args: (file) => ['--fullscreen', file]
  }
};

// The other emulators (PCSX2, DuckStation, RetroArch…) from the catalog, launched the same way.
const CAT = require('./emucatalog');
for (const [id, e] of Object.entries(CAT.CATALOG)) EMULATORS[id] = Object.assign({ catalog: true }, e);

function exists(p) {
  try { return !!p && fs.existsSync(p); } catch (_) { return false; }
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
}

function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
}

// "Some_Game (USA) [v1.2].nsp" -> "Some Game"
function cleanTitle(fileName) {
  let t = fileName.replace(/\.[^.\\/]+$/, '');
  t = t.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');
  t = t.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t || fileName;
}

// Walks a folder a few levels deep and returns files with matching extensions.
function findFiles(root, exts, maxDepth) {
  const out = [];
  const want = new Set(exts.map((e) => e.toLowerCase()));
  (function walk(dir, depth) {
    if (depth > maxDepth || out.length > 5000) return;
    for (const ent of listDir(dir)) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, depth + 1);
      else if (ent.isFile() && want.has(path.extname(ent.name).toLowerCase())) out.push(full);
    }
  })(root, 0);
  return out;
}

// ---------- PS3 PARAM.SFO ----------
function readSfo(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (_) { return null; }
  if (buf.length < 20 || buf.readUInt32BE(0) !== 0x00505346) return null; // "\0PSF"
  const keyStart = buf.readUInt32LE(8);
  const dataStart = buf.readUInt32LE(12);
  const count = buf.readUInt32LE(16);
  const out = {};
  for (let i = 0; i < count; i++) {
    const e = 20 + i * 16;
    if (e + 16 > buf.length) break;
    const keyOff = buf.readUInt16LE(e);
    const fmt = buf.readUInt16LE(e + 2);
    const len = buf.readUInt32LE(e + 4);
    const dataOff = buf.readUInt32LE(e + 12);
    const kStart = keyStart + keyOff;
    let kEnd = kStart;
    while (kEnd < buf.length && buf[kEnd] !== 0) kEnd++;
    const key = buf.toString('utf8', kStart, kEnd);
    const dStart = dataStart + dataOff;
    if (dStart + len > buf.length) continue;
    if (fmt === 0x0404) out[key] = buf.readUInt32LE(dStart);
    else out[key] = buf.toString('utf8', dStart, dStart + len).replace(/\0+$/, '');
  }
  return out;
}

// ---------- Steam ----------
function steamRoot() {
  if (process.platform === 'win32') {
    try {
      const outp = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { encoding: 'utf8', windowsHide: true });
      const m = outp.match(/SteamPath\s+REG_SZ\s+(.+)/);
      if (m) {
        const p = path.normalize(m[1].trim());
        if (exists(p)) return p;
      }
    } catch (_) { /* not installed */ }
    for (const p of ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']) if (exists(p)) return p;
    return null;
  }
  const home = process.env.HOME || '';
  for (const p of [path.join(home, 'Library', 'Application Support', 'Steam'), path.join(home, '.steam', 'steam'), path.join(home, '.local', 'share', 'Steam')]) if (exists(p)) return p;
  return null;
}

const STEAM_SKIP = /redistributable|steamworks|proton|steam linux runtime|steamvr|soundtrack|dedicated server/i;

function findSteamArt(root, appid) {
  const cache = path.join(root, 'appcache', 'librarycache');
  const art = {};
  const pick = (names) => {
    for (const n of names) {
      const flat = path.join(cache, appid + '_' + n);
      if (exists(flat)) return flat;
    }
    // Newer Steam layout: librarycache/<appid>/<maybe a hash folder>/<name>
    const dir = path.join(cache, appid);
    const stack = [[dir, 0]];
    while (stack.length) {
      const [d, depth] = stack.pop();
      for (const ent of listDir(d)) {
        const full = path.join(d, ent.name);
        if (ent.isDirectory() && depth < 2) stack.push([full, depth + 1]);
        else if (ent.isFile() && names.includes(ent.name)) return full;
      }
    }
    return null;
  };
  art.tile = pick(['library_600x900.jpg', 'library_capsule.jpg', 'header.jpg']);
  art.hero = pick(['library_hero.jpg']);
  art.logo = pick(['logo.png']);
  return art;
}

function scanSteam(rootOverride) {
  const root = rootOverride || steamRoot();
  if (!root) return { found: false, games: [] };
  const libs = new Set([root]);
  const vdf = readText(path.join(root, 'steamapps', 'libraryfolders.vdf'));
  if (vdf) {
    const re = /"path"\s+"([^"]+)"/g;
    let m;
    while ((m = re.exec(vdf))) libs.add(path.normalize(m[1].replace(/\\\\/g, '\\')));
  }
  const games = [];
  const seen = new Set();
  for (const lib of libs) {
    const apps = path.join(lib, 'steamapps');
    for (const ent of listDir(apps)) {
      if (!ent.isFile() || !/^appmanifest_\d+\.acf$/.test(ent.name)) continue;
      const acf = readText(path.join(apps, ent.name));
      if (!acf) continue;
      const id = (acf.match(/"appid"\s+"(\d+)"/) || [])[1];
      const name = (acf.match(/"name"\s+"([^"]+)"/) || [])[1];
      const installdir = (acf.match(/"installdir"\s+"([^"]+)"/) || [])[1];
      if (!id || !name || seen.has(id) || id === '228980' || STEAM_SKIP.test(name)) continue;
      seen.add(id);
      games.push({
        key: 'steam:' + id,
        source: 'steam',
        title: name,
        launch: { type: 'url', url: 'steam://rungameid/' + id, dir: installdir ? path.join(apps, 'common', installdir) : null },
        art: findSteamArt(root, id)
      });
    }
  }
  // Non-Steam games you've added to Steam
  const have = new Set(games.map((g) => g.title.toLowerCase()));
  for (const g of scanSteamShortcuts(root)) if (!have.has(g.title.toLowerCase())) games.push(g);
  return { found: true, root, games };
}

// Steam games downloading right now (installs and updates): [{ appid, name, pct, installing }].
// Steam keeps the byte counts in each game's appmanifest while it downloads.
function steamDownloads(rootOverride) {
  const root = rootOverride || steamRoot();
  if (!root) return [];
  const libs = new Set([root]);
  const vdf = readText(path.join(root, 'steamapps', 'libraryfolders.vdf'));
  if (vdf) { const re = /"path"\s+"([^"]+)"/g; let m; while ((m = re.exec(vdf))) libs.add(path.normalize(m[1].replace(/\\\\/g, '\\'))); }
  const out = [];
  for (const lib of libs) {
    const apps = path.join(lib, 'steamapps');
    for (const ent of listDir(apps)) {
      if (!ent.isFile() || !/^appmanifest_\d+\.acf$/.test(ent.name)) continue;
      const acf = readText(path.join(apps, ent.name));
      if (!acf) continue;
      const num = (k) => Number((acf.match(new RegExp('"' + k + '"\\s+"(\\d+)"')) || [])[1] || 0);
      const flags = num('StateFlags');
      const total = num('BytesToDownload'), done = num('BytesDownloaded');
      if (flags === 4 || !total || done >= total) continue; // 4 = fully installed, nothing pending
      const id = (acf.match(/"appid"\s+"(\d+)"/) || [])[1];
      const name = (acf.match(/"name"\s+"([^"]+)"/) || [])[1] || 'A game';
      if (!id || STEAM_SKIP.test(name)) continue;
      out.push({ appid: id, name, pct: Math.max(0, Math.min(99, Math.floor((done / total) * 100))), installing: !(flags & 4) });
    }
  }
  return out;
}

// ---------- Steam: non-Steam games (Library › Add a Non-Steam Game) ----------
// Steam keeps them in userdata/<account>/config/shortcuts.vdf, a small binary file.
function readBinaryVdf(buf) {
  let i = 0;
  const cstr = () => { const s = i; while (i < buf.length && buf[i] !== 0) i++; const out = buf.toString('utf8', s, i); i++; return out; };
  function map() {
    const out = {};
    while (i < buf.length) {
      const type = buf[i++];
      if (type === 0x08) return out;
      const key = cstr();
      if (type === 0x00) out[key] = map();
      else if (type === 0x01) out[key] = cstr();
      else if (type === 0x02) { out[key] = buf.readInt32LE(i); i += 4; }
      else if (type === 0x07) { out[key] = buf.readBigUInt64LE(i); i += 8; }
      else throw new Error('Unknown VDF field type ' + type);
    }
    return out;
  }
  return map();
}

// Steam's ID for a non-Steam game (used for its art files and its steam://rungameid link).
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(str) { let c = 0xFFFFFFFF; for (const b of Buffer.from(str, 'utf8')) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function shortcutAppId(exe, name, given) {
  if (typeof given === 'number' && given !== 0) return given >>> 0;
  return (crc32(exe + name) | 0x80000000) >>> 0;
}

// EmuDeck (Steam ROM Manager) adds every ROM to Steam as a shortcut that starts an emulator.
// Tell which of the launcher's own emulators a shortcut runs, so it isn't listed twice.
function shortcutEmulator(text) {
  const t = String(text || '').toLowerCase().replace(/\//g, '\\');
  if (/ryujinx|\\roms\\switch\\/.test(t)) return 'ryujinx';
  if (/rpcs3|\\roms\\ps3\\/.test(t)) return 'rpcs3';
  if (/dolphin|\\roms\\(gc|gamecube|wii)\\/.test(t)) return 'dolphin';
  // EmuDeck's shortcuts for the other emulators: by program name or EmuDeck ROM folder
  for (const [id, e] of Object.entries(CAT.CATALOG)) {
    if (e.exes.some((x) => t.includes(x.replace(/\.exe$/, '')))) return id;
    const dirs = e.kind === 'retroarch' ? [].concat(...CAT.RETRO_SYSTEMS.map((r) => r.dirs)) : e.dirs;
    if (dirs.some((d) => t.includes('\\roms\\' + d + '\\'))) return id;
  }
  return null;
}

function scanSteamShortcuts(root) {
  const games = [];
  const ud = path.join(root, 'userdata');
  for (const acct of listDir(ud)) {
    if (!acct.isDirectory()) continue;
    const cfg = path.join(ud, acct.name, 'config');
    let buf;
    try { buf = fs.readFileSync(path.join(cfg, 'shortcuts.vdf')); } catch (_) { continue; }
    let data;
    try { data = readBinaryVdf(buf); } catch (_) { continue; }
    const list = data.shortcuts || data.Shortcuts || {};
    for (const k of Object.keys(list)) {
      const e = list[k] || {};
      const name = e.AppName || e.appname || '';
      const exeRaw = e.Exe || e.exe || '';
      if (!name || !exeRaw) continue;
      if (String(e.IsHidden || e.ishidden || 0) === '1') continue;
      const appid = shortcutAppId(exeRaw, name, e.appid);
      const exe = exeRaw.replace(/^"|"$/g, '');
      const startDir = String(e.StartDir || e.startdir || '').replace(/^"|"$/g, '');
      const gameId = ((BigInt(appid) << 32n) | 0x02000000n).toString();
      const grid = path.join(cfg, 'grid');
      const pick = (names) => names.map((n) => path.join(grid, n)).find(exists) || null;
      games.push({
        key: 'steam-ns:' + appid,
        source: 'steam',
        title: name,
        emuOf: shortcutEmulator([exe, e.LaunchOptions || e.launchoptions || '', startDir].join(' ')),
        // The ROM paths the shortcut opens (quoted in its launch options), to spot the same game.
        emuRoms: (String(e.LaunchOptions || e.launchoptions || '').match(/"[^"]+"/g) || []).map((q) => q.slice(1, -1).toLowerCase().replace(/\//g, '\\').replace(/\\+$/, ''))
          .filter((q) => /\\roms\\|\.(nsp|xci|iso|rvz|wbfs|gcz|ciso|gcm|wia|wad|ps3|bin)$/.test(q)),
        // Through Steam, so your Steam controller settings for it still apply.
        launch: { type: 'url', url: 'steam://rungameid/' + gameId, dir: startDir || path.dirname(exe) || null },
        art: {
          tile: pick([appid + 'p.png', appid + 'p.jpg', appid + '.png', appid + '.jpg']),
          hero: pick([appid + '_hero.png', appid + '_hero.jpg']),
          logo: pick([appid + '_logo.png'])
        }
      });
    }
  }
  return games;
}

// ---------- Microsoft Store / Xbox app games ----------
// PC Game Pass and Microsoft Store games have a MicrosoftGame.config in their install folder.
// They start through Windows' app list (shell:AppsFolder\<app ID>), like the Start menu does.
const MS_PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$start = @{}; foreach ($a in Get-StartApps) { $start[$a.AppID] = $a.Name }
$out = @()
foreach ($p in Get-AppxPackage) {
  $loc = $p.InstallLocation
  if (-not $loc) { continue }
  $cfgPath = Join-Path $loc 'MicrosoftGame.config'
  if (-not (Test-Path -LiteralPath $cfgPath)) { continue }
  $cfg = $null
  try { [xml]$cfg = Get-Content -LiteralPath $cfgPath -Raw } catch { }
  $pfn = $p.PackageFamilyName
  $aumid = @($start.Keys | Where-Object { $_ -like ($pfn + '!*') })[0]
  if (-not $aumid) {
    $id = 'Game'
    try { [xml]$man = Get-Content -LiteralPath (Join-Path $loc 'AppxManifest.xml') -Raw; $id = @($man.Package.Applications.Application)[0].Id } catch { }
    $aumid = $pfn + '!' + $id
  }
  $name = $start[$aumid]
  $sv = $null
  if ($cfg) { $sv = $cfg.Game.ShellVisuals }
  if (-not $name -and $sv -and $sv.DefaultDisplayName -and $sv.DefaultDisplayName -notlike 'ms-resource*') { $name = $sv.DefaultDisplayName }
  if (-not $name) { $name = $p.Name }
  $tile = ''; $hero = ''
  if ($sv) {
    $tile = @($sv.Square480x480Logo, $sv.Square150x150Logo, $sv.StoreLogo) | Where-Object { $_ } | Select-Object -First 1
    $hero = '' + $sv.SplashScreenImage
  }
  $out += [pscustomobject]@{ name = '' + $name; aumid = '' + $aumid; dir = '' + $loc; tile = '' + $tile; hero = $hero }
}
ConvertTo-Json -InputObject @($out) -Compress
`;

// Store images come in scale variants (Logo.scale-200.png); use the exact file or the biggest one.
function storeAsset(dir, rel) {
  if (!rel) return null;
  const full = path.join(dir, rel);
  if (exists(full)) return full;
  const ext = path.extname(full), base = path.basename(full, ext).toLowerCase();
  let best = null, bestScale = -1;
  for (const ent of listDir(path.dirname(full))) {
    const n = ent.name.toLowerCase();
    if (!n.startsWith(base + '.') || !n.endsWith(ext.toLowerCase())) continue;
    const sc = Number((/(?:scale|targetsize)-(\d+)/.exec(n) || [])[1] || 0);
    if (sc > bestScale) { bestScale = sc; best = path.join(path.dirname(full), ent.name); }
  }
  return best;
}

function scanMsStore() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ found: false, games: [] });
    require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', MS_PS],
      { windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
        let list = [];
        try { list = JSON.parse(String(out || '').trim() || '[]'); } catch (_) { list = []; }
        if (!Array.isArray(list)) list = list ? [list] : [];
        const games = list.filter((g) => g && g.aumid && /^[\w.-]+_[a-z0-9]+![\w.-]+$/i.test(g.aumid) && g.name).map((g) => ({
          key: 'msstore:' + g.aumid.toLowerCase(),
          source: 'msstore',
          title: String(g.name).replace(/[\u2122\u00AE]/g, '').replace(/\s+/g, ' ').trim(),
          launch: { type: 'appx', aumid: g.aumid, dir: g.dir || null },
          art: { tile: storeAsset(g.dir, g.tile), hero: storeAsset(g.dir, g.hero) }
        }));
        resolve({ found: !err, games });
      });
  });
}

// ---------- Roblox ----------
// Roblox installs per user; its own link opens the Roblox app on its home screen.
function scanRoblox(env) {
  env = env || process.env;
  const roots = [path.join(env.LOCALAPPDATA || '', 'Roblox', 'Versions'), path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Roblox', 'Versions')];
  for (const root of roots) {
    if (!exists(root)) continue;
    const has = exists(path.join(root, 'RobloxPlayerBeta.exe')) || listDir(root).some((d) => d.isDirectory() && exists(path.join(root, d.name, 'RobloxPlayerBeta.exe')));
    if (!has) continue;
    return { found: true, games: [{ key: 'roblox:app', source: 'roblox', title: 'Roblox', launch: { type: 'url', url: 'roblox-player:1+launchmode:app', dir: root }, art: {} }] };
  }
  return { found: false, games: [] };
}

// ---------- Epic ----------
function scanEpic(manifestDirOverride) {
  const dir = manifestDirOverride || (process.platform === 'win32'
    ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')
    : process.platform === 'darwin' ? path.join(process.env.HOME || '', 'Library', 'Application Support', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')
    : null);
  if (!dir || !exists(dir)) return { found: false, games: [] };
  const games = [];
  for (const ent of listDir(dir)) {
    if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.item')) continue;
    let m;
    try { m = JSON.parse(readText(path.join(dir, ent.name)) || ''); } catch (_) { continue; }
    if (!m || !m.AppName || !m.DisplayName) continue;
    if (m.bIsApplication === false) continue;
    const cats = Array.isArray(m.AppCategories) ? m.AppCategories : [];
    if (cats.length && !cats.includes('games')) continue;
    if (m.MainGameAppName && m.MainGameAppName !== m.AppName) continue; // DLC
    const id = [m.CatalogNamespace, m.CatalogItemId, m.AppName].filter(Boolean).join(':');
    games.push({
      key: 'epic:' + m.AppName,
      source: 'epic',
      title: m.DisplayName,
      launch: { type: 'url', url: 'com.epicgames.launcher://apps/' + encodeURIComponent(id) + '?action=launch&silent=true', dir: m.InstallLocation || null },
      art: {}
    });
  }
  return { found: true, games };
}

// ---------- Emulators ----------
// A platform can have several game folders, separated by ";" (for example GameCube and Wii).
const dirsOf = (d) => String(d || '').split(';').map((x) => x.trim()).filter(Boolean);

// Switch updates and DLC aren't games: skip them by title ID (base games end in 000,
// updates in 800, DLC in anything else) or by their usual name tags.
function isSwitchExtra(file) {
  const name = path.basename(file);
  const id = (/\[(0100[0-9A-Fa-f]{12})\]/.exec(name) || /\b(0100[0-9A-Fa-f]{12})\b/.exec(name) || [])[1];
  if (id) return !/000$/.test(id);
  return /[[(\s_-](update|upd|dlc|patch)[\])\s_.-]/i.test(name) || /\[v[1-9]\d*\]/i.test(name);
}

function scanFileEmulator(emuId, gamesDir) {
  const emu = EMULATORS[emuId];
  const dirs = dirsOf(gamesDir).filter(exists);
  if (!dirs.length) return [];
  let files = [].concat(...dirs.map((d) => findFiles(d, emu.exts, 4)));
  if (emuId === 'ryujinx') files = files.filter((f) => !isSwitchExtra(f));
  return files.map((file) => ({
    key: emuId + ':' + file.toLowerCase(),
    source: emuId,
    title: cleanTitle(path.basename(file)),
    launch: { type: 'emu', emu: emuId, file },
    art: {}
  }));
}

// RPCS3 keeps its own records next to rpcs3.exe (newer builds: in a "config" folder):
//  - vfs.yml says where dev_hdd0 really is (EmuDeck moves it to Emulation\storage\rpcs3)
//  - games.yml lists every disc game you've added in RPCS3, wherever it lives.
function rpcs3Records(emuExe) {
  const out = { hdd: [], games: [] };
  if (!emuExe) return out;
  // Mac: RPCS3 keeps its settings and installed games in Application Support, not next to the app.
  const exeDir = process.platform === 'darwin' && /\.app\/?$/i.test(emuExe) ? path.join(process.env.HOME || '', 'Library', 'Application Support', 'rpcs3') : path.dirname(emuExe);
  const unq = (v) => String(v || '').trim().replace(/^["']|["']$/g, '').trim();
  const fix = (p) => path.normalize(p.replace(/[\\/]/g, path.sep));
  out.hdd.push(path.join(exeDir, 'dev_hdd0', 'game'));
  for (const cfgDir of [path.join(exeDir, 'config'), exeDir]) {
    const vfs = readText(path.join(cfgDir, 'vfs.yml'));
    if (vfs) {
      const emuDirLine = /^\s*["']?\$\(EmulatorDir\)["']?\s*:\s*(.*)$/m.exec(vfs);
      const emuDir = (emuDirLine && unq(emuDirLine[1])) || (exeDir + path.sep);
      const hddLine = /^\s*["']?\/dev_hdd0\/?["']?\s*:\s*(.*)$/m.exec(vfs);
      const v = hddLine && unq(hddLine[1]);
      if (v) out.hdd.push(path.join(fix(v.replace(/\$\(EmulatorDir\)/g, emuDir + '/')), 'game'));
    }
    const gy = readText(path.join(cfgDir, 'games.yml'));
    if (gy) {
      for (const line of gy.split(/\r?\n/)) {
        const m = /^\s*["']?([A-Z]{4}\d{5})["']?\s*:\s*(.+)$/.exec(line);
        if (m && unq(m[2])) out.games.push(fix(unq(m[2])));
      }
    }
  }
  out.hdd = out.hdd.filter((d, i, a) => a.indexOf(d) === i);
  return out;
}

function scanRpcs3(gamesDir, emuExe) {
  const folders = dirsOf(gamesDir).filter(exists);
  const rec = rpcs3Records(emuExe);
  const roots = folders.concat(rec.hdd.filter(exists), rec.games.filter((g) => !/\.iso$/i.test(g) && exists(g)));
  const games = [];
  const seen = new Set();
  // Decrypted .iso files boot directly in current RPCS3 builds.
  const isoFiles = [].concat(...folders.map((d) => findFiles(d, ['.iso'], 4)), rec.games.filter((g) => /\.iso$/i.test(g) && exists(g)));
  for (const file of isoFiles) {
    const k = 'iso:' + file.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    games.push({ key: 'rpcs3:' + k, source: 'rpcs3', title: cleanTitle(path.basename(file)), launch: { type: 'emu', emu: 'rpcs3', file }, art: {} });
  }
  const add = (gameRoot, eboot, sfoPath) => {
    const sfo = readSfo(sfoPath) || {};
    const cat = sfo.CATEGORY || '';
    if (cat && !['HG', 'DG'].includes(cat)) return; // skip patches, DLC, save data
    const k = (sfo.TITLE_ID || gameRoot).toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    games.push({
      key: 'rpcs3:' + k,
      source: 'rpcs3',
      title: (sfo.TITLE || cleanTitle(path.basename(gameRoot))).replace(/\s+/g, ' ').trim(),
      launch: { type: 'emu', emu: 'rpcs3', file: eboot },
      art: (() => {
        const a = {};
        const icon = path.join(path.dirname(sfoPath), 'ICON0.PNG');
        const pic = path.join(path.dirname(sfoPath), 'PIC1.PNG');
        if (exists(icon)) a.tile = icon;
        if (exists(pic)) a.hero = pic;
        return a;
      })()
    });
  };
  for (const root of roots) {
    (function walk(dir, depth) {
      if (depth > 4) return;
      const disc = path.join(dir, 'PS3_GAME');
      const discEboot = path.join(disc, 'USRDIR', 'EBOOT.BIN');
      if (exists(discEboot) && exists(path.join(disc, 'PARAM.SFO'))) { add(dir, discEboot, path.join(disc, 'PARAM.SFO')); return; }
      const hddEboot = path.join(dir, 'USRDIR', 'EBOOT.BIN');
      if (exists(hddEboot) && exists(path.join(dir, 'PARAM.SFO'))) { add(dir, hddEboot, path.join(dir, 'PARAM.SFO')); return; }
      for (const ent of listDir(dir)) if (ent.isDirectory()) walk(path.join(dir, ent.name), depth + 1);
    })(root, 0);
  }
  return games;
}

function scanEmulator(emuId, cfg) {
  if (!cfg || !cfg.exe) return [];
  if (EMULATORS[emuId] && EMULATORS[emuId].catalog) return require('./emuscan').scanCatalog(emuId, cfg);
  if (emuId === 'rpcs3') return scanRpcs3(cfg.dir, cfg.exe);
  return scanFileEmulator(emuId, cfg.dir);
}

module.exports = { EMULATORS, cleanTitle, readSfo, scanSteam, scanEpic, scanEmulator, findFiles, steamRoot };

// ---------- EmuDeck ----------
// EmuDeck starts emulators through .ps1 scripts; this finds the real programs and the ROM folders.
const EMU_EXES = { dolphin: ['dolphin.exe'], rpcs3: ['rpcs3.exe'], ryujinx: ['ryujinx.exe'] };
const ROM_DIRS = { dolphin: ['gc', 'gamecube', 'wii'], rpcs3: ['ps3'], ryujinx: ['switch'] };
const SKIP = new Set(['roms', 'saves', 'storage', 'bios', 'downloaded_media', 'shaders', 'cache', 'logs']);

function findProgram(roots, names, maxDepth) {
  const want = new Set(names);
  for (const root of roots) {
    let hit = null;
    (function walk(dir, depth) {
      if (hit || depth > maxDepth) return;
      for (const ent of listDir(dir)) {
        if (hit) return;
        const full = path.join(dir, ent.name);
        if (ent.isFile() && want.has(ent.name.toLowerCase())) { hit = full; return; }
        if (ent.isDirectory() && !SKIP.has(ent.name.toLowerCase())) walk(full, depth + 1);
      }
    })(root, 0);
    if (hit) return hit;
  }
  return null;
}

function detectEmuDeck(home, env, drives) {
  const roots = [path.join(home, 'emudeck'), path.join(env.APPDATA || '', 'emudeck'), path.join(env.LOCALAPPDATA || '', 'emudeck')]
    .concat(drives.map((d) => path.join(d, 'Emulation', 'tools')))
    .filter((r, i, a) => exists(r) && a.indexOf(r) === i);
  const out = {};
  for (const id of Object.keys(EMU_EXES)) {
    const exe = findProgram(roots, EMU_EXES[id], 5);
    const dirs = [];
    for (const d of drives) {
      const base = path.join(d, 'Emulation', 'roms');
      for (const sub of ROM_DIRS[id]) { const full = path.join(base, sub); if (exists(full)) dirs.push(full); }
    }
    out[id] = { exe, dirs };
  }
  return out;
}

// Reads a launcher script (.ps1 / .bat / .cmd) and returns the .exe it starts.
function exeFromScript(file, env) {
  const text = readText(file);
  if (!text) return null;
  const expand = (p) => p
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, (_, k) => env[k] || env[Object.keys(env).find((x) => x.toLowerCase() === k.toLowerCase())] || '')
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, k) => env[k] || env[Object.keys(env).find((x) => x.toLowerCase() === k.toLowerCase())] || '')
    .replace(/\$PSScriptRoot/gi, path.dirname(file));
  const re = /["']([^"'\r\n]+?\.exe)["']/gi;
  let m;
  while ((m = re.exec(text))) {
    const p = path.normalize(expand(m[1]).replace(/\//g, path.sep));
    if (exists(p)) return p;
  }
  return null;
}

module.exports.detectEmuDeck = detectEmuDeck;
module.exports.exeFromScript = exeFromScript;
module.exports.dirsOf = dirsOf;
module.exports.isSwitchExtra = isSwitchExtra;
module.exports.shortcutEmulator = shortcutEmulator;
module.exports.scanMsStore = scanMsStore;
module.exports.steamDownloads = steamDownloads;
// A Steam game's install state (4 = fully installed), or null when it isn't there.
module.exports.steamAppFlags = function steamAppFlags(appid, rootOverride) {
  const root = rootOverride || steamRoot();
  if (!root || !/^\d+$/.test(String(appid))) return null;
  const libs = new Set([root]);
  const vdf = readText(path.join(root, 'steamapps', 'libraryfolders.vdf'));
  if (vdf) { const re = /"path"\s+"([^"]+)"/g; let m; while ((m = re.exec(vdf))) libs.add(path.normalize(m[1].replace(/\\\\/g, '\\'))); }
  for (const lib of libs) {
    const acf = readText(path.join(lib, 'steamapps', 'appmanifest_' + appid + '.acf'));
    if (acf) return Number((acf.match(/"StateFlags"\s+"(\d+)"/) || [])[1] || 0);
  }
  return null;
};
module.exports.scanRoblox = scanRoblox;
module.exports.storeAsset = storeAsset;

// Drops EmuDeck's Steam shortcuts for games that were also found directly through their
// emulator (same ROM file or same name). Other shortcuts stay.
function dropEmuDuplicates(steamGames, emuGames) {
  const norm = (t) => String(t || '').toLowerCase().replace(/\.[a-z0-9]{2,4}$/, '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, '');
  const files = emuGames.map((g) => String((g.launch && g.launch.file) || '').toLowerCase().replace(/\//g, '\\'));
  const titles = new Set([].concat(...emuGames.map((g) => [norm(g.title), norm(path.basename(String((g.launch && g.launch.file) || '')))])).filter(Boolean));
  return steamGames.filter((g) => {
    if (!g.emuOf) return true;
    const sameFile = (g.emuRoms || []).some((rp) => files.some((f) => f === rp || f.startsWith(rp + '\\')));
    return !(sameFile || titles.has(norm(g.title)));
  });
}
module.exports.dropEmuDuplicates = dropEmuDuplicates;
module.exports.readBinaryVdf = readBinaryVdf;
module.exports.shortcutAppId = shortcutAppId;
