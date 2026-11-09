'use strict';
// Cable TV (Movies & TV › Cable TV): a few channels that "air" 2010s kids' shows all day.
// Each channel is a list of shows. The schedule is worked out from the clock: the same on every
// screen and every time you look, so tuning in at 7:42 lands you mid-episode like real cable.
// Episodes come from your Stremio addons, like anything else in Movies & TV.
//
// Shows are looked up by name once (Cinemeta / your search addons) and remembered, with their
// episode lists, in cable.json; they're refreshed weekly.

const fs = require('fs');
const path = require('path');

const show = (name, year) => ({ name, year });
const DEFAULT_CHANNELS = [
  {
    id: 'nick', number: 31, name: 'Nickelodeon', color: '#ff7a1a', adWord: 'nick',
    ads: ['Nickelodeon commercial break 2011', 'Nickelodeon commercials 2012', 'Nickelodeon commercial break 2014', 'Nickelodeon commercials 2010'],
    shows: [show('SpongeBob SquarePants', 1999), show('iCarly', 2007), show('Victorious', 2010), show('Big Time Rush', 2009), show('The Fairly OddParents', 2001),
      show('Sam & Cat', 2013), show('The Thundermans', 2013), show('Henry Danger', 2014), show('The Loud House', 2016), show('Teenage Mutant Ninja Turtles', 2012),
      show('The Legend of Korra', 2012), show('The Penguins of Madagascar', 2008), show('Kung Fu Panda: Legends of Awesomeness', 2011), show('Sanjay and Craig', 2013),
      show('Game Shakers', 2015), show('Fanboy & Chum Chum', 2009), show('T.U.F.F. Puppy', 2010), show('Bella and the Bulldogs', 2015)]
  },
  {
    id: 'disney', number: 32, name: 'Disney Channel', color: '#2f7bff', adWord: 'disney channel',
    ads: ['Disney Channel commercial break 2010', 'Disney Channel commercials 2012', 'Disney Channel commercial break 2014', 'Disney Channel commercials 2011'],
    shows: [show('Wizards of Waverly Place', 2007), show('Good Luck Charlie', 2010), show('Hannah Montana', 2006), show('Phineas and Ferb', 2007), show('Shake It Up', 2010),
      show('Jessie', 2011), show('Austin & Ally', 2011), show('A.N.T. Farm', 2011), show('Sonny with a Chance', 2009), show('The Suite Life on Deck', 2008),
      show('Liv and Maddie', 2013), show('Girl Meets World', 2014), show('Dog with a Blog', 2012), show('Gravity Falls', 2012), show('Fish Hooks', 2010),
      show('Star vs. the Forces of Evil', 2015), show('K.C. Undercover', 2015), show('Bunk\'d', 2015)]
  },
  {
    id: 'xd', number: 33, name: 'Disney XD', color: '#39c463', adWord: 'xd',
    ads: ['Disney XD commercial break 2011', 'Disney XD commercials 2013', 'Disney XD commercial break 2014', 'Disney XD commercials 2012'],
    shows: [show('Kickin\' It', 2011), show('Lab Rats', 2012), show('Pair of Kings', 2010), show('Mighty Med', 2013), show('Zeke and Luther', 2009),
      show('I\'m in the Band', 2009), show('Crash & Bernstein', 2012), show('Kirby Buckets', 2014), show('Randy Cunningham: 9th Grade Ninja', 2012), show('Motorcity', 2012),
      show('Wander Over Yonder', 2013), show('Ultimate Spider-Man', 2012), show('Star Wars Rebels', 2014), show('DuckTales', 2017), show('Pickle and Peanut', 2015),
      show('Avengers Assemble', 2013)]
  },
  {
    id: 'cn', number: 34, name: 'Cartoon Network', color: '#e8e8ea', adWord: 'cartoon network',
    ads: ['Cartoon Network commercial break 2011', 'Cartoon Network commercials 2012', 'Cartoon Network commercial break 2014', 'Cartoon Network commercials 2010'],
    shows: [show('Adventure Time', 2010), show('Regular Show', 2010), show('The Amazing World of Gumball', 2011), show('Ben 10: Omniverse', 2012), show('Ben 10: Ultimate Alien', 2010),
      show('Steven Universe', 2013), show('Uncle Grandpa', 2013), show('Clarence', 2014), show('We Bare Bears', 2015), show('Teen Titans Go!', 2013),
      show('Chowder', 2007), show('The Marvelous Misadventures of Flapjack', 2008), show('Generator Rex', 2010), show('Johnny Test', 2005), show('Craig of the Creek', 2018),
      show('Sym-Bionic Titan', 2010), show('Mighty Magiswords', 2016)]
  }
];

