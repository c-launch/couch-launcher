'use strict';
// RetroAchievements: your progress for retro games, shown like Steam achievements.
// Connect with your RetroAchievements username and Web API key (retroachievements.org ›
// Settings › Keys). The launcher only reads your progress; you earn achievements inside the
// emulators (RetroArch, DuckStation, PCSX2, PPSSPP, Dolphin… have RetroAchievements built in).
// Games are matched by system + name against RetroAchievements' list for that system.

const fs = require('fs');
const path = require('path');

const API = 'https://retroachievements.org/API/';
const MEDIA = 'https://media.retroachievements.org';
// RetroAchievements system IDs
const SYS = { genesis: 1, n64: 2, snes: 3, gb: 4, gba: 5, gbc: 6, nes: 7, pce: 8, segacd: 9, sms: 11, psx: 12, lynx: 13, ngp: 14, gg: 15, gc: 16, nds: 18, ps2: 21, atari2600: 25, arcade: 27, vb: 28, saturn: 39, dreamcast: 40, psp: 41, wswan: 53 };
const BY_EMU = { dolphin: 'gc', pcsx2: 'ps2', duckstation: 'psx', ppsspp: 'psp', melonds: 'nds', flycast: 'dreamcast', redream: 'dreamcast', mame: 'arcade' };
const BY_RETRO = { 'NES': 'nes', 'SNES': 'snes', 'Nintendo 64': 'n64', 'Game Boy': 'gb', 'Game Boy Color': 'gbc', 'Genesis / Mega Drive': 'genesis', 'Master System': 'sms', 'Game Gear': 'gg', 'Sega CD': 'segacd', 'Saturn': 'saturn', 'PC Engine / TurboGrafx': 'pce', 'Atari 2600': 'atari2600', 'Atari Lynx': 'lynx', 'Neo Geo Pocket': 'ngp', 'WonderSwan': 'wswan', 'Virtual Boy': 'vb', 'Arcade (FinalBurn Neo)': 'arcade' };
const BY_EXT = { '.nes': 'nes', '.sfc': 'snes', '.smc': 'snes', '.n64': 'n64', '.z64': 'n64', '.v64': 'n64', '.gb': 'gb', '.gbc': 'gbc', '.gba': 'gba', '.md': 'genesis', '.gen': 'genesis', '.sms': 'sms', '.gg': 'gg', '.pce': 'pce', '.ws': 'wswan', '.wsc': 'wswan', '.ngp': 'ngp', '.ngc': 'ngp', '.nds': 'nds' };

function systemOf(game) {
  const L = game && game.launch;
  if (!L || L.type !== 'emu') return null;
  if (L.emu === 'retroarch') return SYS[BY_RETRO[L.system]] || null;
  if (BY_EMU[L.emu]) return SYS[BY_EMU[L.emu]];
  if (L.emu === 'mgba' || L.emu === 'ares') return SYS[BY_EXT[path.extname(String(L.file || '')).toLowerCase()]] || null;
  return null;
}
// "Legend of Zelda, The: A Link to the Past (USA)" and "The Legend of Zelda - A Link to the Past" match.
function norm(t) {
  return String(t || '').toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]|~[^~]*~/g, ' ')
    .replace(/^(.*?),\s*the\b/, 'the $1')
    .replace(/&/g, ' and ').replace(/\bii\b/g, '2').replace(/\biii\b/g, '3').replace(/\biv\b/g, '4')
    .replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');
}
function findGame(list, title) {
  const want = norm(title);
  if (!want) return null;
  let starts = null;
  for (const g of list || []) {
    for (const name of String(g.Title || g.title || '').split(' | ')) {
      const n = norm(name);
      if (n === want) return g;
      if (!starts && want.length >= 6 && n.length >= 6 && (n.startsWith(want) || want.startsWith(n))) starts = g;
    }
  }
  return starts;
}

