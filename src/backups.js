'use strict';
// Save backups: each emulator's save folder is copied before a game starts and after it closes
// (only when something changed), into a folder of your choice, OneDrive, or Google Drive
// (through Google Drive for desktop, which shows up as a drive with "My Drive" in it).
// The newest copies are kept per emulator; any of them can be put back from Settings.
//
// Where saves are: EmuDeck keeps every emulator's saves in Emulation\saves\<emulator>, so that's
// used when the emulator is an EmuDeck one; otherwise each emulator's usual save folder.

const fs = require('fs');
const path = require('path');

const exists = (p) => { try { return !!p && fs.existsSync(p); } catch (_) { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };
const listDir = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return []; } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } };
const MAX_BYTES = 3 * 1024 * 1024 * 1024; // folders bigger than this aren't copied (e.g. whole disk images)

// EmuDeck's folder names in Emulation\saves
const DECK = {
  dolphin: ['dolphin'], rpcs3: ['rpcs3'], ryujinx: ['ryujinx'], pcsx2: ['pcsx2'], duckstation: ['duckstation'], ppsspp: ['ppsspp'],
  vita3k: ['vita3k'], shadps4: ['shadps4'], cemu: ['cemu'], yuzufork: ['yuzu', 'eden', 'citron', 'sudachi'], azahar: ['azahar', 'citra', 'lime3ds'],
  melonds: ['melonds'], mgba: ['mgba'], xenia: ['xenia'], xemu: ['xemu'], flycast: ['flycast'], redream: ['redream'],
  retroarch: ['retroarch'], mame: ['mame'], supermodel: ['supermodel'], ares: ['ares'], scummvm: ['scummvm']
};

function deckRoot(exe) {
  const m = /^(.*?[\\/]Emulation)[\\/]/i.exec(String(exe || ''));
  return m && isDir(path.join(m[1], 'saves')) ? path.join(m[1], 'saves') : null;
}
// The usual save folders when it isn't EmuDeck.
function defaultDirs(id, exe, env, extra) {
  env = env || process.env;
  const dir = exe ? path.dirname(exe) : '';
  const docs = path.join(env.USERPROFILE || '', 'Documents');
  const ad = env.APPDATA || '';
  const first = (...c) => c.find((p) => isDir(p));
  const pick = (label, p) => (p && isDir(p) ? [{ label, path: p }] : []);
  switch (id) {
    case 'dolphin': { const u = extra && extra.dolphinUser; return u ? pick('GC', path.join(u, 'GC')).concat(pick('Wii', path.join(u, 'Wii'))) : []; }
    case 'pcsx2': return pick('memcards', first(path.join(dir, 'memcards'), path.join(docs, 'PCSX2', 'memcards')));
    case 'duckstation': return pick('memcards', first(path.join(dir, 'memcards'), path.join(docs, 'DuckStation', 'memcards')));
    case 'ppsspp': return pick('SAVEDATA', first(path.join(dir, 'memstick', 'PSP', 'SAVEDATA'), path.join(docs, 'PPSSPP', 'PSP', 'SAVEDATA')));
    case 'rpcs3': return pick('savedata', path.join(dir, 'dev_hdd0', 'home', '00000001', 'savedata'));
    case 'ryujinx': return pick('save', first(path.join(dir, 'portable', 'bis', 'user', 'save'), path.join(ad, 'Ryujinx', 'bis', 'user', 'save')));
    case 'cemu': return pick('save', path.join(dir, 'mlc01', 'usr', 'save'));
    case 'yuzufork': return pick('nand', first(...['eden', 'citron', 'sudachi', 'suyu', 'yuzu'].map((n) => path.join(ad, n, 'nand', 'user', 'save')), path.join(dir, 'user', 'nand', 'user', 'save')));
    case 'azahar': return pick('sdmc', first(path.join(dir, 'user', 'sdmc'), path.join(ad, 'Azahar', 'sdmc'), path.join(ad, 'Lime3DS', 'sdmc'), path.join(ad, 'Citra', 'sdmc')));
    case 'retroarch': return pick('saves', path.join(dir, 'saves'));
    case 'xenia': return pick('content', first(path.join(dir, 'content'), path.join(docs, 'Xenia', 'content')));
    case 'vita3k': return pick('savedata', first(path.join(dir, 'ux0', 'user', '00', 'savedata'), path.join(ad, 'Vita3K', 'Vita3K', 'ux0', 'user', '00', 'savedata')));
    case 'shadps4': return pick('savedata', first(path.join(dir, 'user', 'savedata'), path.join(ad, 'shadPS4', 'savedata')));
    case 'flycast': return pick('data', first(path.join(dir, 'data'), path.join(ad, 'flycast', 'data')));
    case 'scummvm': return pick('Saved games', first(path.join(ad, 'ScummVM', 'Saved games'), path.join(dir, 'Saved games')));
    case 'mame': return pick('nvram', path.join(dir, 'nvram'));
    case 'supermodel': return pick('NVRAM', path.join(dir, 'NVRAM'));
    default: return []; // melonDS / mGBA / ares keep saves next to the games (backed up with EmuDeck's folder)
  }
}
function saveDirs(id, exe, env, extra) {
  const deck = deckRoot(exe);
  if (deck) {
    const found = (DECK[id] || [id]).map((n) => path.join(deck, n)).filter(isDir).map((p) => ({ label: path.basename(p), path: p }));
    if (found.length) return found;
  }
  return defaultDirs(id, exe, env, extra);
}

