'use strict';
// Steam friends through the official Steam Web API. You make a free key at
// https://steamcommunity.com/dev/apikey; your Steam ID is read from this PC's Steam login.
const fs = require('fs');
const path = require('path');

const API = 'https://api.steampowered.com';
const STATES = ['Offline', 'Online', 'Busy', 'Away', 'Snooze', 'Looking to trade', 'Looking to play'];

function createSteam(userDataDir, safeStorage, steamRoot) {
  const file = path.join(userDataDir, 'steam.json');

  function read() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const key = j.enc && safeStorage && safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(Buffer.from(j.enc, 'base64')) : j.plain;
      return key && j.steamid ? { key, steamid: j.steamid } : null;
    } catch (_) { return null; }
  }
  function write(key, steamid) {
    fs.mkdirSync(userDataDir, { recursive: true });
    const data = safeStorage && safeStorage.isEncryptionAvailable()
      ? { enc: safeStorage.encryptString(key).toString('base64'), steamid } : { plain: key, steamid };
    fs.writeFileSync(file, JSON.stringify(data));
  }

  // The account last signed in to Steam on this PC.
  function localSteamId() {
    const root = steamRoot && steamRoot();
    if (!root) return null;
    let text;
    try { text = fs.readFileSync(path.join(root, 'config', 'loginusers.vdf'), 'utf8'); } catch (_) { return null; }
    const re = /"(7656\d{13})"\s*\{([^}]*)\}/g;
    let m, first = null;
    while ((m = re.exec(text))) {
      if (!first) first = m[1];
      if (/"MostRecent"\s*"1"/i.test(m[2])) return m[1];
    }
    return first;
  }

  async function get(url) {
    let res;
    try { res = await fetch(url, { signal: AbortSignal.timeout(15000) }); }
    catch (_) { throw new Error('Couldn’t reach Steam. Check your internet connection.'); }
    if (res.status === 401) throw new Error('Steam says your friends list is private. In Steam: Profile › Edit Profile › Privacy Settings › Friends List: Public.');
    if (res.status === 403) throw new Error('That Steam API key didn’t work. Copy it again from steamcommunity.com/dev/apikey.');
    if (res.status === 429) throw new Error('Too many Steam requests right now. Try again in a minute.');
    if (!res.ok) throw new Error('Steam answered with an error (' + res.status + ').');
    try { return await res.json(); } catch (_) { throw new Error('Steam sent something unexpected.'); }
  }

  const person = (p) => {
    const state = Number(p.personastate) || 0;
    const game = p.gameextrainfo || '';
    return {
      xuid: 'steam-' + p.steamid,
      gamertag: p.personaname || 'Steam friend',
      pic: p.avatarmedium || p.avatar || null,
      online: state > 0 || !!game,
      status: game ? 'Playing ' + game : STATES[state] || 'Online',
      favorite: false,
      service: 'steam',
      steamid: p.steamid,
      game: game || null,
      gameid: p.gameid ? String(p.gameid) : null,
      // Set when they're in a lobby or on a server you can join (and their profile is public).
      lobby: p.lobbysteamid && p.lobbysteamid !== '0' ? String(p.lobbysteamid) : null,
      server: p.gameserverip && !/^0\.0\.0\.0/.test(p.gameserverip) ? String(p.gameserverip) : null,
      picBig: p.avatarfull || null
    };
  };
  const appImg = (appid) => 'https://cdn.cloudflare.steamstatic.com/steam/apps/' + appid + '/header.jpg';
  async function achOf(key, steamid, appid) {
    let j;
    try { j = await get(API + '/ISteamUserStats/GetPlayerAchievements/v1/?key=' + encodeURIComponent(key) + '&steamid=' + steamid + '&appid=' + appid + '&l=english'); }
    catch (_) { return null; } // no achievements, or game details are private
    const list = (j.playerstats && j.playerstats.achievements) || [];
    if (!list.length) return null;
    const got = list.filter((a) => a.achieved === 1);
    return { got: got.length, total: list.length, recent: got.sort((a, b) => (b.unlocktime || 0) - (a.unlocktime || 0)).slice(0, 3).map((a) => a.name || a.apiname) };
  }

  async function summaries(key, ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 100) {
      const j = await get(API + '/ISteamUser/GetPlayerSummaries/v2/?key=' + encodeURIComponent(key) + '&steamids=' + ids.slice(i, i + 100).join(','));
      out.push(...((j.response && j.response.players) || []));
    }
    return out;
  }

  async function resolveId(key, input) {
    const s = String(input || '').trim();
    const id = (/(7656\d{13})/.exec(s) || [])[1];
    if (id) return id;
    const vanity = (/steamcommunity\.com\/id\/([^/?#]+)/i.exec(s) || [])[1] || (/^[A-Za-z0-9_-]{2,32}$/.test(s) ? s : null);
    if (!vanity) return null;
    const j = await get(API + '/ISteamUser/ResolveVanityURL/v1/?key=' + encodeURIComponent(key) + '&vanityurl=' + encodeURIComponent(vanity));
    return j.response && j.response.success === 1 ? j.response.steamid : null;
  }

  return {
    connected: () => !!read(),
    localSteamId,
    // profile: optional Steam profile link or ID when this PC's login can't be found.
    async connect(key, profile) {
      const k = String(key || '').trim();
      if (!/^[A-Fa-f0-9]{32}$/.test(k)) throw new Error('That doesn’t look like a Steam API key (32 letters and numbers).');
      const steamid = profile ? await resolveId(k, profile) : localSteamId();
      if (!steamid) throw new Error(profile ? 'Couldn’t find that Steam profile.' : 'NEED_PROFILE');
      const me = await summaries(k, [steamid]);
      if (!me.length) throw new Error('Couldn’t find that Steam profile.');
      write(k, steamid);
      return { name: me[0].personaname, steamid };
    },
    disconnect() { try { fs.unlinkSync(file); } catch (_) { /* already gone */ } },
    // Your achievement progress in one Steam game: { got, total, recent: [names] } or null.
    async achievements(appid) {
      const c = read();
      if (!c) throw new Error('Steam not connected');
      if (!/^\d{1,10}$/.test(String(appid))) return null;
      return achOf(c.key, c.steamid, appid);
    },
    // A friend's profile: name, picture, level, games, what they've played lately.
    async profile(steamid) {
      const c = read();
      if (!c) throw new Error('Steam not connected');
      steamid = String(steamid || '');
      if (!/^7656\d{13}$/.test(steamid)) throw new Error('Unknown Steam friend');
      const [p] = await summaries(c.key, [steamid]);
      if (!p) throw new Error('Couldn’t load that Steam profile');
      const f = person(p);
      let level = null, games = null, recent = [], badges = null, xp = null, friends = null, ownedList = [];
      const open = Number(p.communityvisibilitystate) === 3; // 3 = public
      const q = '?key=' + encodeURIComponent(c.key) + '&steamid=' + steamid;
      if (open) {
        await Promise.all([
          // Level, badges and XP toward the next level (falls back to just the level).
          get(API + '/IPlayerService/GetBadges/v1/' + q).then((j) => {
            const r = j.response || {};
            if (typeof r.player_level === 'number') level = r.player_level;
            if (Array.isArray(r.badges)) badges = r.badges.length;
            if (typeof r.player_xp === 'number') xp = { total: r.player_xp, toNext: Number(r.player_xp_needed_to_level_up) || 0, thisLevel: Number(r.player_xp_needed_current_level) || 0 };
          }, () => get(API + '/IPlayerService/GetSteamLevel/v1/' + q).then((j) => { level = j.response && typeof j.response.player_level === 'number' ? j.response.player_level : null; }, () => {})),
          get(API + '/IPlayerService/GetOwnedGames/v1/' + q + '&include_played_free_games=1&include_appinfo=1').then((j) => {
            const r = j.response || {};
            games = typeof r.game_count === 'number' ? r.game_count : null;
            // What they own (for "games you both have").
            ownedList = (Array.isArray(r.games) ? r.games : []).filter((g) => g && g.appid).map((g) => ({ appid: String(g.appid), title: g.name || '', hours: Math.round((g.playtime_forever || 0) / 6) / 10 }));
          }, () => {}),
          get(API + '/ISteamUser/GetFriendList/v1/' + q + '&relationship=friend').then((j) => { friends = ((j.friendslist && j.friendslist.friends) || []).length || null; }, () => {}),
          get(API + '/IPlayerService/GetRecentlyPlayedGames/v1/' + q + '&count=8').then((j) => {
            recent = ((j.response && j.response.games) || []).filter((g) => g && g.appid).map((g) => ({
              appid: String(g.appid), title: g.name || 'Steam game', img: appImg(g.appid),
              hours: Math.round((g.playtime_forever || 0) / 6) / 10, hours2w: Math.round((g.playtime_2weeks || 0) / 6) / 10
            }));
          }, () => {})
        ]);
        // Achievements in their latest games: theirs, and yours next to them.
        await Promise.all(recent.slice(0, 4).map(async (r) => {
          const [theirs, mine] = await Promise.all([achOf(c.key, steamid, r.appid), achOf(c.key, c.steamid, r.appid)]);
          if (theirs) r.ach = theirs;
          if (mine) r.mine = mine;
        }));
      }
      // Big artwork of what they're playing (or played last) for the top of their profile.
      const artApp = f.gameid && Number(f.gameid) < 2 ** 32 ? f.gameid : recent[0] && recent[0].appid;
      const art = artApp ? ['https://cdn.cloudflare.steamstatic.com/steam/apps/' + artApp + '/library_hero.jpg', appImg(artApp)] : [];
      return Object.assign(f, { id: f.xuid, name: f.gamertag, pic: f.picBig || f.pic, level, games, recent, private: !open, badges, xp, friends, ownedList, art,
        country: p.loccountrycode || null, realName: p.realname || null,
        since: p.timecreated ? p.timecreated * 1000 : null, lastOnline: p.lastlogoff ? p.lastlogoff * 1000 : null });
    },
    // Your achievements next to a friend's for one game.
    async compare(steamid, appid) {
      const c = read();
      if (!c) throw new Error('Steam not connected');
      if (!/^7656\d{13}$/.test(String(steamid)) || !/^\d{1,10}$/.test(String(appid))) return null;
      const [mine, theirs] = await Promise.all([achOf(c.key, c.steamid, appid), achOf(c.key, String(steamid), appid)]);
      return mine || theirs ? { mine, theirs } : null;
    },
    // Your own Steam name, picture, level and game count (for the launcher's profile).
    async me() {
      const c = read();
      if (!c) throw new Error('Steam not connected');
      const [p] = await summaries(c.key, [c.steamid]);
      if (!p) throw new Error('Couldn’t load your Steam profile');
      let level = null, games = null;
      try { const j = await get(API + '/IPlayerService/GetSteamLevel/v1/?key=' + encodeURIComponent(c.key) + '&steamid=' + c.steamid); level = j.response && typeof j.response.player_level === 'number' ? j.response.player_level : null; } catch (_) { /* private profile */ }
      try { const j = await get(API + '/IPlayerService/GetOwnedGames/v1/?key=' + encodeURIComponent(c.key) + '&steamid=' + c.steamid + '&include_played_free_games=1'); games = j.response && typeof j.response.game_count === 'number' ? j.response.game_count : null; } catch (_) { /* private game list */ }
      return { name: p.personaname || 'Steam', pic: p.avatarfull || p.avatarmedium || null, level, games, at: Date.now() };
    },
    async friends() {
      const c = read();
      if (!c) throw new Error('Steam not connected');
      const j = await get(API + '/ISteamUser/GetFriendList/v1/?key=' + encodeURIComponent(c.key) + '&steamid=' + c.steamid + '&relationship=friend');
      const ids = ((j.friendslist && j.friendslist.friends) || []).map((f) => f.steamid);
      if (!ids.length) return [];
      return (await summaries(c.key, ids)).map(person)
        .sort((a, b) => (b.online - a.online) || a.gamertag.localeCompare(b.gamertag));
    }
  };
}

module.exports = { createSteam };