function createRetroAch(userDataDir, safeStorage, opts) {
  opts = opts || {};
  const doFetch = opts.fetch || ((...a) => fetch(...a));
  const now = opts.now || Date.now;
  const file = path.join(userDataDir, 'retroachievements.json');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) { data = {}; }
  const save = () => { try { fs.mkdirSync(userDataDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); } catch (_) { /* not critical */ } };
  const lists = new Map(), progressCache = new Map();
  function key() {
    if (!data.key) return null;
    try { return data.key.enc && safeStorage && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(data.key.enc, 'base64')) : data.key.plain || null; } catch (_) { return null; }
  }
  async function get(endpoint, params) {
    const q = Object.entries(params).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
    const res = await doFetch(API + endpoint + '?' + q, { headers: { Accept: 'application/json', 'User-Agent': 'CouchLauncher' }, signal: AbortSignal.timeout(20000) });
    if (res.status === 401 || res.status === 403) throw new Error('RetroAchievements didn’t accept that username and key');
    if (!res.ok) throw new Error('RetroAchievements: HTTP ' + res.status);
    return res.json();
  }
  const status = () => ({ connected: !!(data.user && key()), user: data.user || null });
  async function connect(user, apiKey) {
    user = String(user || '').trim(); apiKey = String(apiKey || '').trim();
    if (!user || !apiKey) throw new Error('Enter your RetroAchievements username and Web API key');
    const p = await get('API_GetUserProfile.php', { u: user, y: apiKey });
    if (!p || (!p.User && !p.user)) throw new Error('RetroAchievements didn’t find that user');
    data.user = p.User || p.user;
    data.key = safeStorage && safeStorage.isEncryptionAvailable() ? { enc: safeStorage.encryptString(apiKey).toString('base64') } : { plain: apiKey };
    save();
    return status();
  }
  function disconnect() { data = { matches: data.matches || {} }; progressCache.clear(); save(); return status(); }
  // The system's list of games with achievements (kept a week on disk).
  async function gameList(sys) {
    if (lists.has(sys)) return lists.get(sys);
    const f = path.join(userDataDir, 'ra-games-' + sys + '.json');
    try { const c = JSON.parse(fs.readFileSync(f, 'utf8')); if (now() - c.at < 7 * 864e5) { lists.set(sys, c.list); return c.list; } } catch (_) { /* fetch it */ }
    const raw = await get('API_GetGameList.php', { i: sys, f: 1, y: key() });
    const list = (Array.isArray(raw) ? raw : []).map((g) => ({ ID: g.ID || g.id, Title: g.Title || g.title, NumAchievements: g.NumAchievements || g.numAchievements || 0 }));
    lists.set(sys, list);
    try { fs.writeFileSync(f, JSON.stringify({ at: now(), list })); } catch (_) { /* fine */ }
    return list;
  }
  // { got, total, points?, recent: [names], title, raId } or null
  async function progress(game) {
    if (!status().connected) return null;
    const sys = systemOf(game);
    if (!sys) return null;
    data.matches = data.matches || {};
    let raId = data.matches[game.id];
    if (raId === undefined) {
      const hit = findGame(await gameList(sys), game.title);
      raId = data.matches[game.id] = hit ? hit.ID : null;
      save();
    }
    if (!raId) return null;
    const c = progressCache.get(raId);
    if (c && now() - c.at < 10 * 60e3) return c.value;
    const p = await get('API_GetGameInfoAndUserProgress.php', { g: raId, u: data.user, y: key() });
    const list = Object.values((p && p.Achievements) || {});
    const earned = list.filter((a) => a.DateEarned || a.DateEarnedHardcore).sort((a, b) => String(b.DateEarnedHardcore || b.DateEarned).localeCompare(String(a.DateEarnedHardcore || a.DateEarned)));
    const value = {
      got: Number(p && p.NumAwardedToUser) || earned.length, total: Number(p && p.NumAchievements) || list.length,
      recent: earned.slice(0, 3).map((a) => String(a.Title || '')), title: p && p.Title, raId,
      icon: p && p.ImageIcon ? MEDIA + p.ImageIcon : null, source: 'RetroAchievements'
    };
    progressCache.set(raId, { at: now(), value });
    return value;
  }
  return { status, connect, disconnect, progress, systemOf };
}

module.exports = { createRetroAch, systemOf, norm, findGame, SYS };
