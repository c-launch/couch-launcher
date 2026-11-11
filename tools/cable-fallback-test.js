// Cable TV playback in the app core, with a fake player, addons, YouTube helper and clock.
const assert = require('assert');
const path = require('path'), os = require('os'), fs = require('fs');
const { EventEmitter } = require('events');
global.fetch = async (u) => (String(u).includes('notice-') ? { status: 302, headers: { get: () => '/videos/removed_v2.mp4' } } : { status: 200, headers: { get: () => null } });
const SRC = require('path').resolve(__dirname, '..', 'src') + '/';
let NOW = new Date(2026, 10, 9, 18, 0, 3).getTime(); // 6:00:03 PM
const realNow = Date.now;
Date.now = () => NOW;
const loads = [];
const SUBS = [];
const DEAD = new Set(), SILENT = new Set(), SHORT = new Set(), NOTICEV = new Set(); let lookups = [];
let mpvCount = 0;
const PLAYER = { noTwo: false, mute: false };
function fakeMpv(url, title, at) {
  const m = new EventEmitter();
  m.alive = true; m.paused = false; mpvCount++;
  m.load = async (u, t, a, x) => { if (x && x.audio && PLAYER.noTwo) throw Object.assign(new Error('no'), { code: 'NO_SEPARATE_AUDIO' }); loads.push({ u, t, a, audio: (x && x.audio) || null }); m.paused = false; setTimeout(() => m.emit('tracks', { subs: [], audio: x && x.audio && PLAYER.mute ? [] : [{ id: 1, label: 'a', lang: '', selected: true }] }), 8); if (![...SILENT].some((x) => u.endsWith(x))) setTimeout(() => m.emit('time', { pos: (a || 0) + 0.5, dur: [...SHORT].some((x) => u.endsWith(x)) ? 20 : u.includes('ep') ? 1320 : 900 }), 5); };
  m.pause = (p) => { m.paused = !!p; return Promise.resolve(); };
  m.quit = () => { m.alive = false; };
  m.setSub = (id) => { SUBS.push(id); }; m.addSubs = () => {};
  loads.push({ u: url, t: title, a: at, start: true });
  global.__mpv = m;
  if (![...SILENT].some((x) => url.endsWith(x))) setTimeout(() => m.emit('time', { pos: (at || 0) + 0.5, dur: [...SHORT].some((x) => url.endsWith(x)) ? 20 : url.includes('ep') ? 1320 : 900 }), 5);
  return m;
}
require.cache[require.resolve(SRC + 'tvplayer.js')] = { exports: { createEngine: () => ({ available: () => true, torrentUrl: async () => 'http://torrent' }), startMpv: (exe, o) => fakeMpv(o.url, o.title, o.startAt), extrasOk: async () => true, findMpv: () => 'C:\\mpv.exe' } };
const YT = { searches: 0, direct: [], fail: false };
require.cache[require.resolve(SRC + 'ytdlp.js')] = { exports: { createYtdlp: () => ({ install: async () => 'x', search: async (q) => { YT.searches++; if (YT.fail) throw new Error('offline'); const w = q.split(' commercial')[0]; return [1, 2, 3].map((i) => ({ id: (w.replace(/\W/g, '') + 'aaaaaaaaaaa').slice(0, 10) + i, title: w + ' commercial break 201' + i, duration: 900 })); }, media: async (id) => { YT.direct.push(id); if (YT.media) { const m = YT.media(id); if (m instanceof Error) throw m; if (m) return m; } return { url: 'https://yt/' + id, audio: null, width: 1280, height: 720, plain: 'https://yt/' + id }; } }) } };
const showsFor = (q) => [{ type: 'series', items: [{ id: 'tt' + (Math.abs([...q].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) % 1e7), name: q, releaseInfo: '2010–2014', type: 'series' }] }];
require.cache[require.resolve(SRC + 'stremio.js')] = { exports: Object.assign({}, require(SRC + 'stremio.js'), {
  createStremio: () => ({
    search: async (q) => showsFor(q),
    meta: async (type, id) => ({ name: 'Show ' + id, runtime: '22 min', poster: null, videos: Array.from({ length: 20 }, (_, j) => ({ id: id + ':1:' + (j + 1), season: 1, episode: j + 1, released: '2012-01-01' })) }),
    streams: async (type, vid) => { lookups.push(vid); return DEAD.has(vid) ? { groups: [] } : ({ groups: [{ addon: 'X', streams: [...(NOTICEV.has(vid) ? [{ addon: 'X', label: '1080p', quality: '1080p', kind: 'url', playable: true, cached: true, url: 'https://ep/notice-' + vid }] : []), { addon: 'X', label: '1080p', quality: '1080p', kind: 'url', playable: true, url: 'https://ep/' + vid }] }] }); },
    subtitles: async () => [], progress: () => { throw new Error('cable must not save progress'); }, flush: () => {}, resumeAt: () => 0
  })
}) };
const { setupTv } = require(SRC + 'tvmain.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cabplay'));
const handlers = {}, sent = [], huds = [];
class FakeWin extends EventEmitter {
  constructor() { super(); this.webContents = { send: (ch, v) => { if (ch === 'hud') huds.push(v); }, setWindowOpenHandler() {}, on() {} }; this.destroyed = false; }
  setIgnoreMouseEvents() {} setAlwaysOnTop() {} loadFile() {} isDestroyed() { return this.destroyed; } setBounds() {} showInactive() {} hide() {} destroy() { this.destroyed = true; }
}
const settings = { cableAds: true };
const tvPart = setupTv({
  app: { getPath: () => dir }, safeStorage: {}, shell: {}, clipboard: {}, BrowserWindow: FakeWin,
  handle: (n, f) => { handlers[n] = f; }, send: (ch, v) => sent.push([ch, v]), settings: () => settings,
  targetDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }), toPx: (b) => b, presentApp: () => () => {}, bringBack: () => {}, saveSettings: () => {}
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lastHud = () => huds[huds.length - 1] && huds[huds.length - 1].cable;
const step = async (sec) => { NOW += sec * 1000; await wait(320); };
(async () => {
  handlers['tv:cableSetEras'](['2010s']);
  assert.ok((await handlers['tv:cableSetup']()).ready);
  const cur = (id) => handlers['tv:cableGuide'](NOW, NOW + 3600e3).channels.find((c) => c.id === id).programs.find((p) => p.start <= NOW && p.end > NOW);
  // 1) the scheduled episode has no stream: another episode of the same show goes on
  const p1 = cur('nick');
  DEAD.add(p1.video.id);
  await handlers['tv:cableTune']('nick');
  await wait(200);
  const l1 = loads[loads.length - 1];
  assert.ok(l1 && l1.u.startsWith('https://ep/') && l1.u !== 'https://ep/' + p1.video.id, 'another episode plays: ' + JSON.stringify(l1));
  assert.ok(l1.u.startsWith('https://ep/' + p1.showId + ':'), 'same show first');
  assert.ok(Math.abs(l1.a - 3) < 1, 'at the same point in the slot');
  assert.strictEqual(lastHud().blank, false); assert.ok(!lastHud().status, 'no error on screen');
  const p1b = cur('nick');
  assert.ok(p1b.start === p1.start && p1b.end === p1.end && 'https://ep/' + p1b.video.id === l1.u, 'the guide shows what is really on');
  assert.strictEqual(lastHud().show, p1b.show);
  // captions: a Russian track the file marks as default is turned off (the setting is English)
  const M = global.__mpv, B = { UP: 0x1, DOWN: 0x2, A: 0x1000, B: 0x2000, Y: 0x8000 };
  const tap = async (bit) => { tvPart.padInput ? tvPart.padInput(bit, 0, 0) : null; };
  const RU = { id: 1, label: 'Russian', lang: 'rus' }, EN = { id: 2, label: 'English', lang: 'eng' }, EN2 = { id: 3, label: 'English SDH', lang: 'en' };
  const tr = (list, sel) => ({ subs: list.map((x) => Object.assign({}, x, { selected: x.id === sel })), audio: [] });
  SUBS.length = 0; M.emit('tracks', tr([RU], 1));
  assert.deepStrictEqual(SUBS, [null], 'other-language default captions off');
  SUBS.length = 0; M.emit('tracks', tr([RU], null)); assert.deepStrictEqual(SUBS, [], 'nothing more to do');
  SUBS.length = 0; M.emit('tracks', tr([RU, EN, EN2], 1)); assert.deepStrictEqual(SUBS, [2], 'English picked over Russian');
  SUBS.length = 0; M.emit('tracks', tr([RU, EN, EN2], 3)); assert.deepStrictEqual(SUBS, [], 'an English one already on stays');
  // the list: Y opens it, down + A picks; kept in settings and applied to later episodes
  const ctl = { input: (m, x, y) => tvPart.input(m, x, y) };
  ctl.input(B.Y, 0, 0); ctl.input(0, 0, 0);
  assert.deepStrictEqual(lastHud().menu.items.map((i) => i.label + (i.selected ? '*' : '') + (i.focused ? '<' : '')), ['Off', 'Russian', 'English', 'English SDH*<']);
  const nLoads = loads.length;
  ctl.input(B.UP, 0, 0); ctl.input(0, 0, 0); ctl.input(B.UP, 0, 0); ctl.input(0, 0, 0);
  assert.strictEqual(loads.length, nLoads, 'up in the list does not change the channel');
  assert.ok(lastHud().menu.items[1].focused);
  SUBS.length = 0; ctl.input(B.A, 0, 0); ctl.input(0, 0, 0);
  assert.deepStrictEqual(SUBS, [1]); assert.strictEqual(lastHud().menu, null); assert.deepStrictEqual(settings.cableSubs, { lang: 'rus', label: 'Russian' });
  SUBS.length = 0; M.emit('tracks', tr([EN, RU], 2)); assert.deepStrictEqual(SUBS, [1], 'the picked language on the next episode');
  SUBS.length = 0; M.emit('tracks', tr([EN], 2)); assert.deepStrictEqual(SUBS, [null], 'none in that language: off');
  ctl.input(B.Y, 0, 0); ctl.input(0, 0, 0); ctl.input(B.UP, 0, 0); ctl.input(0, 0, 0); ctl.input(B.UP, 0, 0); ctl.input(0, 0, 0); ctl.input(B.A, 0, 0); ctl.input(0, 0, 0);
  assert.strictEqual(settings.cableSubs, 'off');
  SUBS.length = 0; M.emit('tracks', tr([EN, RU], 2)); assert.deepStrictEqual(SUBS, [null], 'off stays off');
  ctl.input(B.Y, 0, 0); ctl.input(0, 0, 0); assert.ok(lastHud().menu); ctl.input(B.B, 0, 0); ctl.input(0, 0, 0);
  assert.ok(lastHud().menu === null && loads.length === nLoads, 'B closes the list, still watching');
  delete settings.cableSubs;
  // coming back to the channel: no new search for the dead one, same replacement
  await handlers['tv:cableTune']('disney'); await wait(200);
  lookups = [];
  await handlers['tv:cableTune']('nick'); await wait(200);
  assert.ok(!lookups.includes(p1.video.id) && loads[loads.length - 1].u === l1.u, 'replacement kept for the slot');
  // 2) a whole show is dead: another show of the channel goes on
  const p2 = cur('cn');
  const origStreams = DEAD.has;
  DEAD.has = (v) => v.startsWith(p2.showId + ':');
  await handlers['tv:cableTune']('cn'); await wait(300);
  const l2 = loads[loads.length - 1];
  assert.ok(l2.u.startsWith('https://ep/') && !l2.u.startsWith('https://ep/' + p2.showId + ':'), 'another show plays: ' + JSON.stringify(l2));
  assert.ok(cur('cn').showId !== p2.showId && lastHud().show === cur('cn').show && !lastHud().status);
  DEAD.has = origStreams;
  // 3) nothing on the channel can be found: the message, as before
  const p3 = cur('xd');
  DEAD.has = () => true;
  await handlers['tv:cableTune']('xd'); await wait(300);
  assert.ok(/No stream found/.test(lastHud().status) && lastHud().blank, 'says so when nothing works: ' + lastHud().status);
  DEAD.has = origStreams;
  // 4) a stream that never starts: after 30 s another episode goes on
  const p4 = cur('disney');
  SILENT.add('/' + p4.video.id);
  const n = loads.length;
  await handlers['tv:cableTune']('disney'); await wait(300);
  assert.ok(loads[loads.length - 1].u === 'https://ep/' + p4.video.id && lastHud().blank, 'dead stream: still black');
  await wait(30500);
  const l4 = loads[loads.length - 1];
  assert.ok(l4.u !== 'https://ep/' + p4.video.id && l4.u.startsWith('https://ep/'), 'replaced after it never started: ' + JSON.stringify(l4));
  assert.strictEqual(lastHud().blank, false);
  // 5) the debrid service's short "failed" notice instead of the episode: replaced at once
  const p5 = cur('pbs');
  SHORT.add('/' + p5.video.id);
  await handlers['tv:cableTune']('pbs'); await wait(400);
  const l5 = loads[loads.length - 1];
  assert.ok(loads.some((l) => l.u === 'https://ep/' + p5.video.id), 'the notice was opened first');
  assert.ok(l5.u !== 'https://ep/' + p5.video.id && l5.u.startsWith('https://ep/'), 'replaced: ' + JSON.stringify(l5));
  assert.strictEqual(lastHud().blank, false); assert.ok(cur('pbs').video.id !== p5.video.id);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'cable.json'), 'utf8'));
  assert.ok(!saved.durs || !saved.durs[p5.video.id], 'the notice length is not kept as the episode length');
  // 6) the best link leads to a debrid notice video: the next stream of the same episode plays
  NOW += 31 * 60e3;
  const p6 = cur('nick');
  NOTICEV.add(p6.video.id);
  await handlers['tv:cableTune']('nick'); await wait(400);
  const l6 = loads[loads.length - 1];
  assert.ok(l6.u === 'https://ep/' + p6.video.id, 'next stream of the same episode: ' + JSON.stringify(l6));
  assert.ok(!loads.some((l) => l.u.includes('notice-')), 'the notice never reaches the screen');
  // every stream is a notice: another episode
  const realFetch = global.fetch;
  global.fetch = async (u) => (String(u).endsWith('/' + p6.video.id) || String(u).includes('notice-') ? { status: 302, headers: { get: () => 'https://x.y/videos/failed_download_v2.mp4' } } : { status: 200, headers: { get: () => null } });
  await handlers['tv:cableTune']('disney'); await wait(300);
  await handlers['tv:cableTune']('nick'); await wait(400);
  const l7 = loads[loads.length - 1];
  assert.ok(l7.u.startsWith('https://ep/') && !l7.u.endsWith('/' + p6.video.id) && !l7.u.includes('notice-'), 'another episode: ' + JSON.stringify(l7));
  global.fetch = realFetch;
  // 7) the player can't open the link at all: it stays open, another episode goes on
  NOW += 31 * 60e3;
  await handlers['tv:cableTune']('cn'); await wait(300);
  const l8 = loads[loads.length - 1], count = mpvCount;
  global.__mpv.emit('failed', 'loading failed'); await wait(300);
  const l9 = loads[loads.length - 1];
  assert.ok(l9.u.startsWith('https://ep/') && l9.u !== l8.u && mpvCount === count && global.__mpv.alive, 'dead link: another episode, same player: ' + JSON.stringify(l9));
  assert.ok(!sent.some(([ch]) => ch === 'tv:ended'), 'not kicked out of the channel');
  // a commercial that can't be opened: another one, then the plain break card
  { const on = handlers['tv:cableGuide'](NOW, NOW + 60e3).channels.find((x) => x.id === 'cn').programs.find((x) => x.start <= NOW && x.end > NOW);
    await step(335 - Math.round((NOW - on.start) / 1000)); await wait(200); } // 5 s into the slot's first break (330 s in)
  assert.strictEqual(lastHud().part, 'ad');
  const a1 = loads.length;
  global.__mpv.emit('failed', ''); await wait(700);
  assert.ok(loads.length === a1 + 1 && loads[loads.length - 1].u.startsWith('https://yt/'), 'another commercial');
  global.__mpv.emit('failed', ''); await wait(700);
  global.__mpv.emit('failed', ''); await wait(700);
  assert.ok(lastHud().part === 'filler' && /couldn’t be played/.test(lastHud().why) && global.__mpv.alive, 'then the break card: ' + JSON.stringify(lastHud()));
  assert.ok(!sent.some(([ch]) => ch === 'tv:ended'));
  // 8) the player itself crashes: started again on the same channel, twice; a third crash ends it
  NOW += 31 * 60e3; sent.length = 0;
  await handlers['tv:cableTune']('disney'); await wait(400);
  let cnt = mpvCount, old = global.__mpv;
  old.alive = false; old.emit('exit', { code: 1 }); await wait(700);
  assert.ok(mpvCount === cnt + 1 && global.__mpv !== old && global.__mpv.alive && !sent.some(([ch]) => ch === 'tv:ended'), 'player restarted after a crash: ' + mpvCount + ' vs ' + cnt);
  assert.ok(loads[loads.length - 1].u.startsWith('https://') && lastHud().blank === false, 'and playing again');
  old = global.__mpv; old.alive = false; old.emit('exit', { code: -1 }); await wait(700);
  assert.ok(mpvCount === cnt + 2 && !sent.some(([ch]) => ch === 'tv:ended'), 'second crash: restarted');
  old = global.__mpv; old.alive = false; old.emit('exit', { code: 1 }); await wait(500);
  assert.ok(mpvCount === cnt + 2 && sent.some(([ch]) => ch === 'tv:ended'), 'third crash in a row: back to the guide');
  // closing the player yourself ends it at once
  sent.length = 0; await handlers['tv:cableTune']('nick'); await wait(400); cnt = mpvCount;
  global.__mpv.alive = false; global.__mpv.emit('exit', { code: 0 }); await wait(400);
  assert.ok(mpvCount === cnt && sent.some(([ch]) => ch === 'tv:ended'), 'closed by you: ends');
  // 9) commercials: widescreen HD first, picture and sound together, and every way that can go wrong
  {
    const chan = (id) => handlers['tv:cableGuide'](NOW, NOW + 60e3).channels.find((x) => x.id === id).programs.find((x) => x.start <= NOW && x.end > NOW);
    // (three recordings per channel here: …1 is a 4:3 box, …2 is 1080p widescreen in two links, …3 a small one-file box)
    YT.media = (id) => (id.endsWith('1') ? { url: 'https://yt/v/' + id, audio: 'https://yt/a/' + id, width: 640, height: 480, plain: 'https://yt/p/' + id }
      : id.endsWith('2') ? { url: 'https://yt/v/' + id, audio: 'https://yt/a/' + id, width: 1920, height: 1080, plain: 'https://yt/p/' + id }
      : { url: 'https://yt/p/' + id, audio: null, width: 480, height: 360, plain: 'https://yt/p/' + id });
    const toBreak = async (id, n) => { const on = chan(id); const at = [330, 780, 1230, 1680][n]; await step(at - 30 - Math.round((NOW - on.start) / 1000)); await wait(350); await step(35); await wait(250); return loads[loads.length - 1]; };
    NOW += 31 * 60e3; sent.length = 0; YT.direct.length = 0;
    await handlers['tv:cableTune']('nick'); await wait(400);
    let ad = await toBreak('nick', 0);
    assert.ok(/^https:\/\/yt\/v\/.*2$/.test(ad.u) && /^https:\/\/yt\/a\/.*2$/.test(ad.audio || ''), 'the widescreen 1080p one plays, picture and sound together: ' + JSON.stringify(ad));
    assert.strictEqual(lastHud().part, 'ad');
    // back to the show: its sound must not be the commercial's
    await step(125); await wait(250);
    let back = loads[loads.length - 1];
    assert.ok(back.u.startsWith('https://ep/') && back.audio === null, 'the show loads without the commercial’s sound: ' + JSON.stringify(back));
    // next break: the good one is remembered (opened once, not searched for again)
    let d0 = YT.direct.length; ad = await toBreak('nick', 1);
    // (The ones not opened yet are opened first, in no set order, until enough good ones are
    // known: with three recordings that is three lookups at most here, and nothing is searched for.)
    assert.ok(/2$/.test(ad.u) && ad.audio && YT.direct.length - d0 <= 3, 'the good one again: ' + (YT.direct.length - d0) + ' lookups');
    await step(125); await wait(250); d0 = YT.direct.length; ad = await toBreak('nick', 2);
    assert.ok(/2$/.test(ad.u) && YT.direct.length - d0 <= 2, 'all three are known by now: the good one is opened straight away (' + (YT.direct.length - d0) + ' lookups)');
    // the sound's link doesn't open: the same commercial from its one-file link, from where it was
    await step(125); await wait(250); PLAYER.mute = true;
    ad = await toBreak('nick', 3);
    assert.ok(ad.audio, 'played as two links first');
    await wait(6300);
    let again = loads[loads.length - 1];
    assert.ok(/^https:\/\/yt\/p\/.*2$/.test(again.u) && again.audio === null && again.a >= ad.a, 'no sound: reloaded from the one-file link: ' + JSON.stringify(again));
    PLAYER.mute = false;
    // a player that won't take two links at all: the one-file link, and it isn't tried again
    NOW += 31 * 60e3; await handlers['tv:cableTune']('cn'); await wait(400); PLAYER.noTwo = true;
    ad = await toBreak('cn', 0);
    assert.ok(/^https:\/\/yt\/p\/.*2$/.test(ad.u) && ad.audio === null && lastHud().part === 'ad', 'one-file link when two can’t be played: ' + JSON.stringify(ad));
    await step(125); await wait(250); PLAYER.noTwo = false; // (even if it could now: remembered for this run)
    ad = await toBreak('cn', 1);
    assert.ok(/^https:\/\/yt\/p\//.test(ad.u) && ad.audio === null, 'not tried again');
    // a channel with only box recordings: the best of them plays as it is
    YT.media = (id) => (id.endsWith('1') ? { url: 'https://yt/p/' + id, audio: null, width: 640, height: 480, plain: 'https://yt/p/' + id } : id.endsWith('2') ? { url: 'https://yt/p/' + id, audio: null, width: 320, height: 240, plain: 'https://yt/p/' + id } : new Error('This video is not available'));
    NOW += 31 * 60e3; await handlers['tv:cableTune']('disney'); await wait(400);
    ad = await toBreak('disney', 0);
    assert.ok(/^https:\/\/yt\/p\/.*1$/.test(ad.u) && lastHud().part === 'ad', 'only boxes: the 480p one, as it is: ' + JSON.stringify(ad));
    YT.media = null;
    assert.ok(!sent.some(([ch]) => ch === 'tv:ended'), 'still watching through all of it');
  }
  handlers['tv:stop'] && await handlers['tv:stop']();
  console.log('cable fallback ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