// Where backups can go.
function destinations(env, drives) {
  env = env || process.env;
  const home = env.USERPROFILE || '';
  const out = [];
  const od = [env.OneDriveConsumer, env.OneDrive, path.join(home, 'OneDrive')].find((p) => p && isDir(p));
  if (od) out.push({ id: 'onedrive', name: 'OneDrive', path: od });
  let gd = null;
  for (const d of drives || []) { const p = path.join(d, 'My Drive'); if (isDir(p)) { gd = p; break; } }
  if (!gd) gd = [path.join(home, 'My Drive'), path.join(home, 'Google Drive', 'My Drive'), path.join(home, 'Google Drive')].find(isDir) || null;
  if (gd) out.push({ id: 'gdrive', name: 'Google Drive', path: gd });
  return out;
}

// A quick fingerprint of a folder: how many files, total size, newest change.
function fingerprint(dir) {
  let files = 0, bytes = 0, newest = 0;
  (function go(d, depth) {
    if (depth > 12) return;
    for (const ent of listDir(d)) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) go(full, depth + 1);
      else if (ent.isFile()) { try { const st = fs.statSync(full); files++; bytes += st.size; if (st.mtimeMs > newest) newest = st.mtimeMs; } catch (_) { /* skip */ } }
    }
  })(dir, 0);
  return { files, bytes, newest: Math.round(newest) };
}
const stamp = (t) => { const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + '-' + p(d.getMinutes()) + '-' + p(d.getSeconds()); };

function createBackups({ root, keep, now }) {
  now = now || Date.now;
  const busy = new Map(); // emulator -> running copy
  const base = () => (root() ? path.join(root(), 'Couch Launcher', 'Save backups') : null);
  function snapshots(id) {
    const b = base();
    if (!b) return [];
    const dir = path.join(b, id);
    return listDir(dir).filter((e) => e.isDirectory()).map((e) => {
      const meta = (() => { try { return JSON.parse(readText(path.join(dir, e.name, 'backup.json')) || 'null'); } catch (_) { return null; } })();
      return meta ? Object.assign({ id: e.name, dir: path.join(dir, e.name) }, meta) : null;
    }).filter(Boolean).sort((a, b2) => b2.at - a.at);
  }
  // Copies the saves when they changed since the last copy. why: 'before' | 'after' | 'manual' | 'before-restore'
  async function backup(id, sources, why, protect) {
    const b = base();
    if (!b) return { skipped: 'off' };
    if (!sources || !sources.length) return { skipped: 'no-saves' };
    if (busy.has(id)) return busy.get(id);
    const job = (async () => {
      const prints = sources.map((s) => fingerprint(s.path));
      const total = prints.reduce((n, p) => n + p.bytes, 0);
      if (total > MAX_BYTES) return { skipped: 'too-big' };
      if (!prints.some((p) => p.files)) return { skipped: 'empty' };
      const last = snapshots(id)[0];
      const sig = JSON.stringify(prints);
      if (last && last.sig === sig && why !== 'manual') return { skipped: 'unchanged' };
      const at = now();
      let dir = path.join(b, id, stamp(at));
      for (let n = 2; exists(dir); n++) dir = path.join(b, id, stamp(at) + ' (' + n + ')'); // never reuse a copy's folder
      await fs.promises.mkdir(dir, { recursive: true });
      for (const s of sources) await fs.promises.cp(s.path, path.join(dir, s.label), { recursive: true, force: true, errorOnExist: false });
      await fs.promises.writeFile(path.join(dir, 'backup.json'), JSON.stringify({ at, why, sig, sources }));
      // Keep the newest ones (never the copy that's about to be put back).
      const all = snapshots(id).filter((x) => x.id !== protect);
      for (const old of all.slice(Math.max(1, keep()))) await fs.promises.rm(old.dir, { recursive: true, force: true }).catch(() => {});
      return { done: true, at, dir };
    })().finally(() => busy.delete(id));
    busy.set(id, job);
    return job;
  }
  // Puts a copy back (makes a fresh copy of what's there now first, in case).
  async function restore(id, snapId, sources) {
    const snap = snapshots(id).find((s) => s.id === snapId);
    if (!snap) throw new Error('That backup isn’t there any more');
    await backup(id, sources, 'before-restore', snapId).catch(() => null);
    for (const s of snap.sources || []) {
      const from = path.join(snap.dir, s.label);
      if (!isDir(from)) continue;
      await fs.promises.mkdir(s.path, { recursive: true });
      await fs.promises.cp(from, s.path, { recursive: true, force: true });
    }
    return true;
  }
  return { backup, restore, snapshots, base };
}

module.exports = { createBackups, saveDirs, destinations, fingerprint, deckRoot, DECK };