const ERA = { from: Date.UTC(2009, 5, 1), to: Date.UTC(2019, 11, 31, 23, 59) }; // the 2010s, roughly
const DAY_START_H = 6;         // the broadcast day starts at 6 AM
const BREAK_MS = 60e3;         // a short break between shows
const DEFAULT_RUNTIME = 22;    // minutes, when the show's length isn't known
const STALE_MS = 7 * 24 * 3600e3;

// ---------------------------------------------------------------- pure parts (tested)
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function parseRuntime(s) {
  const t = String(s || '').toLowerCase();
  const h = /(\d+)\s*h/.exec(t), m = /(\d+)\s*m/.exec(t);
  let min = (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
  if (!min && /^\d+$/.test(t.trim())) min = Number(t.trim());
  return min >= 5 && min <= 90 ? min : null;
}
const norm = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');
// The episodes kept for a show: its 2010s ones when it has a few, else all of them.
function eraEpisodes(videos) {
  const all = (videos || []).filter((v) => v && v.id && Number(v.season) > 0);
  const inEra = all.filter((v) => { const t = v.released ? Date.parse(v.released) : NaN; return isFinite(t) && t >= ERA.from && t <= ERA.to; });
  return (inEra.length >= 3 ? inEra : all).map((v) => ({ id: String(v.id), season: Number(v.season), episode: Number(v.episode) || 0, title: String(v.title || '').slice(0, 100) }));
}
// Picks the search result that's the show: same name (and start year close), series first.
function pickMatch(items, name, year) {
  const want = norm(name);
  const startYear = (it) => { const m = /(\d{4})/.exec(String(it.releaseInfo || '')); return m ? Number(m[1]) : null; };
  const series = (items || []).filter((it) => it && it.id && (!it.type || it.type === 'series'));
  const same = series.filter((it) => norm(it.name) === want);
  const close = (it) => year && startYear(it) != null ? Math.abs(startYear(it) - year) : 99;
  if (same.length) return same.sort((a, b) => close(a) - close(b))[0];
  const near = series.filter((it) => norm(it.name).startsWith(want) || want.startsWith(norm(it.name)));
  return near.sort((a, b) => close(a) - close(b))[0] || null;
}
// When the broadcast day that `t` falls in started (local time, 6 AM).
function dayStart(t) {
  const d = new Date(t);
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), DAY_START_H, 0, 0, 0).getTime();
  return t >= s ? s : new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, DAY_START_H, 0, 0, 0).getTime();
}
// How long a show's time slot is. With commercials, like real TV: the show plus its breaks
// fill a quarter-hour grid (a 22-minute episode gets 30 minutes, an 11-minute one 15).
function slotMs(runtimeMin, ads) {
  const rt = runtimeMin || DEFAULT_RUNTIME;
  if (!ads) return rt * 60e3 + BREAK_MS;
  return Math.ceil((rt + 3) / 15) * 15 * 60e3;
}
// The parts of a time slot, in seconds: the episode in acts with commercial breaks between,
// and one at the end. slotSec: the slot's length; epSec: the episode's.
function breakPlan(slotSec, epSec, ads) {
  slotSec = Math.max(1, Math.round(slotSec));
  epSec = Math.max(1, Math.round(epSec));
  if (epSec >= slotSec) return [{ kind: 'show', from: 0, to: slotSec }];
  const extra = slotSec - epSec;
  if (!ads || extra < 45) return [{ kind: 'show', from: 0, to: epSec }, { kind: 'ad', len: extra, end: true }];
  let cuts = [];
  if (epSec >= 18 * 60) cuts = [0.36, 0.68];
  else if (epSec >= 8 * 60) cuts = [0.5];
  const mid = cuts.length ? Math.min(cuts.length === 2 ? 210 : 150, Math.round(extra * (cuts.length === 2 ? 0.3 : 0.4))) : 0;
  const out = [];
  let from = 0;
  for (const c of cuts) {
    const at = Math.round(epSec * c);
    out.push({ kind: 'show', from, to: at }, { kind: 'ad', len: mid });
    from = at;
  }
  out.push({ kind: 'show', from, to: epSec }, { kind: 'ad', len: extra - mid * cuts.length, end: true });
  return out;
}
// Where `offsetSec` into the slot falls: the part (i), how far into it, and the part itself.
function locate(plan, offsetSec) {
  let t = 0;
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i], len = p.kind === 'show' ? p.to - p.from : p.len;
    if (offsetSec < t + len || i === plan.length - 1) return { i, into: Math.max(0, Math.min(len, offsetSec - t)), part: p, left: Math.max(0, t + len - offsetSec) };
    t += len;
  }
  return null;
}
// Commercial-break videos worth using: about this channel, a minute to two hours long.
function adVideos(entries, word, notWord) {
  const w = String(word || '').toLowerCase(), nw = notWord ? String(notWord).toLowerCase() : null;
  const seen = new Set();
  return (entries || []).filter((e) => {
    if (!e || !e.id || seen.has(e.id)) return false;
    seen.add(e.id);
    const t = String(e.title || '').toLowerCase();
    if (!(e.duration >= 60 && e.duration <= 7200)) return false;
    if (!/commercial|ads\b|advert|break|bumper|promo/.test(t)) return false;
    if (w && !t.includes(w)) return false;
    if (nw && t.includes(nw)) return false;
    return true;
  });
}

