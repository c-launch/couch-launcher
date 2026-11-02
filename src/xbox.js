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
    return people.map((p) => {
      const online = String(p.presenceState || '').toLowerCase() === 'online';
      return {
        xuid: String(p.xuid || ''),
        gamertag: p.modernGamertag || p.gamertag || p.displayName || 'Friend',
        name: p.realName || '',
        pic: p.displayPicRaw || null,
        online,
        status: p.presenceText || p.presenceState || '',
        gamerscore: Number(p.gamerScore) || 0,
        favorite: !!p.isFavorite,
        service: 'xbox',
        game: online ? gameOf(p) : null
      };
    }).sort((a, b) => (b.online - a.online) || (b.favorite - a.favorite) || a.gamertag.localeCompare(b.gamertag));
  }

  // Not games: what the Xbox shows when someone is on the dashboard or in an app.
  const NOT_GAMES = /^(online|offline|away|busy|home|xbox|xbox app|xbox home|xbox console companion|microsoft store|store|settings|guide|last seen.*|looking for group|netflix|youtube|spotify.*|twitch|disney\+?|hulu|prime video|amazon prime video|max|hbo max|plex|edge|microsoft edge|apple tv|apple music|xbox game bar|game bar)$/i;
  function gameOf(p) {
    const d = (Array.isArray(p.presenceDetails) ? p.presenceDetails : []).find((x) => x && x.IsGame && String(x.State || '').toLowerCase() === 'active' && x.PresenceText);
    let t = d ? String(d.PresenceText) : String(p.presenceText || '');
    // Rich presence like "Halo Infinite - In a match": the game is the first part.
    if (!d) t = t.split(/\s[-–|:]\s/)[0];
    t = t.trim();
    return t && !NOT_GAMES.test(t) && t.length <= 80 ? t : null;
  }
  function parseTitles(j) {
    const titles = j.titles || (j.content && j.content.titles) || [];
    return titles.filter((t) => t && t.name && (t.type === 'Game' || !t.type || (Array.isArray(t.devices) && t.devices.length))).map((t) => {
      const a = t.achievement || {};
      return {
        title: String(t.name), titleId: t.titleId ? String(t.titleId) : null, img: t.displayImage || null,
        gamerscore: Number(a.currentGamerscore) || 0, total: Number(a.totalGamerscore) || 0, pct: Number(a.progressPercentage) || 0,
        last: Date.parse((t.titleHistory && t.titleHistory.lastTimePlayed) || '') || 0,
        achievements: Number(a.currentAchievements) || 0
      };
    }).sort((a, b) => b.last - a.last);
  }
  // A friend's Xbox profile: gamerpic, gamerscore and what they've played lately.
  async function friendProfile(xuid) {
    xuid = String(xuid || '');
    if (!/^\d{1,20}$/.test(xuid)) throw new Error('Unknown Xbox friend');
    const raw = await call('/account/' + xuid);
    const acc = parseAccount(raw);
    const u = settingsOf(raw) || {};
    const set = (k) => { const x = (Array.isArray(u.settings) ? u.settings : []).find((y) => y.id === k); return x && x.value ? String(x.value) : null; };
    let titles = [];
    for (const ep of ['/player/titleHistory/' + xuid, '/achievements/player/' + xuid]) {
      try { titles = parseTitles(await call(ep)); if (titles.length) break; } catch (_) { /* try the other */ }
    }
    const rep = { GoodPlayer: 'Good player', NeedsWork: 'Needs work', AvoidMe: 'Avoid me' }[set('XboxOneRep')] || null;
    const tenure = Number(set('TenureLevel')) || null;
    // Their profile colour (Xbox › Profile › Customize), when it's sent.
    let color = null;
    const pc = set('PreferredColor');
    if (pc && /^https?:\/\/[a-z0-9.-]+\.xboxlive\.com\//i.test(pc)) { try { const cj = await (await fetch(pc, { signal: AbortSignal.timeout(5000) })).json(); if (/^[0-9a-f]{6}$/i.test(cj.primaryColor || '')) color = '#' + cj.primaryColor; } catch (_) { /* default colour */ } }
    return {
      id: xuid, xuid, service: 'xbox', name: acc.gamertag, gamertag: acc.gamertag, pic: acc.pic, gamerscore: acc.gamerscore,
      recent: titles.slice(0, 8), games: titles.length || null,
      achievements: titles.reduce((n, t) => n + (t.achievements || 0), 0) || null,
      completed: titles.filter((t) => t.pct >= 100).length || null,
      tier: set('AccountTier'), rep, tenure, realName: set('RealName'), bio: set('Bio'), location: set('Location'), color
    };
  }

  return {
    connected: () => !!readKey(),
    friendProfile,
    _parse: { friends: (j) => parseFriends(j), titles: (j) => parseTitles(j) },
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

