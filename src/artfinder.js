'use strict';
// Finds tile images and backgrounds by game name on SteamGridDB (free key from
// https://www.steamgriddb.com/profile/preferences/api), and saves them next to your other art.
const fs = require('fs');
const path = require('path');

const API = 'https://www.steamgriddb.com/api/v2';

function createArtFinder(userDataDir, safeStorage, artDir) {
  const keyFile = path.join(userDataDir, 'steamgriddb.json');

  function readKey() {
    try {
      const j = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
      if (j.enc && safeStorage && safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(Buffer.from(j.enc, 'base64'));
      return j.plain || null;
    } catch (_) { return null; }
  }
  function writeKey(k) {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(keyFile, JSON.stringify(safeStorage && safeStorage.isEncryptionAvailable()
      ? { enc: safeStorage.encryptString(k).toString('base64') } : { plain: k }));
  }

  async function get(url, key) {
    let res;
    try { res = await fetch(API + url, { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(15000) }); }
    catch (_) { throw new Error('Couldn’t reach SteamGridDB. Check your internet connection.'); }
    if (res.status === 401 || res.status === 403) throw new Error('That SteamGridDB key didn’t work. Copy it again from your SteamGridDB API settings.');
    if (res.status === 404) return { data: [] };
    if (res.status === 429) throw new Error('SteamGridDB is busy. Try again in a minute.');
    if (!res.ok) throw new Error('SteamGridDB answered with an error (' + res.status + ').');
    const j = await res.json();
    if (j && j.success === false) throw new Error((j.errors && j.errors[0]) || 'SteamGridDB couldn’t do that');
    return j;
  }

  // Most-liked image first; still images over animated ones.
  const best = (list) => (list || []).filter((x) => x && x.url && !/\.(webm|gif)(\?|$)/i.test(x.url) && x.mime !== 'image/gif')
    .sort((a, b) => (b.score || 0) - (a.score || 0))[0] || null;

  async function download(url, gameId, kind) {
    let res;
    try { res = await fetch(url, { signal: AbortSignal.timeout(30000) }); } catch (_) { throw new Error('Couldn’t download the image'); }
    if (!res.ok) throw new Error('Couldn’t download the image (' + res.status + ')');
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = (/\.(png|jpe?g|webp)(\?|$)/i.exec(url) || [, 'png'])[1].toLowerCase().replace('jpeg', 'jpg');
    fs.mkdirSync(artDir, { recursive: true });
    const safeId = String(gameId).replace(/[^a-z0-9_-]/gi, '');
    const dest = path.join(artDir, safeId + '-' + kind + '-sgdb-' + Date.now() + '.' + ext);
    fs.writeFileSync(dest, buf);
    return dest;
  }

  return {
    connected: () => !!readKey(),
    async connect(key) {
      const k = String(key || '').trim();
      if (k.length < 20) throw new Error('That doesn’t look like a SteamGridDB API key.');
      await get('/search/autocomplete/' + encodeURIComponent('Portal'), k); // checks the key works
      writeKey(k);
      return true;
    },
    disconnect() { try { fs.unlinkSync(keyFile); } catch (_) { /* gone */ } },
    // Returns { tile, hero } file paths for whatever was found (either may be null).
    async find(title, gameId, want) {
      const key = readKey();
      if (!key) throw new Error('NO_KEY');
      const q = String(title || '').replace(/[™®©]/g, '').trim();
      if (!q) return { tile: null, hero: null };
      const s = await get('/search/autocomplete/' + encodeURIComponent(q), key);
      const game = (s.data || [])[0];
      if (!game) return { tile: null, hero: null, notFound: true };
      const out = { tile: null, hero: null, name: game.name };
      if (!want || want.tile) {
        // Square tiles fit this launcher best; fall back to tall covers.
        let g = await get('/grids/game/' + game.id + '?dimensions=512x512,1024x1024&types=static', key);
        let pick = best(g.data);
        if (!pick) { g = await get('/grids/game/' + game.id + '?dimensions=600x900&types=static', key); pick = best(g.data); }
        if (pick) out.tile = await download(pick.url, gameId, 'tile');
      }
      if (!want || want.hero) {
        const h = await get('/heroes/game/' + game.id + '?types=static', key);
        const pick = best(h.data);
        if (pick) out.hero = await download(pick.url, gameId, 'hero');
      }
      return out;
    }
  };
}

module.exports = { createArtFinder };