// One channel's whole broadcast day: shows take turns (each once before any repeats), each with
// a random episode not shown earlier that day while there are others.
// shows: [{ id, runtimeMin, episodes: [...] }]
function daySchedule(channelId, shows, start, ads) {
  const usable = (shows || []).filter((s) => s && s.id && s.episodes && s.episodes.length);
  if (!usable.length) return [];
  const day = new Date(start);
  const key = channelId + '|' + day.getFullYear() + '-' + (day.getMonth() + 1) + '-' + day.getDate() + '|' + usable.map((s) => s.id).join(',') + (ads ? '|ads' : '');
  const r = rng(hash32(key));
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const used = new Map();
  const end = start + 24 * 3600e3;
  const out = [];
  let bag = [], last = null, t = start;
  while (t < end) {
    if (!bag.length) { bag = shuffle(usable.slice()); if (bag.length > 1 && bag[0] === last) bag.push(bag.shift()); }
    const s = bag.shift();
    last = s;
    let seen = used.get(s.id);
    if (!seen) { seen = new Set(); used.set(s.id, seen); }
    if (seen.size >= s.episodes.length) seen.clear();
    let ep;
    for (let tries = 0; tries < 12; tries++) { ep = s.episodes[Math.floor(r() * s.episodes.length)]; if (!seen.has(ep.id)) break; }
    seen.add(ep.id);
    const len = slotMs(s.runtimeMin, ads);
    out.push({ start: t, end: Math.min(end, t + len), showId: s.id, video: ep });
    t += len;
  }
  return out;
}

