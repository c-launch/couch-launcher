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
  },
  {
    id: 'pbs', number: 35, name: 'PBS Kids', color: '#ffb703', adWord: 'pbs',
    ads: ['PBS Kids interstitials 2012', 'PBS Kids promos 2011', 'PBS Kids Go bumpers 2010', 'PBS Kids interstitials 2014'],
    shows: [show('Arthur', 1996), show('Curious George', 2006), show('Wild Kratts', 2011), show('Dinosaur Train', 2009), show('Super Why!', 2007),
      show('Peg + Cat', 2013), show('Daniel Tiger\'s Neighborhood', 2012), show('Odd Squad', 2014), show('WordGirl', 2007), show('Martha Speaks', 2008),
      show('The Cat in the Hat Knows a Lot About That!', 2010), show('Sid the Science Kid', 2008), show('Caillou', 1997), show('Nature Cat', 2015),
      show('Ready Jet Go!', 2016), show('Cyberchase', 2002), show('The Electric Company', 2009), show('Fetch! with Ruff Ruffman', 2006), show('Splash and Bubbles', 2016)]
  }
];

// Commercial-break searches for a channel: "<name> commercial break <year>" over a few years.
const adQ = (name, years, words) => years.map((y, i) => name + ' ' + (words || ['commercial break', 'commercials'])[i % (words || [1, 2]).length] + ' ' + y);
const ERA_2000S = [
  {
    id: 'nick', number: 31, name: 'Nickelodeon', color: '#ff7a1a', adWord: 'nick', ads: adQ('Nickelodeon', [2003, 2005, 2007, 2008]),
    shows: [show('SpongeBob SquarePants', 1999), show('The Fairly OddParents', 2001), show('The Adventures of Jimmy Neutron: Boy Genius', 2002), show('Danny Phantom', 2004),
      show('Avatar: The Last Airbender', 2005), show('Drake & Josh', 2004), show('Zoey 101', 2005), show('Ned\'s Declassified School Survival Guide', 2004), show('Rugrats', 1991),
      show('All Grown Up!', 2003), show('Hey Arnold!', 1996), show('The Wild Thornberrys', 1998), show('Invader Zim', 2001), show('ChalkZone', 2002),
      show('My Life as a Teenage Robot', 2003), show('iCarly', 2007), show('Unfabulous', 2004), show('El Tigre: The Adventures of Manny Rivera', 2007), show('Back at the Barnyard', 2007), show('True Jackson, VP', 2008)]
  },
  {
    id: 'disney', number: 32, name: 'Disney Channel', color: '#2f7bff', adWord: 'disney channel', ads: adQ('Disney Channel', [2003, 2005, 2007, 2008]),
    shows: [show('Lizzie McGuire', 2001), show('That\'s So Raven', 2003), show('The Suite Life of Zack & Cody', 2005), show('Hannah Montana', 2006), show('Kim Possible', 2002),
      show('Phil of the Future', 2004), show('Even Stevens', 2000), show('Cory in the House', 2007), show('Wizards of Waverly Place', 2007), show('The Proud Family', 2001),
      show('American Dragon: Jake Long', 2005), show('Phineas and Ferb', 2007), show('The Replacements', 2006), show('Brandy & Mr. Whiskers', 2004), show('Dave the Barbarian', 2004),
      show('Lilo & Stitch: The Series', 2003), show('Sonny with a Chance', 2009), show('JONAS', 2009)]
  },
  {
    id: 'toon', number: 33, name: 'Toon Disney', color: '#8b5cf6', adWord: ['toon disney', 'jetix'], ads: ['Toon Disney commercial break 2004', 'Jetix commercials 2006', 'Toon Disney commercials 2007', 'Jetix commercial break 2008'],
    shows: [show('Totally Spies!', 2001), show('W.I.T.C.H.', 2004), show('Super Robot Monkey Team Hyperforce Go!', 2004), show('Pucca', 2006), show('Yin Yang Yo!', 2006),
      show('Get Ed', 2005), show('Oban Star-Racers', 2006), show('Galactik Football', 2006), show('A.T.O.M.', 2005), show('Power Rangers Mystic Force', 2006),
      show('Power Rangers Jungle Fury', 2008), show('Recess', 1997), show('The Emperor\'s New School', 2006), show('Kid vs. Kat', 2008), show('Spider-Man', 1994)]
  },
  {
    id: 'cn', number: 34, name: 'Cartoon Network', color: '#e8e8ea', adWord: 'cartoon network', ads: adQ('Cartoon Network', [2002, 2004, 2006, 2008]),
    shows: [show('Ed, Edd n Eddy', 1999), show('Dexter\'s Laboratory', 1996), show('The Powerpuff Girls', 1998), show('Courage the Cowardly Dog', 1999), show('Codename: Kids Next Door', 2002),
      show('The Grim Adventures of Billy & Mandy', 2001), show('Foster\'s Home for Imaginary Friends', 2004), show('Samurai Jack', 2001), show('Teen Titans', 2003), show('Ben 10', 2005),
      show('Camp Lazlo', 2005), show('My Gym Partner\'s a Monkey', 2005), show('Chowder', 2007), show('Ben 10: Alien Force', 2008), show('Johnny Bravo', 1997),
      show('Megas XLR', 2004), show('Hi Hi Puffy AmiYumi', 2004), show('The Marvelous Misadventures of Flapjack', 2008)]
  },
  {
    id: 'pbs', number: 35, name: 'PBS Kids', color: '#ffb703', adWord: 'pbs', ads: ['PBS Kids interstitials 2004', 'PBS Kids promos 2006', 'PBS Kids Go bumpers 2007', 'PBS Kids interstitials 2008'],
    shows: [show('Arthur', 1996), show('Clifford the Big Red Dog', 2000), show('Cyberchase', 2002), show('Dragon Tales', 1999), show('Zoboomafoo', 1999),
      show('Liberty\'s Kids', 2002), show('Maya & Miguel', 2004), show('Postcards from Buster', 2004), show('Curious George', 2006), show('Super Why!', 2007),
      show('WordGirl', 2007), show('Martha Speaks', 2008), show('Sid the Science Kid', 2008), show('Fetch! with Ruff Ruffman', 2006), show('Between the Lions', 2000),
      show('Caillou', 1997), show('Dinosaur Train', 2009), show('Clifford\'s Puppy Days', 2003), show('Jakers! The Adventures of Piggley Winks', 2003)]
  }
];
const ERA_2020S = [
  {
    id: 'nick', number: 31, name: 'Nickelodeon', color: '#ff7a1a', adWord: 'nick', ads: adQ('Nickelodeon', [2020, 2021, 2022, 2023]),
    shows: [show('SpongeBob SquarePants', 1999), show('The Loud House', 2016), show('The Casagrandes', 2019), show('Danger Force', 2020), show('Side Hustle', 2020),
      show('That Girl Lay Lay', 2021), show('The Really Loud House', 2022), show('Kamp Koral: SpongeBob\'s Under Years', 2021), show('The Patrick Star Show', 2021),
      show('Rise of the Teenage Mutant Ninja Turtles', 2018), show('It\'s Pony', 2020), show('Big Nate', 2022), show('Rugrats', 2021), show('Middlemost Post', 2021),
      show('Tyler Perry\'s Young Dylan', 2020), show('Erin & Aaron', 2023), show('The Thundermans: Undercover', 2024)]
  },
  {
    id: 'disney', number: 32, name: 'Disney Channel', color: '#2f7bff', adWord: 'disney channel', ads: adQ('Disney Channel', [2020, 2021, 2022, 2023]),
    shows: [show('Bunk\'d', 2015), show('Raven\'s Home', 2017), show('Big City Greens', 2018), show('Amphibia', 2019), show('The Owl House', 2020),
      show('The Ghost and Molly McGee', 2021), show('Hamster & Gretel', 2022), show('Kiff', 2023), show('Saturdays', 2023), show('Secrets of Sulphur Springs', 2021),
      show('Sydney to the Max', 2019), show('Gabby Duran & the Unsittables', 2019), show('Marvel\'s Moon Girl and Devil Dinosaur', 2023), show('Wizards Beyond Waverly Place', 2024),
      show('Primos', 2024), show('Hailey\'s On It!', 2023)]
  },
  {
    id: 'xd', number: 33, name: 'Disney XD', color: '#39c463', adWord: 'xd', ads: adQ('Disney XD', [2020, 2021, 2022, 2023]),
    shows: [show('DuckTales', 2017), show('Star Wars Resistance', 2018), show('Marvel\'s Spider-Man', 2017), show('Big Hero 6: The Series', 2017), show('Monsters at Work', 2021),
      show('Hamster & Gretel', 2022), show('Kiff', 2023), show('Hailey\'s On It!', 2023), show('Marvel\'s Moon Girl and Devil Dinosaur', 2023), show('Amphibia', 2019),
      show('The Owl House', 2020), show('Beyblade Burst', 2016), show('Big City Greens', 2018), show('Star Wars: The Bad Batch', 2021)]
  },
  {
    id: 'cn', number: 34, name: 'Cartoon Network', color: '#e8e8ea', adWord: 'cartoon network', ads: adQ('Cartoon Network', [2020, 2021, 2022, 2023]),
    shows: [show('Teen Titans Go!', 2013), show('The Amazing World of Gumball', 2011), show('Craig of the Creek', 2018), show('We Baby Bears', 2022), show('We Bare Bears', 2015),
      show('Victor and Valentino', 2019), show('Apple & Onion', 2018), show('Summer Camp Island', 2018), show('Total DramaRama', 2018), show('Mao Mao: Heroes of Pure Heart', 2019),
      show('Ben 10', 2016), show('ThunderCats Roar', 2020), show('Steven Universe Future', 2019), show('Infinity Train', 2019), show('Unikitty!', 2017), show('Tiny Toons Looniversity', 2023)]
  },
  {
    id: 'pbs', number: 35, name: 'PBS Kids', color: '#ffb703', adWord: 'pbs', ads: ['PBS Kids interstitials 2020', 'PBS Kids promos 2021', 'PBS Kids bumpers 2022', 'PBS Kids interstitials 2023'],
    shows: [show('Daniel Tiger\'s Neighborhood', 2012), show('Wild Kratts', 2011), show('Odd Squad', 2014), show('Nature Cat', 2015), show('Molly of Denali', 2019),
      show('Alma\'s Way', 2021), show('Work It Out Wombats!', 2023), show('Donkey Hodie', 2021), show('Elinor Wonders Why', 2020), show('Rosie\'s Rules', 2022),
      show('Lyla in the Loop', 2024), show('Hero Elementary', 2020), show('Xavier Riddle and the Secret Museum', 2019), show('Arthur', 1996), show('Pinkalicious & Peterrific', 2018),
      show('Let\'s Go Luna!', 2018), show('Dinosaur Train', 2009), show('Ready Jet Go!', 2016)]
  }
];
// The eras: each with its channels, and the years its episodes come from.
const ERAS = {
  '2000s': { name: '2000s', from: Date.UTC(2000, 0, 1), to: Date.UTC(2009, 11, 31, 23, 59), channels: ERA_2000S },
  '2010s': { name: '2010s', from: Date.UTC(2009, 5, 1), to: Date.UTC(2019, 11, 31, 23, 59), channels: DEFAULT_CHANNELS },
  '2020s': { name: '2020s', from: Date.UTC(2020, 0, 1), to: Date.UTC(2099, 0, 1), channels: ERA_2020S }
};
const ERA = ERAS['2010s'];
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
// A show's episodes, kept small (with when each first aired).
function compactEpisodes(videos) {
  return (videos || []).filter((v) => v && v.id && Number(v.season) > 0).map((v) => {
    const r = v.released ? Date.parse(v.released) : NaN;
    return { id: String(v.id), season: Number(v.season), episode: Number(v.episode) || 0, title: String(v.title || '').slice(0, 100), r: isFinite(r) ? r : null };
  });
}
// The episodes an era airs: the ones from its years when there are a few, else all of them.
// (era: an era's id, or several for merged eras: episodes from any of their years.)
function inEra(episodes, era) {
  const list = (Array.isArray(era) ? era : [era]).map((x) => (typeof x === 'string' ? ERAS[x] : x || ERA)).filter(Boolean);
  const all = episodes || [];
  const hit = all.filter((v) => v.r != null && list.some((e) => v.r >= e.from && v.r <= e.to));
  return hit.length >= 3 ? hit : all;
}
const ERA_ORDER = ['2000s', '2010s', '2020s'];
function eraEpisodes(videos, era) {
  return inEra(compactEpisodes(videos), era).map((v) => ({ id: v.id, season: v.season, episode: v.episode, title: v.title }));
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
  const ws = (Array.isArray(word) ? word : [word]).map((x) => String(x || '').toLowerCase()).filter(Boolean);
  const nw = notWord ? String(notWord).toLowerCase() : null;
  const seen = new Set();
  return (entries || []).filter((e) => {
    if (!e || !e.id || seen.has(e.id)) return false;
    seen.add(e.id);
    const t = String(e.title || '').toLowerCase();
    if (!(e.duration >= 60 && e.duration <= 7200)) return false;
    if (!/commercial|ads\b|advert|break|bumper|promo|interstitial|funding/.test(t)) return false;
    if (ws.length && !ws.some((w) => t.includes(w))) return false;
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
    if (!state.shows || typeof state.shows !== 'object') state.shows = {};
    if (!state.names || typeof state.names !== 'object') state.names = {};
    if (!state.durs || typeof state.durs !== 'object') state.durs = {};
    if (!state.ads || typeof state.ads !== 'object') state.ads = {};
    if (!state.eras || typeof state.eras !== 'object') state.eras = {};
    if (state.v !== 2) {
      // From before eras: that line-up is the 2010s one. Shows are looked up again (for the
      // dates their episodes aired), old commercial lists are dropped.
      if (Array.isArray(state.channels)) { state.eras['2010s'] = { channels: state.channels, setup: true }; state.mix = ['2010s']; }
      delete state.channels;
      for (const k of Object.keys(state.shows)) state.shows[k].at = 0;
      state.ads = {};
      state.v = 2;
    }
    if (state.era && !state.mix) state.mix = [state.era];
    delete state.era;
    state.mix = (Array.isArray(state.mix) ? state.mix : []).filter((id) => ERAS[id] && state.eras[id]);
    state.mix = ERA_ORDER.filter((id) => state.mix.includes(id));
    for (const [id, e] of Object.entries(state.eras)) {
      if (!ERAS[id] || !e || !Array.isArray(e.channels)) { delete state.eras[id]; continue; }
      const defs = ERAS[id].channels;
      // Channels added since (like PBS Kids): put them in. Searches for commercials, too.
      for (const d of defs) if (!e.channels.some((c) => c.id === d.id)) e.channels.push(JSON.parse(JSON.stringify(d)));
      for (const c of e.channels) { const d = defs.find((x) => x.id === c.id); if (d && !c.ads) { c.ads = d.ads.slice(); c.adWord = d.adWord; } }
    }
    return state;
  }
  let saveT = null;
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(state)); fs.renameSync(file + '.tmp', file); } catch (_) { /* next time */ }
    }, 300);
  }
  // The eras being watched (one, or several merged), and their channels. Merged: a channel in
  // more than one era (Nickelodeon) has all their shows; one only in some (Toon Disney, Disney
  // XD) is its own channel (numbered after the others if its number is taken).
  const mix = () => { load(); return state.mix; };
  const mixKey = () => mix().join('+');
  const eraId = () => (mix().length ? mix().join(' + ') : null);
  let merged = null, mergedKey = null;
  function chans() {
    load();
    const ids = state.mix;
    if (!ids.length) return [];
    if (ids.length === 1) return state.eras[ids[0]].channels;
    const key = ids.join('+') + '|' + ids.map((id) => JSON.stringify(state.eras[id].channels.map((c) => [c.id, c.shows.length, c.shows.map((x) => x.id || x.name).join()]))).join('|');
    if (merged && mergedKey === key) return merged;
    const out = [];
    const taken = new Set();
    for (const id of ids) {
      for (const c of state.eras[id].channels) {
        let m = out.find((x) => x.id === c.id);
        if (!m) {
          let number = c.number;
          while (taken.has(number)) number++;
          taken.add(number);
          m = { id: c.id, number, name: c.name, color: c.color, adWord: [], ads: [], shows: [], from: [] };
          out.push(m);
        }
        m.from.push(id);
        for (const w of [].concat(c.adWord || [])) if (!m.adWord.includes(w)) m.adWord.push(w);
        for (const q of c.ads || []) if (!m.ads.includes(q)) m.ads.push(q);
        for (const sh of c.shows) {
          const sid = idOf(sh);
          if (!m.shows.some((x) => (sid && idOf(x) === sid) || nameKey(x) === nameKey(sh))) m.shows.push(sh);
        }
      }
    }
    // The 2000s-only channel keeps its number; ones that clash move to the first free numbers.
    for (const m of out) { if (out.filter((x) => x.number === m.number).length > 1) { let n = m.number; while (out.some((x) => x.number === n)) n++; m.number = n; } }
    out.sort((a, b) => a.number - b.number);
    merged = out; mergedKey = key;
    return out;
  }
  const eraChans = (id) => { load(); return state.eras[id] ? state.eras[id].channels : []; };
  const nameKey = (s) => norm(s.name) + '|' + (s.year || '');
  const idOf = (s) => s.id || state.names[nameKey(s)] || null;
  const resolved = (s) => { const id = idOf(s); return id && state.shows[id] ? state.shows[id] : null; };

  async function loadShow(id) {
    const m = await tv.meta('series', id);
    const episodes = compactEpisodes(m.videos);
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
  // (Only the era being watched: each era is set up the first time it's picked.)
  function ensure(progress) {
    load();
    if (resolving) return resolving;
    if (!state.mix.length) return Promise.resolve({ done: 0, total: 0 });
    const eraList = state.mix.map((id) => state.eras[id]);
    const all = [];
    const seen = new Set();
    for (const era of eraList) for (const c of era.channels) for (const s of c.shows) { const k = idOf(s) || nameKey(s); if (!seen.has(k)) { seen.add(k); all.push(s); } }
    const todo = all.filter((s) => { const r = resolved(s); return !r || now() - (r.at || 0) > STALE_MS; });
    if (!todo.length) { if (eraList.some((e) => !e.setup)) { for (const e of eraList) e.setup = true; save(); } return Promise.resolve({ done: all.length, total: all.length }); }
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
      days.clear(); merged = null;
      for (const e of eraList) e.setup = true;
      save();
      return { done, total: all.length };
    }).finally(() => { resolving = null; });
    return resolving;
  }
  const eraReady = (id) => { load(); const e = state.eras[id]; return !!e && e.setup === true && e.channels.every((c) => c.shows.every((s) => resolved(s) || state.names[nameKey(s)] === false)); };
  const ready = () => mix().length > 0 && state.mix.every(eraReady);
  // Some shows want looking up again (a week old): done quietly while you watch.
  const stale = () => chans().some((c) => c.shows.some((s) => { const r = resolved(s); return r && now() - (r.at || 0) > STALE_MS; }));

  function showsOf(c) { return c.shows.map(resolved).filter(Boolean); }
  function schedule(c, start) {
    const k = mixKey() + '|' + c.id + '|' + start + '|' + adsOn();
    let d = days.get(k);
    if (!d) {
      const eraList = c.from || state.mix;
      d = daySchedule(mixKey() + ':' + c.id, showsOf(c).map((x) => ({ id: x.id, runtimeMin: x.runtimeMin, episodes: inEra(x.episodes, eraList) })), start, adsOn());
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
  function channel(id) { return chans().find((c) => c.id === id) || null; }
  const brief = (c) => ({ id: c.id, number: c.number, name: c.name, color: c.color, shows: c.shows.length, found: showsOf(c).length });
  // The guide: every channel's programs between two times.
  function guide(from, to) {
    return chans().map((c) => Object.assign(brief(c), { programs: programs(c, from, to) }));
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
    const list = chans().slice().sort((a, b) => a.number - b.number);
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
    const key = mixKey() + '|' + channelId;
    const have = state.ads[key];
    if (have && now() - (have.at || 0) < STALE_MS && have.list.length) return Promise.resolve(have.list);
    if (adLoads.has(key)) return adLoads.get(key);
    const p = (async () => {
      const found = [];
      for (const q of c.ads) { try { found.push(...await ytdlp.search(q, 20)); } catch (_) { /* next search */ } }
      const list = adVideos(found, c.adWord || '', c.id === 'disney' ? 'xd' : null).slice(0, 80);
      if (list.length || !have) { state.ads[key] = { at: now(), list }; save(); }
      return list.length ? list : (have ? have.list : []);
    })().finally(() => adLoads.delete(key));
    adLoads.set(key, p);
    return p;
  }

  // ---- editing the line-up
  // (era: which era's line-up; merged eras are edited one era at a time.)
  const editEra = (era) => { load(); const id = era && state.eras[era] ? era : state.mix[0]; if (!id) throw new Error('Pick an era first'); return id; };
  const eraChannel = (era, channelId) => eraChans(editEra(era)).find((c) => c.id === channelId) || null;
  function lineup(era) {
    const id = editEra(era);
    return eraChans(id).map((c) => Object.assign(brief(c), {
      era: id,
      list: c.shows.map((s) => { const r = resolved(s); return { name: r ? r.name : s.name, id: idOf(s), poster: r ? r.poster : null, found: !!r, missing: state.names[nameKey(s)] === false }; })
    }));
  }
  async function addShow(channelId, meta, era) {
    const c = eraChannel(era, channelId);
    if (!c) throw new Error('No such channel');
    const id = String(meta && meta.id || '');
    if (!/^tt\d+$/.test(id)) throw new Error('That show can’t be added (it needs an IMDb id)');
    if (c.shows.some((s) => idOf(s) === id)) throw new Error('It’s already on ' + c.name);
    const entry = state.shows[id] && now() - (state.shows[id].at || 0) < STALE_MS ? state.shows[id] : await loadShow(id);
    if (!entry.episodes.length) throw new Error('No episodes found for that show');
    c.shows.push({ name: entry.name || String(meta.name || ''), id });
    days.clear(); merged = null; save();
    return lineup(era);
  }
  function removeShow(channelId, index, era) {
    const c = eraChannel(era, channelId);
    if (!c || !c.shows[index]) throw new Error('Not found');
    c.shows.splice(index, 1);
    days.clear(); merged = null; save();
    return lineup(era);
  }
  function resetChannel(channelId, era) {
    const id = editEra(era);
    const c = eraChannel(id, channelId), d = ERAS[id].channels.find((x) => x.id === channelId);
    if (!c || !d) throw new Error('Not found');
    c.shows = JSON.parse(JSON.stringify(d.shows));
    days.clear(); merged = null; save();
    return lineup(id);
  }
  // ---- eras
  // Every era: whether it's set up yet (its shows looked up), and a taste of what's on.
  function eras() {
    load();
    return Object.entries(ERAS).map(([id, e]) => ({
      id, name: e.name, current: state.mix.includes(id), setup: eraReady(id),
      channels: (state.eras[id] ? state.eras[id].channels : e.channels).map((c) => c.name),
      sample: e.channels.map((c) => c.shows[0] && c.shows[0].name).concat(e.channels.map((c) => c.shows[1] && c.shows[1].name)).filter(Boolean).slice(0, 8),
      shows: (state.eras[id] ? state.eras[id].channels : e.channels).reduce((n, c) => n + c.shows.length, 0)
    }));
  }
  // Which eras to watch: one, or several merged.
  function setEras(ids) {
    load();
    const list = ERA_ORDER.filter((id) => (Array.isArray(ids) ? ids : [ids]).includes(id));
    if (!list.length) throw new Error('Pick at least one era');
    for (const id of list) if (!state.eras[id]) state.eras[id] = { channels: JSON.parse(JSON.stringify(ERAS[id].channels)), setup: false };
    state.mix = list;
    days.clear(); merged = null; save();
    return eras();
  }
  const setEra = (id) => setEras([id]);
  function flush() { if (saveT) { clearTimeout(saveT); saveT = null; try { fs.writeFileSync(file, JSON.stringify(state)); } catch (_) { /* fine */ } } }

  return { ensure, ready, stale, guide, at, neighbor, channel, lineup, addShow, removeShow, resetChannel, flush, plan, learnDuration, adsFor, eras, setEra, setEras, era: eraId, mix: () => mix().slice(), get resolving() { return !!resolving; } };
}

module.exports = { createCable, daySchedule, dayStart, parseRuntime, eraEpisodes, compactEpisodes, inEra, pickMatch, hash32, slotMs, breakPlan, locate, adVideos, DEFAULT_CHANNELS, ERAS };
