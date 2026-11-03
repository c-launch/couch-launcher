'use strict';
// Free games and deals for Home.
//  - Epic Games Store's weekly free games (now and next), from the same public list the Epic
//    store page uses.
//  - Giveaways (100% off) and the best current deals from CheapShark (cheapshark.com), which
//    tracks prices at Steam, GOG, Humble, Fanatical and other official stores.
//  - Watched games: the launcher checks their price now and then and tells you when it drops.
// Prices from CheapShark are in US dollars.

const fs = require('fs');
const path = require('path');

const EPIC = 'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions';
const CS = 'https://www.cheapshark.com/api/1.0';
// Official stores only (CheapShark store IDs): Steam, GreenManGaming, GOG, Humble, Fanatical,
// Epic, Gamesplanet.
const STORE_IDS = ['1', '3', '7', '11', '15', '25', '27'];
const STORE_NAMES = { 1: 'Steam', 3: 'GreenManGaming', 7: 'GOG', 11: 'Humble', 15: 'Fanatical', 25: 'Epic Games Store', 27: 'Gamesplanet' };
const EVERY = 3 * 60 * 60 * 1000;
const WATCH_EVERY = 6 * 60 * 60 * 1000;
const MAX_WATCH = 50;

const httpUrl = (u) => (/^https:\/\/[^\s"<>]+$/i.test(String(u || '').trim()) ? String(u).trim() : null);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const SLUG = /^[a-z0-9][a-z0-9-]{0,120}$/i;
const DEAL_ID = /^[A-Za-z0-9%+/=_-]{8,200}$/;
const GAME_ID = /^\d{1,10}$/;
const APP_ID = /^\d{1,10}$/;
const steamImg = (id) => 'https://cdn.cloudflare.steamstatic.com/steam/apps/' + id + '/header.jpg';

// ---------- Epic ----------
function epicSlug(e) {
  const clean = (s) => { s = String(s || '').replace(/\/home$/, ''); return SLUG.test(s) ? s : null; };
  const maps = [].concat(e.offerMappings || [], (e.catalogNs && e.catalogNs.mappings) || []);
  const home = maps.find((m) => m && m.pageType === 'productHome' && clean(m.pageSlug));
  return clean(e.productSlug) || (home && clean(home.pageSlug)) || clean(maps[0] && maps[0].pageSlug) || clean(e.urlSlug);
}
function epicImage(e) {
  const imgs = Array.isArray(e.keyImages) ? e.keyImages : [];
  for (const t of ['OfferImageWide', 'DieselStoreFrontWide', 'featuredMedia', 'Thumbnail', 'OfferImageTall']) {
    const k = imgs.find((i) => i && i.type === t && httpUrl(i.url));
    if (k) return httpUrl(k.url);
  }
  const any = imgs.find((i) => i && httpUrl(i.url));
  return any ? httpUrl(any.url) : null;
}
// Free offers (0% of the price) in a promotions list: [{ from, until }].
function freeWindows(groups) {
  const out = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    for (const o of (g && Array.isArray(g.promotionalOffers) ? g.promotionalOffers : [])) {
      const d = o && o.discountSetting;
      if (!d || Number(d.discountPercentage) !== 0) continue;
      const from = Date.parse(o.startDate), until = Date.parse(o.endDate);
      if (Number.isFinite(from) && Number.isFinite(until) && until > from) out.push({ from, until });
    }
  }
  return out;
}
function parseEpic(j, now) {
  const els = (j && j.data && j.data.Catalog && j.data.Catalog.searchStore && j.data.Catalog.searchStore.elements) || [];
  const out = [];
  for (const e of Array.isArray(els) ? els : []) {
    if (!e || !e.title || /^mystery game/i.test(e.title)) continue;
    const slug = epicSlug(e);
    if (!slug) continue;
    const p = e.promotions || {};
    const cur = freeWindows(p.promotionalOffers).find((w) => w.from <= now && now < w.until);
    const next = freeWindows(p.upcomingPromotionalOffers).filter((w) => w.from > now).sort((a, b) => a.from - b.from)[0];
    const w = cur || next;
    if (!w) continue;
    const tp = e.price && e.price.totalPrice;
    const was = tp && tp.fmtPrice && typeof tp.fmtPrice.originalPrice === 'string' && tp.fmtPrice.originalPrice !== '0' ? tp.fmtPrice.originalPrice.slice(0, 20) : null;
    out.push({
      id: 'epic:' + slug, kind: 'free', title: String(e.title).slice(0, 120), store: 'Epic Games Store', storeId: '25',
      image: epicImage(e), from: w.from, until: w.until, upcoming: !cur, was, slug
    });
  }
  // Free now first (ending soonest), then the upcoming ones.
  return out.sort((a, b) => (a.upcoming - b.upcoming) || (a.upcoming ? a.from - b.from : a.until - b.until)).slice(0, 8);
}

// ---------- CheapShark ----------
function csDeal(d, stores) {
  if (!d || !d.title || !DEAL_ID.test(String(d.dealID || '')) || !GAME_ID.test(String(d.gameID || ''))) return null;
  const price = num(d.salePrice), normal = num(d.normalPrice);
  if (price == null || normal == null) return null;
  const app = APP_ID.test(String(d.steamAppID || '')) && d.steamAppID !== '0' ? String(d.steamAppID) : null;
  const sid = String(d.storeID || '');
  return {
    id: 'cs:' + d.dealID, dealID: String(d.dealID), gameID: String(d.gameID), title: String(d.title).slice(0, 120),
    storeId: sid, store: stores[sid] || STORE_NAMES[sid] || 'A store',
    price, normal, savings: Math.round(num(d.savings) || 0),
    image: app ? steamImg(app) : httpUrl(d.thumb), thumb: httpUrl(d.thumb), steamAppID: app,
    score: num(d.metacriticScore) || 0, rating: num(d.steamRatingPercent) || 0
  };
}
function parseGiveaways(list, stores) {
  const out = [], seen = new Set();
  for (const d of Array.isArray(list) ? list : []) {
    const x = csDeal(d, stores);
    if (!x || x.price !== 0 || !(x.normal > 0) || !STORE_IDS.includes(x.storeId) || seen.has(x.gameID)) continue;
    seen.add(x.gameID);
    out.push(Object.assign(x, { kind: 'free', upcoming: false }));
  }
  return out.slice(0, 8);
}
function parseDeals(list, stores) {
  const out = [], seen = new Set();
  for (const d of Array.isArray(list) ? list : []) {
    const x = csDeal(d, stores);
    if (!x || !(x.price > 0) || !(x.normal > x.price) || x.savings < 20 || !STORE_IDS.includes(x.storeId) || seen.has(x.gameID)) continue;
    seen.add(x.gameID);
    out.push(Object.assign(x, { kind: 'deal' }));
  }
  return out.slice(0, 24);
}
// /games?ids= answer -> { gameID: { title, image, price, normal, store, storeId, dealID, lowest } }
function parseWatch(j, stores) {
  const out = {};
  for (const [id, g] of Object.entries(j && typeof j === 'object' ? j : {})) {
    if (!GAME_ID.test(id) || !g || !Array.isArray(g.deals)) continue;
    let best = null;
    for (const d of g.deals) {
      const price = num(d && d.price);
      if (price == null || !STORE_IDS.includes(String(d.storeID)) || !DEAL_ID.test(String(d.dealID || ''))) continue;
      if (!best || price < best.price) best = { price, normal: num(d.retailPrice), storeId: String(d.storeID), dealID: String(d.dealID) };
    }
    if (!best) continue;
    out[id] = Object.assign(best, {
      store: stores[best.storeId] || STORE_NAMES[best.storeId] || 'A store',
      title: g.info && g.info.title ? String(g.info.title).slice(0, 120) : null,
      lowest: g.cheapestPriceEver ? num(g.cheapestPriceEver.price) : null
    });
  }
  return out;
}

function createDeals({ userDataDir, fetch: doFetch, now, country }) {
  doFetch = doFetch || ((...a) => fetch(...a));
  now = now || Date.now;
  const cc = /^[A-Z]{2}$/.test(String(country || '')) ? country : 'US';
  const file = path.join(userDataDir, 'deals.json');
  let data = null, busy = null;
  const load = () => {
    if (!data) {
      try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { data = null; }
      if (!data || typeof data !== 'object') data = {};
      data.watch = Array.isArray(data.watch) ? data.watch : [];
      data.seenFree = Array.isArray(data.seenFree) ? data.seenFree : null; // null: nothing learned yet
    }
    return data;
  };
  const save = () => { try { fs.mkdirSync(userDataDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); } catch (_) { /* not critical */ } };

  async function json(url) {
    const res = await doFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 CouchLauncher', Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }
  async function storeNames() {
    const d = load();
    if (d.stores && now() - (d.storesAt || 0) < 7 * 864e5) return d.stores;
    try {
      const list = await json(CS + '/stores');
      const m = {};
      for (const s of Array.isArray(list) ? list : []) if (s && /^\d+$/.test(String(s.storeID)) && s.storeName) m[String(s.storeID)] = String(s.storeName).slice(0, 40);
      if (Object.keys(m).length) { d.stores = m; d.storesAt = now(); }
    } catch (_) { /* the built-in names do */ }
    return d.stores || STORE_NAMES;
  }

  async function refresh() {
    if (busy) return busy;
    busy = (async () => {
      const d = load();
      const stores = await storeNames();
      const t = now();
      const [epic, give, top] = await Promise.allSettled([
        json(EPIC + '?locale=en-US&country=' + cc + '&allowCountries=' + cc).then((j) => parseEpic(j, t)),
        json(CS + '/deals?upperPrice=0&pageSize=60&storeID=' + STORE_IDS.join(',')).then((l) => parseGiveaways(l, stores)),
        json(CS + '/deals?sortBy=Deal%20Rating&onSale=1&pageSize=60&storeID=' + STORE_IDS.join(',')).then((l) => parseDeals(l, stores))
      ]);
      if (epic.status === 'rejected' && give.status === 'rejected' && top.status === 'rejected') throw new Error('Couldn’t reach the stores');
      const keep = (r, old) => (r.status === 'fulfilled' ? r.value : old || []);
      const epicList = keep(epic, d.epic), giveList = keep(give, d.give);
      // A giveaway on Epic is already in Epic's own list.
      const epicNames = new Set(epicList.map((e) => normTitle(e.title)));
      d.epic = epicList;
      d.give = giveList.filter((g) => !(g.storeId === '25' && epicNames.has(normTitle(g.title))));
      d.deals = keep(top, d.deals);
      d.at = t;
      save();
      return d;
    })().finally(() => { busy = null; });
    return busy;
  }
  async function get(force) {
    const d = load();
    if (!force && d.at && now() - d.at < EVERY) return d;
    try { return await refresh(); } catch (e) { if (d.at) return d; throw e; }
  }

  // Free games that weren't there before (only free right now, not upcoming). The first time it
  // only learns what's already free.
  function newFree() {
    const d = load(), t = now();
    const isNow = (f) => (f.upcoming ? f.from <= t : true) && !(f.until && f.until <= t);
    const keys = (f) => [f.id, 't:' + normTitle(f.title)]; // the same game can come from Epic and CheapShark
    const current = [].concat(d.epic || [], d.give || []).filter(isNow);
    const first = d.seenFree == null;
    const seen = new Set(d.seenFree || []);
    const fresh = [];
    for (const f of current) {
      if (!first && !keys(f).some((k) => seen.has(k))) fresh.push(f);
      keys(f).forEach((k) => seen.add(k));
    }
    d.seenFree = [...seen].slice(-400);
    save();
    return fresh;
  }

  // Everything on Home: what to show, by kind.
  function view() {
    const d = load(), t = now();
    const free = [].concat(d.epic || [], d.give || [])
      .filter((f) => !(f.until && f.until <= t))
      .map((f) => Object.assign({}, f, { upcoming: !!(f.upcoming && f.from > t) }));
    const watched = new Set(d.watch.map((w) => w.gameID));
    return {
      at: d.at || 0,
      free,
      deals: (d.deals || []).map((x) => Object.assign({}, x, { watched: watched.has(x.gameID) })),
      watch: d.watch.slice()
    };
  }
  const find = (id) => { const v = view(); return [].concat(v.free, v.deals).find((x) => x.id === id) || null; };

  // ---------- Watched games ----------
  function watch(item) {
    const d = load();
    if (!item || !GAME_ID.test(String(item.gameID || ''))) throw new Error('That game can’t be watched');
    if (d.watch.some((w) => w.gameID === item.gameID)) return d.watch.slice();
    if (d.watch.length >= MAX_WATCH) throw new Error('You’re watching ' + MAX_WATCH + ' games already');
    d.watch.push({ gameID: item.gameID, title: item.title, image: item.image || null, steamAppID: item.steamAppID || null, price: item.price, best: item.price, store: item.store, storeId: item.storeId, dealID: item.dealID, at: now(), checked: now() });
    save();
    return d.watch.slice();
  }
  function unwatch(gameID) {
    const d = load();
    d.watch = d.watch.filter((w) => w.gameID !== String(gameID));
    save();
    return d.watch.slice();
  }
  // Checks watched prices; returns the ones that dropped below the lowest price seen so far.
  async function checkWatch(force) {
    const d = load();
    const due = d.watch.filter((w) => force || now() - (w.checked || 0) >= WATCH_EVERY);
    if (!due.length) return [];
    const stores = await storeNames();
    const drops = [];
    for (let i = 0; i < due.length; i += 25) {
      const part = due.slice(i, i + 25);
      let got;
      try { got = parseWatch(await json(CS + '/games?ids=' + part.map((w) => w.gameID).join(',')), stores); } catch (_) { continue; }
      for (const w of part) {
        const g = got[w.gameID];
        w.checked = now();
        if (!g) continue;
        w.now = { price: g.price, normal: g.normal, store: g.store, storeId: g.storeId, dealID: g.dealID, lowest: g.lowest };
        if (g.price < w.best - 0.005) { drops.push(Object.assign({}, w, { was: w.best })); w.best = g.price; }
      }
    }
    save();
    return drops;
  }

  return { get, refresh, view, find, newFree, watch, unwatch, checkWatch, watched: () => load().watch.slice(), EVERY };
}

const normTitle = (t) => String(t || '').toLowerCase().replace(/[™®©]/g, '').replace(/[^a-z0-9]+/g, '');

// Where a deal opens: Steam deals in Steam, Epic in the Epic launcher (when installed), the rest
// through CheapShark's link to the store page.
function openUrl(item, hasEpic) {
  if (!item) return null;
  if (item.slug && SLUG.test(item.slug)) return hasEpic ? 'com.epicgames.launcher://store/p/' + item.slug : 'https://store.epicgames.com/en-US/p/' + item.slug;
  if (item.storeId === '1' && item.steamAppID && APP_ID.test(item.steamAppID)) return 'steam://store/' + item.steamAppID;
  if (item.dealID && DEAL_ID.test(item.dealID)) {
    let id = item.dealID;
    try { id = decodeURIComponent(id); } catch (_) { /* already plain */ }
    return 'https://www.cheapshark.com/redirect?dealID=' + encodeURIComponent(id);
  }
  return null;
}

module.exports = { createDeals, parseEpic, parseGiveaways, parseDeals, parseWatch, openUrl, normTitle, STORE_IDS };
