'use strict';
// Friends: joining their games, playing the same game, "played with recently", join alerts.
//
// What's possible:
//  - Steam tells other apps when a friend is in a lobby or on a server you can join (their
//    profile has to be public). Join then uses Steam's own join links, the same as "Join game"
//    in Steam's friends list. Steam doesn't let other apps read invites, so the launcher can't
//    show "X invited you"; it shows "X is in a game you can join" instead.
//  - Xbox doesn't let other apps join friends' games, so for Xbox friends it's "Play the same
//    game" (when you have it) or "Find it in the Store".
//  - "Played with recently" is recorded by the launcher itself: while you play, friends who are
//    in the same game at the same time are remembered for that game.

const fs = require('fs');
const path = require('path');

const norm = (t) => String(t || '').toLowerCase()
  .replace(/[™®©]/g, '')
  .replace(/\b(the|edition|remastered|definitive|goty|game of the year|deluxe|standard)\b/g, ' ')
  .replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');

const STEAM_ID = /^7656\d{13}$/;
const APP_ID = /^\d{1,10}$/;
const LOBBY = /^\d{15,20}$/;
const SERVER = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/;

function steamIdOf(f) { const m = /^steam-(\d+)$/.exec(String((f && f.xuid) || '')); return m && STEAM_ID.test(m[1]) ? m[1] : null; }
function steamAppOf(g) {
  const L = g && g.launch;
  const m = L && L.type === 'url' && /^steam:\/\/rungameid\/(\d+)$/.exec(String(L.url || ''));
  return m && APP_ID.test(m[1]) && Number(m[1]) < 2 ** 32 ? m[1] : null; // big numbers are non-Steam shortcuts
}
function validServer(s) {
  const m = SERVER.exec(String(s || ''));
  if (!m) return false;
  const parts = m.slice(1, 5).map(Number), port = Number(m[5]);
  if (parts.some((n) => n > 255) || !port || port > 65535) return false;
  return parts.join('.') !== '0.0.0.0';
}

// Steam's join link for a friend, or null when there's nothing to join.
function joinUrl(f) {
  if (!f || f.service !== 'steam') return null;
  const sid = steamIdOf(f);
  const app = String(f.gameid || '');
  if (!sid || !APP_ID.test(app)) return null;
  if (LOBBY.test(String(f.lobby || ''))) return 'steam://joinlobby/' + app + '/' + f.lobby + '/' + sid;
  if (validServer(f.server)) return 'steam://connect/' + f.server;
  return null;
}
// Where to get the game they're playing.
function storeUrl(f) {
  if (!f) return null;
  if (f.service === 'steam' && APP_ID.test(String(f.gameid || '')) && Number(f.gameid) < 2 ** 32) return 'steam://store/' + f.gameid;
  if (f.service !== 'steam' && f.game) return 'ms-windows-store://search/?query=' + encodeURIComponent(f.game);
  return null;
}
// The game in your library they're playing (Steam: same app; otherwise the same name).
function matchGame(f, games) {
  if (!f || !f.game && !f.gameid) return null;
  const list = (games || []).filter((g) => g && !g.hidden);
  if (f.service === 'steam' && f.gameid) {
    const hit = list.find((g) => steamAppOf(g) === String(f.gameid));
    if (hit) return hit.id;
  }
  const want = norm(f.game);
  if (want.length < 2) return null;
  const hit = list.find((g) => norm(g.title) === want);
  return hit ? hit.id : null;
}
// Adds what the launcher can do for each friend: join, play (your copy), store.
function decorate(list, games) {
  return (list || []).map((f) => Object.assign({}, f, {
    id: f.xuid,
    owned: f.game || f.gameid ? matchGame(f, games) : null,
    joinable: !!joinUrl(f),
    store: !!storeUrl(f)
  }));
}

