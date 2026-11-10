'use strict';
// Playtime stats: every game session is written down (game, when, how long), and the Stats
// page is worked out from that plus each game's total play time (which goes back further than
// the session list).

const fs = require('fs');
const { readJson, writeJson } = require('./safefile');
const path = require('path');

const DAY = 864e5;
const MAX_SESSIONS = 20000; // years of play; older ones are dropped

// Local midnight of a time, and the Monday that starts its week.
const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const weekStart = (t) => { const d = new Date(dayStart(t)); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); return d.getTime(); };
const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); };
const hours = (s) => Math.round((s / 3600) * 10) / 10;

function compute(sessions, games, now) {
  now = now || Date.now();
  sessions = (sessions || []).filter((s) => s && s.seconds > 0 && s.start > 0 && s.start <= now);
  const byId = new Map((games || []).map((g) => [g.id, g]));
  const titleOf = (id, fallback) => (byId.get(id) && byId.get(id).title) || fallback || 'A game';

  // Weeks (Monday to Sunday), the last 12, oldest first.
  const thisWeek = weekStart(now);
  const weeks = [];
  for (let i = 11; i >= 0; i--) weeks.push({ start: addDays(thisWeek, -7 * i), seconds: 0 });
  for (const s of sessions) {
    const w = weekStart(s.start);
    const slot = weeks.find((x) => x.start === w);
    if (slot) slot.seconds += s.seconds;
  }
  // Days played, and streaks of days in a row.
  const days = new Set(sessions.map((s) => dayStart(s.start)));
  const today = dayStart(now);
  let streak = 0;
  for (let d = days.has(today) ? today : addDays(today, -1); days.has(d); d = addDays(d, -1)) streak++;
  let best = 0, run = 0, prev = null;
  for (const d of [...days].sort((a, b) => a - b)) {
    run = prev != null && addDays(prev, 1) === d ? run + 1 : 1;
    best = Math.max(best, run); prev = d;
  }
  const todaySeconds = sessions.filter((s) => dayStart(s.start) === today).reduce((n, s) => n + s.seconds, 0);

  // All time, by each game's total (that includes time from before sessions were written down).
  const visible = (games || []).filter((g) => (g.playtime || 0) > 0);
  const total = visible.reduce((n, g) => n + (g.playtime || 0), 0);
  const top = visible.slice().sort((a, b) => b.playtime - a.playtime).slice(0, 8)
    .map((g) => ({ gameId: g.id, title: g.title, hours: hours(g.playtime), share: total ? Math.round((g.playtime / total) * 100) : 0 }));

  // This year.
  const yearStart = new Date(new Date(now).getFullYear(), 0, 1).getTime();
  const ys = sessions.filter((s) => s.start >= yearStart);
  const perGame = new Map();
  for (const s of ys) perGame.set(s.gameId, (perGame.get(s.gameId) || 0) + s.seconds);
  const yearTop = [...perGame.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([id, sec]) => ({ gameId: id, title: titleOf(id, (ys.find((s) => s.gameId === id) || {}).title), hours: hours(sec) }));
  const longest = ys.reduce((m, s) => (!m || s.seconds > m.seconds ? s : m), null);
  const dow = [0, 0, 0, 0, 0, 0, 0];
  const parts = { morning: 0, afternoon: 0, evening: 0, night: 0 };
  for (const s of ys) {
    const d = new Date(s.start);
    dow[(d.getDay() + 6) % 7] += s.seconds;
    const h = d.getHours();
    parts[h >= 5 && h < 12 ? 'morning' : h >= 12 && h < 17 ? 'afternoon' : h >= 17 && h < 22 ? 'evening' : 'night'] += s.seconds;
  }
  const DOW = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const topDay = ys.length ? DOW[dow.indexOf(Math.max(...dow))] : null;
  const topPart = ys.length ? Object.entries(parts).sort((a, b) => b[1] - a[1])[0][0] : null;

  return {
    now,
    today: hours(todaySeconds),
    week: hours(weeks[11].seconds), lastWeek: hours(weeks[10].seconds),
    weeks: weeks.map((w) => ({ start: w.start, hours: hours(w.seconds) })),
    streak, bestStreak: best, daysPlayed: days.size,
    total: hours(total), games: visible.length, top,
    since: sessions.length ? Math.min(...sessions.map((s) => s.start)) : null,
    year: {
      year: new Date(now).getFullYear(),
      hours: hours(ys.reduce((n, s) => n + s.seconds, 0)),
      sessions: ys.length,
      days: new Set(ys.map((s) => dayStart(s.start))).size,
      games: perGame.size,
      top: yearTop,
      longest: longest ? { gameId: longest.gameId, title: titleOf(longest.gameId, longest.title), hours: hours(longest.seconds), at: longest.start } : null,
      topDay, topPart
    }
  };
}

function createStats({ userDataDir, now }) {
  now = now || Date.now;
  const file = path.join(userDataDir, 'sessions.json');
  let list = null;
  const load = () => { if (!list) { list = readJson(file); if (!Array.isArray(list)) list = []; } return list; };
  function record(gameId, title, start, seconds) {
    if (!gameId || !(seconds > 0)) return;
    const l = load();
    l.push({ gameId: String(gameId), title: String(title || '').slice(0, 120), start: Number(start) || now() - seconds * 1000, seconds: Math.round(seconds) });
    if (l.length > MAX_SESSIONS) l.splice(0, l.length - MAX_SESSIONS);
    try { writeJson(file, l); } catch (_) { /* not critical */ }
  }
  return { record, get: (games) => compute(load(), games, now()), sessions: () => load().slice() };
}

module.exports = { createStats, compute, weekStart, dayStart };
