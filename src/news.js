'use strict';
// Gaming news for Home: headlines from several gaming sites' public news feeds (RSS / Atom),
// merged, newest first, refreshed every couple of hours and kept on disk between starts.

const fs = require('fs');
const path = require('path');

const FEEDS = [
  { name: 'GameSpot', url: 'https://www.gamespot.com/feeds/news/' },
  { name: 'PC Gamer', url: 'https://www.pcgamer.com/rss/' },
  { name: 'IGN', url: 'https://feeds.ign.com/ign/games-all' },
  { name: 'Polygon', url: 'https://www.polygon.com/rss/index.xml' },
  { name: 'Eurogamer', url: 'https://www.eurogamer.net/feed' },
  { name: 'VGC', url: 'https://www.videogameschronicle.com/feed/' },
  { name: 'Nintendo Life', url: 'https://www.nintendolife.com/feeds/latest' },
  { name: 'Push Square', url: 'https://www.pushsquare.com/feeds/latest' },
  { name: 'Pure Xbox', url: 'https://www.purexbox.com/feeds/latest' }
];
const EVERY = 2 * 60 * 60 * 1000;

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', trade: '™', reg: '®', copy: '©' };
function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => (ENT[n.toLowerCase()] !== undefined ? ENT[n.toLowerCase()] : m));
}
const strip = (html) => decode(html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const tag = (xml, name) => { const m = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i').exec(xml); return m ? m[1] : ''; };
const attr = (xml, name, a) => { const m = new RegExp('<' + name + '\\b[^>]*\\b' + a + '="([^"]+)"', 'i').exec(xml); return m ? decode(m[1]) : ''; };
const httpUrl = (u) => (/^https?:\/\/[^\s"<>]+$/i.test(String(u || '').trim()) ? String(u).trim() : '');

// One feed's text -> items
function parseFeed(xml, source) {
  const out = [];
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    const title = strip(tag(b, 'title'));
    let link = strip(tag(b, 'link')) || attr(b, 'link', 'href');
    link = httpUrl(link) || httpUrl(strip(tag(b, 'guid')));
    if (!title || !link) continue;
    const when = Date.parse(strip(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date')));
    const body = tag(b, 'content:encoded') || tag(b, 'description') || tag(b, 'summary') || tag(b, 'content');
    let image = attr(b, 'media:content', 'url') || attr(b, 'media:thumbnail', 'url');
    if (!image) { const e = /<enclosure\b[^>]*type="image[^"]*"[^>]*>/i.exec(b) || /<enclosure\b[^>]*url="[^"]+\.(?:jpe?g|png|webp)[^"]*"[^>]*>/i.exec(b); if (e) image = attr(e[0], 'enclosure', 'url'); }
    if (!image) { const m = /<img\b[^>]*\bsrc="([^"]+)"/i.exec(decode([body, tag(b, 'content'), tag(b, 'content:encoded'), tag(b, 'description')].join(' '))); if (m) image = decode(m[1]); }
    let summary = strip(body);
    if (summary.length > 420) summary = summary.slice(0, 400).replace(/\s+\S*$/, '') + '…';
    out.push({ title, link, source, at: Number.isFinite(when) ? when : 0, image: httpUrl(image) || null, summary });
  }
  return out;
}

function createNews(userDataDir, opts) {
  opts = opts || {};
  const file = path.join(userDataDir, 'news.json');
  const doFetch = opts.fetch || ((...a) => fetch(...a));
  const feeds = opts.feeds || FEEDS;
  let cache = null, busy = null;
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { cache = null; }

  async function fetchOne(f) {
    const res = await doFetch(f.url, { headers: { 'User-Agent': 'Mozilla/5.0 CouchLauncher', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(f.name + ': HTTP ' + res.status);
    return parseFeed(await res.text(), f.name);
  }
  async function refresh() {
    if (busy) return busy;
    busy = (async () => {
      const results = await Promise.allSettled(feeds.map(fetchOne));
      const all = [].concat(...results.filter((r) => r.status === 'fulfilled').map((r) => r.value));
      if (!all.length) throw new Error('Couldn’t reach any news sites');
      const seen = new Set(), items = [];
      const week = Date.now() - 7 * 24 * 3600 * 1000;
      for (const it of all.sort((a, b) => b.at - a.at)) {
        const k = it.link.replace(/[?#].*$/, '').toLowerCase(), t = it.title.toLowerCase();
        if (seen.has(k) || seen.has(t) || (it.at && it.at < week)) continue;
        seen.add(k); seen.add(t);
        items.push(it);
        if (items.length >= 60) break;
      }
      cache = { at: Date.now(), items, sources: results.filter((r) => r.status === 'fulfilled').length };
      try { fs.mkdirSync(userDataDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(cache)); } catch (_) { /* not critical */ }
      return cache;
    })().finally(() => { busy = null; });
    return busy;
  }
  // The news, refreshing first when it's older than a couple of hours.
  async function get(force) {
    if (!force && cache && Date.now() - cache.at < EVERY) return cache;
    try { return await refresh(); } catch (e) { if (cache) return cache; throw e; }
  }
  const has = (link) => !!(cache && cache.items.some((i) => i.link === link));
  return { get, refresh, has, EVERY };
}

module.exports = { createNews, parseFeed, FEEDS };
