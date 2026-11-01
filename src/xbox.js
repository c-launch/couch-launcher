'use strict';
// Xbox profile (gamerscore, gamerpic) and friends list through OpenXBL (https://xbl.io),
// a free service: sign in there with your Microsoft account and copy your API key.
// The key is kept in its own file, encrypted with Windows' protection (DPAPI) when available.

const fs = require('fs');
const path = require('path');

const BASE = 'https://xbl.io/api/v2';

function createXbox(userDataDir, safeStorage) {
  const keyFile = path.join(userDataDir, 'xbox.json');

  function readKey() {
    try {
      const j = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
      if (j.enc && safeStorage && safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(Buffer.from(j.enc, 'base64'));
      if (j.plain) return j.plain;
    } catch (_) { /* no key yet */ }
    return null;
  }
  function writeKey(key) {
    fs.mkdirSync(userDataDir, { recursive: true });
    const data = safeStorage && safeStorage.isEncryptionAvailable()
      ? { enc: safeStorage.encryptString(key).toString('base64') }
      : { plain: key };
    fs.writeFileSync(keyFile, JSON.stringify(data));
  }
  function clearKey() { try { fs.unlinkSync(keyFile); } catch (_) { /* already gone */ } }

  async function call(endpoint, key) {
    const k = key || readKey();
    if (!k) throw new Error('Xbox account not connected');
    let res;
    try {
      res = await fetch(BASE + endpoint, {
        headers: { 'X-Authorization': k, Accept: 'application/json', 'Accept-Language': 'en-US', 'X-Contract': '100' },
        signal: AbortSignal.timeout(15000)
      });
    } catch (_) {
      throw new Error('Couldn’t reach xbl.io. Check your internet connection.');
    }
    if (res.status === 401 || res.status === 403) throw new Error('That API key didn’t work. Copy it again from xbl.io.');
    if (res.status === 429) throw new Error('Too many Xbox requests right now. Try again in a few minutes.');
    if (!res.ok) throw new Error('xbl.io answered with an error (' + res.status + ').');
    try { return await res.json(); } catch (_) { throw new Error('xbl.io sent something unexpected.'); }
  }

  const settingsOf = (j) => {
    const users = j.profileUsers || (j.content && j.content.profileUsers) || [];
    return users[0] || null;
  };
  function parseAccount(j) {
    const u = settingsOf(j);
    if (!u) throw new Error('xbl.io sent a profile in an unexpected format.');
    const list = Array.isArray(u.settings) ? u.settings : [];
    const get = (id) => { const s = list.find((x) => x.id === id); return s ? s.value : undefined; };
    const gamertag = get('Gamertag') || get('ModernGamertag') || get('GameDisplayName');
    if (!gamertag) throw new Error('xbl.io sent a profile without a gamertag.');
    return {
      xuid: String(u.id || ''),
      gamertag,
      gamerscore: Number(get('Gamerscore')) || 0,
      pic: get('GameDisplayPicRaw') || get('PublicGamerpic') || null,
      at: Date.now()
    };
  }
  function parseFriends(j) {
    const people = j.people || (j.content && j.content.people) || [];
    return people.map((p) => ({
      xuid: String(p.xuid || ''),
      gamertag: p.modernGamertag || p.gamertag || p.displayName || 'Friend',
      name: p.realName || '',
      pic: p.displayPicRaw || null,
      online: String(p.presenceState || '').toLowerCase() === 'online',
      status: p.presenceText || p.presenceState || '',
      gamerscore: Number(p.gamerScore) || 0,
      favorite: !!p.isFavorite
    })).sort((a, b) => (b.online - a.online) || (b.favorite - a.favorite) || a.gamertag.localeCompare(b.gamertag));
  }

  return {
    connected: () => !!readKey(),
    async connect(key) {
      const k = String(key || '').trim();
      if (k.length < 10) throw new Error('That doesn’t look like an API key.');
      const profile = parseAccount(await call('/account', k)); // test it before saving
      writeKey(k);
      return profile;
    },
    disconnect: clearKey,
    profile: async () => parseAccount(await call('/account')),
    friends: async () => parseFriends(await call('/friends'))
  };
}

module.exports = { createXbox };
