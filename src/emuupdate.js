'use strict';
// Emulator updates (Settings › Platforms › Emulators › Check for updates).
//  - Checks each emulator's newest release on GitHub, and offers it when it's newer than the
//    emulator on this PC.
//  - Updating downloads it and puts the new program files over the old ones; your settings,
//    saves and anything else in the folder stay (only files that come in the download are replaced).
//  - Emulators installed by EmuDeck, winget or scoop are left to those (they update them).
//  - Never while that emulator is running.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// GitHub repos with Windows builds in their releases. (Dolphin, PPSSPP, RetroArch, Ryujinx
// update themselves or aren't on GitHub releases.)
const SOURCES = {
  duckstation: { repo: 'stenzek/duckstation' },
  pcsx2: { repo: 'PCSX2/pcsx2', pick: /qt/i },
  cemu: { repo: 'cemu-project/Cemu' },
  melonds: { repo: 'melonDS-emu/melonDS' },
  mgba: { repo: 'mgba-emu/mgba' },
  azahar: { repo: 'azahar-emu/azahar', pick: /msvc|msys/i },
  xemu: { repo: 'xemu-project/xemu', pick: /release/i },
  xenia: { repo: 'xenia-canary/xenia-canary-releases' },
  vita3k: { repo: 'Vita3K/Vita3K' },
  shadps4: { repo: 'shadps4-emu/shadPS4', pick: /qt/i },
  flycast: { repo: 'flyinghead/flycast' },
  rpcs3: { repo: 'RPCS3/rpcs3-binaries-win' },
  ares: { repo: 'ares-emulator/ares' },
  scummvm: null
};

// Who looks after this install?
function managedBy(exe) {
  const p = String(exe || '').toLowerCase().replace(/\//g, '\\');
  if (/\\emulation\\tools\\|\\emudeck\\/.test(p)) return 'EmuDeck';
  if (/\\microsoft\\winget\\/.test(p)) return 'winget';
  if (/\\scoop\\apps\\/.test(p)) return 'scoop';
  if (/\\program files( \(x86\))?\\/.test(p)) return 'installer'; // installed with its own setup: use that
  return null;
}
// The Windows 64-bit download among a release's files.
function pickAsset(assets, prefer) {
  const ok = (assets || []).filter((a) => a && /\.(zip|7z)$/i.test(a.name) && /win|windows/i.test(a.name)
    && !/arm64|aarch64|debug|symbols|pdb|linux|mac|android|ios|appimage|-src|source/i.test(a.name));
  const x64 = ok.filter((a) => /x64|x86_64|win64|amd64/i.test(a.name) || !/x86|win32|i686/i.test(a.name));
  const list = x64.length ? x64 : ok;
  if (prefer) { const p = list.find((a) => prefer.test(a.name)); if (p) return p; }
  return list.sort((a, b) => (/\.zip$/i.test(b.name) - /\.zip$/i.test(a.name)))[0] || null;
}

function createEmuUpdates(opts) {
  opts = opts || {};
  const doFetch = opts.fetch || ((...a) => fetch(...a));
  const run = opts.exec || ((cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { windowsHide: true, timeout: 10 * 60e3, maxBuffer: 16 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out)))));
  const tmpDir = opts.tmpDir;
  const cache = new Map();

  async function latest(id) {
    const src = SOURCES[id];
    if (!src) return null;
    const c = cache.get(id);
    if (c && Date.now() - c.at < 30 * 60e3) return c.value;
    const res = await doFetch('https://api.github.com/repos/' + src.repo + '/releases/latest', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CouchLauncher' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('GitHub: HTTP ' + res.status);
    const rel = await res.json();
    const asset = pickAsset(rel.assets, src.pick);
    const value = asset ? { tag: rel.tag_name || rel.name || '', name: asset.name, url: asset.browser_download_url, size: asset.size, date: Date.parse(asset.updated_at || rel.published_at) || 0 } : null;
    cache.set(id, { at: Date.now(), value });
    return value;
  }
  // { status: 'update' | 'current' | 'managed' | 'unknown', latest, managedBy }
  async function check(id, cfg) {
    if (!cfg || !cfg.exe) return { status: 'unknown' };
    const by = managedBy(cfg.exe);
    if (by) return { status: 'managed', managedBy: by };
    if (!SOURCES[id]) return { status: 'unknown' };
    const l = await latest(id);
    if (!l) return { status: 'unknown' };
    // What's here: the release we installed last, else how old the program file is.
    let have = Number(cfg.updatedAt) || 0;
    if (!have) { try { have = fs.statSync(cfg.exe).mtimeMs; } catch (_) { have = 0; } }
    const newer = cfg.updatedTag ? cfg.updatedTag !== l.tag || l.date > have + 60e3 : l.date > have + 24 * 3600e3;
    return { status: newer ? 'update' : 'current', latest: l };
  }
  async function extract(archive, to) {
    await fs.promises.mkdir(to, { recursive: true });
    if (/\.zip$/i.test(archive)) {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force', archive, to]);
      return;
    }
    // .7z: Windows' own tar can open it on current Windows; 7-Zip when it's installed.
    try { await run('tar.exe', ['-xf', archive, '-C', to]); return; } catch (_) { /* try 7-Zip */ }
    for (const z of ['C:\\Program Files\\7-Zip\\7z.exe', 'C:\\Program Files (x86)\\7-Zip\\7z.exe']) {
      if (fs.existsSync(z)) { await run(z, ['x', '-y', '-o' + to, archive]); return; }
    }
    throw new Error('This update is a .7z file. Install 7-Zip (7-zip.org), then try again.');
  }
  // The folder that holds the program inside what was unpacked (downloads often add one folder).
  function programRoot(dir, exeName) {
    let found = null;
    (function go(d, depth) {
      if (found || depth > 3) return;
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
      if (ents.some((e) => e.isFile() && e.name.toLowerCase() === exeName.toLowerCase())) { found = d; return; }
      for (const e of ents) if (e.isDirectory()) go(path.join(d, e.name), depth + 1);
    })(dir, 0);
    return found;
  }
  async function update(id, cfg, onStep) {
    const step = onStep || (() => {});
    const by = managedBy(cfg && cfg.exe);
    if (by) throw new Error('This one is kept up to date by ' + by);
    const l = await latest(id);
    if (!l) throw new Error('No Windows download found for this emulator');
    const work = path.join(tmpDir, 'emu-update-' + id + '-' + Date.now());
    await fs.promises.mkdir(work, { recursive: true });
    try {
      step('Downloading ' + l.name + '…');
      const res = await doFetch(l.url, { headers: { 'User-Agent': 'CouchLauncher' }, signal: AbortSignal.timeout(15 * 60e3) });
      if (!res.ok) throw new Error('Download failed: HTTP ' + res.status);
      const archive = path.join(work, l.name);
      await fs.promises.writeFile(archive, Buffer.from(await res.arrayBuffer()));
      step('Unpacking…');
      const out = path.join(work, 'files');
      await extract(archive, out);
      const rootDir = programRoot(out, path.basename(cfg.exe));
      if (!rootDir) throw new Error('The download doesn’t have ' + path.basename(cfg.exe) + ' in it, so nothing was changed');
      step('Installing…');
      await fs.promises.cp(rootDir, path.dirname(cfg.exe), { recursive: true, force: true });
      return { tag: l.tag, date: l.date };
    } finally {
      fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }
  return { check, update, latest, SOURCES };
}

module.exports = { createEmuUpdates, pickAsset, managedBy, SOURCES };