// ---------------------------------------------------------------- with the addons
// tv: the Stremio client (search, meta). file: where it's remembered.
function createCable({ tv, file, now, ytdlp, ads }) {
  const adsOn = () => (typeof ads === 'function' ? !!ads() : !!ads);
  now = now || Date.now;
  let state = null;
  const days = new Map(); // channel|dayStart -> schedule
  let resolving = null;

  function load() {
    if (state) return state;
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { state = null; }
    if (!state || typeof state !== 'object') state = {};
    if (!Array.isArray(state.channels)) state.channels = JSON.parse(JSON.stringify(DEFAULT_CHANNELS));
    if (!state.shows || typeof state.shows !== 'object') state.shows = {};
    if (!state.names || typeof state.names !== 'object') state.names = {};
    if (!state.durs || typeof state.durs !== 'object') state.durs = {};
    if (!state.ads || typeof state.ads !== 'object') state.ads = {};
    // Channels from before commercials: give them their searches.
    for (const c of state.channels) { const d = DEFAULT_CHANNELS.find((x) => x.id === c.id); if (d && !c.ads) { c.ads = d.ads.slice(); c.adWord = d.adWord; } }
    return state;
  }
  let saveT = null;
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(state)); fs.renameSync(file + '.tmp', file); } catch (_) { /* next time */ }
    }, 300);
  }
  const nameKey = (s) => norm(s.name) + '|' + (s.year || '');
  const idOf = (s) => s.id || state.names[nameKey(s)] || null;
  const resolved = (s) => { const id = idOf(s); return id && state.shows[id] ? state.shows[id] : null; };

  async function loadShow(id) {
    const m = await tv.meta('series', id);
    const episodes = eraEpisodes(m.videos);
    const entry = { id, name: m.name || '', poster: m.poster || null, background: m.background || null, runtimeMin: parseRuntime(m.runtime), episodes, at: now() };
    state.shows[id] = entry;
    return entry;
  }
  async function resolveOne(s) {
    let id = idOf(s);
    if (!id) {
      if (state.names[nameKey(s)] === false && state.missAt && now() - state.missAt < 24 * 3600e3) return null;
      const rows = await tv.search(s.name);
      const items = [].concat(...rows.filter((r) => r.type === 'series').map((r) => r.items));
      const hit = pickMatch(items, s.name, s.year);
      if (!hit) { state.names[nameKey(s)] = false; state.missAt = now(); return null; }
      id = hit.id;
      state.names[nameKey(s)] = id;
    }
    const have = state.shows[id];
    if (have && now() - (have.at || 0) < STALE_MS && have.episodes.length) return have;
    try { return await loadShow(id); } catch (e) { return have || null; }
  }
  // Looks up every show that isn't known yet (a few at a time). progress(done, total).
  function ensure(progress) {
    load();
    if (resolving) return resolving;
    const all = [];
    for (const c of state.channels) for (const s of c.shows) all.push(s);
    const todo = all.filter((s) => { const r = resolved(s); return !r || now() - (r.at || 0) > STALE_MS; });
    if (!todo.length) return Promise.resolve({ done: all.length, total: all.length });
    let done = all.length - todo.length;
    const queue = todo.slice();
    const worker = async () => {
      while (queue.length) {
        const s = queue.shift();
        try { await resolveOne(s); } catch (_) { /* skipped today */ }
        done++;
        if (progress) { try { progress(done, all.length); } catch (_) { /* ignore */ } }
      }
    };
    resolving = Promise.all([worker(), worker(), worker(), worker()]).then(() => {
      days.clear();
      save();
      return { done, total: all.length };
    }).finally(() => { resolving = null; });
    return resolving;
  }
  const ready = () => { load(); return state.channels.every((c) => c.shows.every((s) => resolved(s) || state.names[nameKey(s)] === false)); };

  function showsOf(c) { return c.shows.map(resolved).filter(Boolean); }
  function schedule(c, start) {
    const k = c.id + '|' + start + '|' + adsOn();
    let d = days.get(k);
    if (!d) {
      d = daySchedule(c.id, showsOf(c), start, adsOn());
      days.set(k, d);
      if (days.size > 40) days.delete(days.keys().next().value);
    }
    return d;
  }
  const decorate = (p) => {
    const s = state.shows[p.showId] || {};
    return { start: p.start, end: p.end, showId: p.showId, show: s.name || '', poster: s.poster || null, background: s.background || null, video: p.video, runtimeMin: s.runtimeMin || DEFAULT_RUNTIME };
  };
  // Programs on a channel between two times.
  function programs(c, from, to) {
    const out = [];
    for (let d = dayStart(from); d < to; d += 24 * 3600e3) {
      const ds = dayStart(d + 3600e3); // (daylight saving: find the real 6 AM)
      for (const p of schedule(c, ds)) if (p.end > from && p.start < to) out.push(decorate(p));
    }
    return out;
  }
  function channel(id) { load(); return state.channels.find((c) => c.id === id) || null; }
  const brief = (c) => ({ id: c.id, number: c.number, name: c.name, color: c.color, shows: c.shows.length, found: showsOf(c).length });
  // The guide: every channel's programs between two times.
  function guide(from, to) {
    load();
    return state.channels.map((c) => Object.assign(brief(c), { programs: programs(c, from, to) }));
  }
  // What's on a channel at `t`, and what's next.
  function at(id, t) {
    const c = channel(id);
    if (!c) return null;
    t = t == null ? now() : t;
    const list = programs(c, t, t + 4 * 3600e3);
    const cur = list.find((p) => p.start <= t && p.end > t) || null;
    const next = list.filter((p) => p.start >= (cur ? cur.end : t)).slice(0, 2);
    return { channel: brief(c), now: cur, next };
  }
  // Channel numbers in order, for up / down.
  function neighbor(id, dir) {
    load();
    const list = state.channels.slice().sort((a, b) => a.number - b.number);
    const i = list.findIndex((c) => c.id === id);
    if (i < 0) return list[0] ? list[0].id : null;
    return list[(i + dir + list.length) % list.length].id;
  }

  // ---- a program's parts (acts and commercial breaks)
  // The episode's real length once the player has seen it (kept), else the show's usual length.
  function plan(prog) {
    load();
    const ep = state.durs[prog.video.id] || prog.runtimeMin * 60;
    return breakPlan((prog.end - prog.start) / 1000, ep, adsOn());
  }
  function learnDuration(videoId, sec) {
    load();
    sec = Math.round(Number(sec) || 0);
    if (sec < 60 || sec > 4 * 3600) return false;
    const had = state.durs[videoId];
    if (had && Math.abs(had - sec) < 5) return false;
    state.durs[videoId] = sec;
    const keys = Object.keys(state.durs);
    if (keys.length > 3000) for (const k of keys.slice(0, keys.length - 3000)) delete state.durs[k];
    save();
    return true;
  }
  // The channel's commercial-break recordings on YouTube (looked up weekly).
  const adLoads = new Map();
  function adsFor(channelId) {
    load();
    const c = channel(channelId);
    if (!c || !ytdlp || !Array.isArray(c.ads) || !c.ads.length) return Promise.resolve([]);
    const have = state.ads[channelId];
    if (have && now() - (have.at || 0) < STALE_MS && have.list.length) return Promise.resolve(have.list);
    if (adLoads.has(channelId)) return adLoads.get(channelId);
    const p = (async () => {
      const found = [];
      for (const q of c.ads) { try { found.push(...await ytdlp.search(q, 20)); } catch (_) { /* next search */ } }
      const list = adVideos(found, c.adWord || '', c.id === 'disney' ? 'xd' : null).slice(0, 80);
      if (list.length || !have) { state.ads[channelId] = { at: now(), list }; save(); }
      return list.length ? list : (have ? have.list : []);
    })().finally(() => adLoads.delete(channelId));
    adLoads.set(channelId, p);
    return p;
  }

  // ---- editing the line-up
  function lineup() {
    load();
    return state.channels.map((c) => Object.assign(brief(c), {
      list: c.shows.map((s) => { const r = resolved(s); return { name: r ? r.name : s.name, id: idOf(s), poster: r ? r.poster : null, found: !!r, missing: state.names[nameKey(s)] === false }; })
    }));
  }
  async function addShow(channelId, meta) {
    const c = channel(channelId);
    if (!c) throw new Error('No such channel');
    const id = String(meta && meta.id || '');
    if (!/^tt\d+$/.test(id)) throw new Error('That show can’t be added (it needs an IMDb id)');
    if (c.shows.some((s) => idOf(s) === id)) throw new Error('It’s already on ' + c.name);
    const entry = await loadShow(id);
    if (!entry.episodes.length) throw new Error('No episodes found for that show');
    c.shows.push({ name: entry.name || String(meta.name || ''), id });
    days.clear(); save();
    return lineup();
  }
  function removeShow(channelId, index) {
    const c = channel(channelId);
    if (!c || !c.shows[index]) throw new Error('Not found');
    c.shows.splice(index, 1);
    days.clear(); save();
    return lineup();
  }
  function resetChannel(channelId) {
    const c = channel(channelId), d = DEFAULT_CHANNELS.find((x) => x.id === channelId);
    if (!c || !d) throw new Error('Not found');
    c.shows = JSON.parse(JSON.stringify(d.shows));
    days.clear(); save();
    return lineup();
  }
  function flush() { if (saveT) { clearTimeout(saveT); saveT = null; try { fs.writeFileSync(file, JSON.stringify(state)); } catch (_) { /* fine */ } } }

  return { ensure, ready, guide, at, neighbor, channel, lineup, addShow, removeShow, resetChannel, flush, plan, learnDuration, adsFor, get resolving() { return !!resolving; } };
}

module.exports = { createCable, daySchedule, dayStart, parseRuntime, eraEpisodes, pickMatch, hash32, slotMs, breakPlan, locate, adVideos, DEFAULT_CHANNELS };