function createFriends({ userDataDir, now }) {
  now = now || Date.now;
  const file = path.join(userDataDir, 'played-with.json');
  let data = null;
  const load = () => { if (!data) { try { data = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) { data = {}; } } return data; };
  const save = () => { try { fs.mkdirSync(userDataDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); } catch (_) { /* not critical */ } };
  const cache = new Map(); // friend id -> newest info
  const joinSeen = new Map(); // friend id -> what they were joinable in ('' when not)
  const learned = { steam: false, xbox: false };
  const joinable = new Map(); // friend id -> { at } (recent join alerts)

  function remember(list) { for (const f of list || []) if (f && f.id) cache.set(f.id, f); }
  const get = (id) => cache.get(String(id || '')) || null;
  const all = (svc) => [...cache.values()].filter((f) => (f.service || 'xbox') === svc);

  // Friends in the game you're playing right now (call every few minutes while playing).
  function record(gameId, game, list, minutes) {
    if (!gameId || !game) return [];
    const app = steamAppOf(game), title = norm(game.title);
    const together = (list || []).filter((f) => f && f.online && (
      (f.service === 'steam' && app && String(f.gameid || '') === app) ||
      (title.length >= 2 && norm(f.game) === title)));
    if (!together.length) return [];
    const all = load();
    const g = all[gameId] || (all[gameId] = {});
    const t = now();
    for (const f of together) {
      const e = g[f.id] || (g[f.id] = { first: t, mins: 0 });
      e.name = f.gamertag; e.pic = f.pic || null; e.service = f.service || 'xbox'; e.last = t;
      e.mins = (e.mins || 0) + (minutes || 0);
    }
    // Keep it small: 20 people per game, 300 games.
    const ids = Object.keys(g).sort((a, b) => g[b].last - g[a].last);
    for (const id of ids.slice(20)) delete g[id];
    const games = Object.keys(all);
    if (games.length > 300) {
      const newest = (k) => Math.max(0, ...Object.values(all[k]).map((e) => e.last || 0));
      games.sort((a, b) => newest(b) - newest(a)).slice(300).forEach((k) => delete all[k]);
    }
    save();
    return together.map((f) => f.id);
  }
  function playedWith(gameId) {
    const g = load()[gameId] || {};
    return Object.keys(g).map((id) => Object.assign({ id }, g[id])).sort((a, b) => b.last - a.last).slice(0, 12);
  }
  // Everyone you've played with lately, newest first (each with the games).
  function recent(limit) {
    const all = load(), people = new Map();
    for (const [gameId, g] of Object.entries(all)) {
      for (const [id, e] of Object.entries(g)) {
        const p = people.get(id) || { id, name: e.name, pic: e.pic, service: e.service, last: 0, games: [] };
        p.games.push({ gameId, last: e.last, mins: e.mins || 0 });
        if (e.last > p.last) { p.last = e.last; p.name = e.name; p.pic = e.pic || p.pic; }
        people.set(id, p);
      }
    }
    return [...people.values()].map((p) => Object.assign(p, { games: p.games.sort((a, b) => b.last - a.last) }))
      .sort((a, b) => b.last - a.last).slice(0, limit || 20);
  }
  const withFriend = (id) => { const p = recent(1000).find((x) => x.id === id); return p ? p.games : []; };

  // Friends who just started something you can join. The first check for each service only
  // learns what's going on (no alerts for games that were already running).
  function newlyJoinable(svc, list) {
    const out = [];
    for (const f of list || []) {
      if (!f || !f.id) continue;
      const url = joinUrl(f) || '';
      const before = joinSeen.get(f.id);
      if (learned[svc] && url && before !== url && !before) out.push(f);
      joinSeen.set(f.id, url);
      if (url && (before !== url)) joinable.set(f.id, { at: now() });
      if (!url) joinable.delete(f.id);
    }
    learned[svc] = true;
    return out;
  }
  // Join alerts from the last 20 minutes that are still joinable.
  function recentJoinable() {
    const t = now(), out = [];
    for (const [id, j] of joinable) {
      const f = cache.get(id);
      if (t - j.at > 20 * 60e3 || !f || !joinUrl(f)) { joinable.delete(id); continue; }
      out.push(Object.assign({}, f, { alertAt: j.at }));
    }
    return out.sort((a, b) => b.alertAt - a.alertAt);
  }

  return { remember, get, all, record, playedWith, recent, withFriend, newlyJoinable, recentJoinable };
}

module.exports = { createFriends, joinUrl, storeUrl, matchGame, decorate, steamAppOf, steamIdOf, norm, validServer };
