'use strict';
// Stores the library (games, platform setup, settings) as JSON and merges scan results into it.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SETTINGS = {
  theme: 'original',
  corners: 'rounded',
  accent: null,          // null = the theme's own accent
  useArtBackground: true,
  reduceMotion: false,
  autostart: true,
  userName: 'Player',
  avatar: null,          // custom picture (path), used when not showing the Xbox gamerpic
  useXboxProfile: true,  // (older setting; profileFrom replaces it)
  profileFrom: null,     // 'xbox' | 'steam' | 'own': whose name and picture the launcher shows
  steamProfile: null,    // last known Steam profile { name, pic, level, games, at }
  xbox: null,            // last known Xbox profile { xuid, gamertag, gamerscore, pic, at }
  displayId: null,       // which monitor (null = main)
  musicApp: 'auto',      // 'auto' | 'AppleMusic' | 'Spotify'
  pauseGame: true,       // pause the game while the guide or launcher is in front
  customBg: null,        // your own Home background image (path)
  musicMouse: true,      // controller works as a mouse in Apple Music / Spotify / Discord
  discordPins: []        // [{ name, url }] Discord channels / servers / invites shown in the guide
};

const DEFAULT_PLATFORMS = {
  steam: { enabled: true },
  epic: { enabled: true },
  msstore: { enabled: true },
  roblox: { enabled: true },
  dolphin: { exe: '', dir: '' },
  rpcs3: { exe: '', dir: '' },
  ryujinx: { exe: '', dir: '' }
};

function makeId(key) {
  return crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 12);
}

function emptyLibrary() {
  return {
    version: 1,
    games: [],
    platforms: JSON.parse(JSON.stringify(DEFAULT_PLATFORMS)),
    settings: Object.assign({}, DEFAULT_SETTINGS)
  };
}

function normalize(data) {
  const lib = emptyLibrary();
  if (!data || typeof data !== 'object') return lib;
  if (Array.isArray(data.games)) lib.games = data.games.filter((g) => g && g.id && g.title && g.launch);
  if (data.platforms && typeof data.platforms === 'object') {
    for (const k of Object.keys(DEFAULT_PLATFORMS)) lib.platforms[k] = Object.assign({}, DEFAULT_PLATFORMS[k], data.platforms[k] || {});
  }
  if (data.settings && typeof data.settings === 'object') lib.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);
  for (const g of lib.games) {
    g.art = g.art || {};
    g.playtime = Number(g.playtime) || 0;
    g.lastPlayed = Number(g.lastPlayed) || 0;
    g.addedAt = Number(g.addedAt) || Date.now();
    g.favorite = !!g.favorite;
    g.pinned = !!g.pinned;
    g.coop = !!g.coop;
  }
  return lib;
}

function load(file) {
  try {
    return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (_) {
    // Fall back to the last good copy if the main file is damaged.
    try { return normalize(JSON.parse(fs.readFileSync(file + '.bak', 'utf8'))); } catch (__) { return emptyLibrary(); }
  }
}

function save(file, lib) {
  const data = JSON.stringify(normalize(lib), null, 2);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  if (fs.existsSync(file)) {
    try { fs.copyFileSync(file, file + '.bak'); } catch (_) { /* best effort */ }
  }
  fs.renameSync(tmp, file);
}

// Merge scanned games for one source into the library.
// Keeps everything the user changed (title, art, favorite, pinned, co-op, play time).
// Removes games of that source that are no longer installed.
function mergeScan(lib, source, scanned) {
  const byKey = new Map(lib.games.filter((g) => g.source === source).map((g) => [g.key, g]));
  const keep = new Set();
  for (const s of scanned) {
    keep.add(s.key);
    const g = byKey.get(s.key);
    if (g) {
      g.launch = s.launch;
      if (!g.titleEdited) g.title = s.title;
      g.art = g.art || {};
      for (const k of ['tile', 'hero', 'logo']) {
        if (!g.artEdited || !g.artEdited[k]) {
          if (s.art && s.art[k]) g.art[k] = s.art[k];
        }
      }
    } else {
      lib.games.push({
        id: makeId(s.key),
        key: s.key,
        source,
        title: s.title,
        launch: s.launch,
        art: Object.assign({}, s.art || {}),
        favorite: false,
        pinned: false,
        coop: false,
        playtime: 0,
        lastPlayed: 0,
        addedAt: Date.now()
      });
    }
  }
  lib.games = lib.games.filter((g) => g.source !== source || keep.has(g.key));
  return lib;
}

module.exports = { DEFAULT_SETTINGS, makeId, emptyLibrary, normalize, load, save, mergeScan };
