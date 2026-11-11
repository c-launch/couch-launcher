// Couch Launcher and Couch TV keep Movies & TV's data in the same files and can both be open.
// Checks, with two stores on one file (as the two programs have):
//  - what one saves, the other sees (and neither wipes the other's changes with an old copy);
//  - the sign-in: read and saved in the launcher's own form when Couch TV has the launcher's
//    key; kept apart, without touching the launcher's, when it doesn't;
//  - the key itself (sharedkey.js): the text form, a wrong key, a damaged text, no key file.
'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const { createStremio } = require(path.join(ROOT, 'src', 'stremio.js'));
const { createCable } = require(path.join(ROOT, 'src', 'cable.js'));
const sk = require(path.join(ROOT, 'src', 'sharedkey.js'));
const util = require(path.join(ROOT, 'src', 'couchtv', 'util.js'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'couch-shared-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A file's time only has to differ for a change to be seen: make sure it does.
const tick = () => sleep(25);

// A safe storage like Electron's on Windows: its own key, the same text form.
const safe = (key) => ({ isEncryptionAvailable: () => true, encryptString: (s) => sk.encrypt(s, key), decryptString: (b) => { const r = sk.decrypt(b, key); if (r === null) throw new Error('cannot decrypt'); return r; } });
const K_LAUNCHER = crypto.randomBytes(32), K_TV = crypto.randomBytes(32);
const other = { encrypt: (t) => sk.encrypt(t, K_LAUNCHER), decrypt: (b) => sk.decrypt(b, K_LAUNCHER) };
// Stremio's servers, pretended: one account.
const calls = [];
const fetchFake = async (url, o) => {
  const body = o && o.body ? JSON.parse(o.body) : {};
  calls.push(String(url).split('/').pop());
  const ok = (result) => ({ ok: true, status: 200, json: async () => ({ result }) });
  if (/\/login$/.test(url)) return ok({ authKey: 'KEY-' + body.email, user: { email: body.email } });
  if (/\/getUser$/.test(url)) return ok({ email: String(body.authKey || '').replace('KEY-', '') });
  if (/\/addonCollectionGet$/.test(url)) return ok({ addons: [] });
  if (/\/datastoreMeta$/.test(url)) return ok([]);
  if (/\/datastoreGet$/.test(url)) return ok([]);
  if (/\/datastorePut$/.test(url)) return ok({ success: true });
  if (/\/logout$/.test(url)) return ok({ success: true });
  return { ok: false, status: 404, json: async () => null };
};
const launcherStore = (dir) => createStremio(dir, safe(K_LAUNCHER), { fetch: fetchFake });
const tvStore = (dir, withKey) => createStremio(dir, safe(K_TV), { fetch: fetchFake, ownSlot: 'authTv', other: withKey ? other : null });
const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'tv.json'), 'utf8'));

(async () => {
  // ---------- the key
  {
    const t = sk.encrypt('hello ☕', K_LAUNCHER);
    assert.strictEqual(t.slice(0, 3).toString(), 'v10');
    assert.strictEqual(sk.decrypt(t, K_LAUNCHER), 'hello ☕');
    assert.strictEqual(sk.decrypt(t, K_TV), null, 'another key reads nothing');
    const bad = Buffer.from(t); bad[20] ^= 1;
    assert.strictEqual(sk.decrypt(bad, K_LAUNCHER), null, 'a damaged text reads nothing');
    assert.strictEqual(sk.decrypt(Buffer.from('v10'), K_LAUNCHER), null);
    assert.strictEqual(sk.decrypt(Buffer.from('xx' + 'a'.repeat(40)), K_LAUNCHER), null);
    assert.notStrictEqual(sk.encrypt('a', K_LAUNCHER).toString('hex'), sk.encrypt('a', K_LAUNCHER).toString('hex'), 'never the same bytes twice');
    // The launcher's key file, with a pretend Windows that "unprotects" by reversing.
    const dir = path.join(TMP, 'keydir'); fs.mkdirSync(dir);
    const prot = Buffer.from(K_LAUNCHER).reverse();
    const ways = [['broken', () => { throw new Error('no'); }], ['empty', () => null], ['fake', (b) => Buffer.from(b).reverse()]];
    assert.strictEqual(sk.open(dir, { platform: 'win32', ways }), null, 'no key file: nothing');
    fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), prot]).toString('base64') } }));
    const k = sk.open(dir, { platform: 'win32', ways });
    assert.ok(k && k.how === 'fake', 'falls through the ways that fail to the one that works');
    assert.strictEqual(k.decrypt(sk.encrypt('x', K_LAUNCHER)), 'x');
    assert.strictEqual(sk.decrypt(k.encrypt('y'), K_LAUNCHER), 'y');
    assert.strictEqual(sk.open(dir, { platform: 'darwin', ways }), null, 'Windows only');
    assert.strictEqual(sk.open(dir, { platform: 'win32', ways: [['none', () => null]] }), null, 'Windows says no: nothing');
    assert.strictEqual(sk.open(dir, { platform: 'win32', ways: [['short', () => Buffer.alloc(16)]] }), null, 'a key of the wrong size: nothing');
    fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('NOPE' + 'x'.repeat(40)).toString('base64') } }));
    assert.strictEqual(sk.open(dir, { platform: 'win32', ways }), null, 'a key file in another form: nothing');
    fs.writeFileSync(path.join(dir, 'Local State'), '{ not json');
    assert.strictEqual(sk.open(dir, { platform: 'win32', ways }), null, 'a damaged key file: nothing');
    assert.strictEqual(sk.open(dir), process.platform === 'win32' ? sk.open(dir) : null);
  }

  // ---------- one sign-in for both (Couch TV has the launcher's key)
  {
    const dir = path.join(TMP, 'a'); fs.mkdirSync(dir);
    const L = launcherStore(dir);
    assert.strictEqual(L.status().signedIn, false);
    await L.login('j@example.com', 'pw');
    assert.strictEqual(L.status().signedIn, true);
    const T = tvStore(dir, true);
    assert.strictEqual(T.status().signedIn, true, 'Couch TV reads the launcher’s sign-in');
    assert.strictEqual(T.status().email, 'j@example.com');
    // Couch TV signs out: the launcher is signed out too (it is one sign-in).
    await tick(); await T.logout();
    assert.strictEqual(T.status().signedIn, false);
    assert.strictEqual(L.status().signedIn, false, 'the launcher sees the sign-out');
    // Couch TV signs in: the launcher can read it (saved in the launcher's own form).
    await tick(); await T.login('k@example.com', 'pw');
    const d = read(dir);
    assert.ok(d.auth && d.auth.enc && !d.authTv, 'saved in the launcher’s place: ' + JSON.stringify(Object.keys(d)));
    assert.strictEqual(sk.decrypt(Buffer.from(d.auth.enc, 'base64'), K_LAUNCHER), 'KEY-k@example.com');
    assert.strictEqual(L.status().signedIn, true, 'the launcher reads what Couch TV saved');
    const L2 = launcherStore(dir); // (and a launcher started later)
    assert.strictEqual(L2.status().signedIn, true);
  }

  // ---------- no key (Mac, or it couldn't be had): Couch TV keeps its own, the launcher's is left alone
  {
    const dir = path.join(TMP, 'b'); fs.mkdirSync(dir);
    const L = launcherStore(dir);
    await L.login('j@example.com', 'pw');
    const before = read(dir).auth.enc;
    const T = tvStore(dir, false);
    assert.strictEqual(T.status().signedIn, false, 'cannot read the launcher’s: signed out here');
    await tick(); await T.login('j@example.com', 'pw');
    assert.strictEqual(T.status().signedIn, true);
    let d = read(dir);
    assert.strictEqual(d.auth.enc, before, 'the launcher’s sign-in is untouched');
    assert.ok(d.authTv && d.authTv.enc, 'Couch TV’s own is beside it');
    assert.strictEqual(L.status().signedIn, true, 'the launcher is still signed in');
    await tick(); L.setWatched('tt1:1:1', true); L.flush(); await tick();
    d = read(dir);
    assert.ok(d.authTv && d.authTv.enc, 'the launcher saving keeps Couch TV’s sign-in in the file');
    assert.strictEqual(T.status().signedIn, true);
    await tick(); await T.logout();
    d = read(dir);
    assert.strictEqual(d.auth.enc, before, 'signing out of Couch TV leaves the launcher’s');
    assert.ok(!d.authTv);
    // A launcher that keeps the sign-in as plain text (no encryption on that PC): readable by both.
    const dir2 = path.join(TMP, 'b2'); fs.mkdirSync(dir2);
    fs.writeFileSync(path.join(dir2, 'tv.json'), JSON.stringify({ auth: { plain: 'P' }, user: { email: 'p@example.com' } }));
    assert.strictEqual(tvStore(dir2, false).status().signedIn, true);
  }

  // ---------- what one saves, the other sees; neither wipes the other
  {
    const dir = path.join(TMP, 'c'); fs.mkdirSync(dir);
    const L = launcherStore(dir), T = tvStore(dir, true);
    L.setWatched('a', true); L.flush(); await tick();
    assert.deepStrictEqual(T.watched(['a', 'b']), { a: true }, 'Couch TV sees what the launcher saved');
    T.setWatched('b', true); T.flush(); await tick();
    assert.deepStrictEqual(L.watched(['a', 'b']), { a: true, b: true }, 'and the other way round');
    // The launcher sat with an old copy while Couch TV saved a lot; then the launcher changes one thing.
    for (let i = 0; i < 5; i++) { T.setWatched('t' + i, true); }
    T.rememberStream('tt9', 'tt9:1:2', { url: 'https://x/y.mkv' });
    T.flush(); await tick();
    L.setWatched('late', true); L.flush(); await tick();
    const d = read(dir);
    for (const k of ['a', 'b', 't0', 't4', 'late']) assert.ok(d.watched[k], 'kept ' + k);
    assert.ok(d.last.tt9, 'kept the last stream');
    assert.deepStrictEqual(T.lastStream('tt9', 'tt9:1:2'), { url: 'https://x/y.mkv' });
    assert.ok(T.watched(['late']).late);
    // Both change something before either has saved (within the same half second).
    L.setWatched('L-only', true); T.setWatched('T-only', true);
    await sleep(700); await tick();
    const d2 = read(dir);
    assert.ok(d2.watched['L-only'] && d2.watched['T-only'], 'both changes survive: ' + Object.keys(d2.watched).join(','));
    // Un-watching in one is seen by the other.
    T.setWatched('a', false); T.flush(); await tick();
    assert.deepStrictEqual(L.watched(['a']), {});
    // The sign-in changed in one while the other has a small change waiting: the sign-in stays.
    await T.login('z@example.com', 'pw'); await tick();
    L.setWatched('w2', true); // (the launcher hasn't looked since: its copy has no sign-in)
    await sleep(700);
    const d3 = read(dir);
    assert.strictEqual(sk.decrypt(Buffer.from(d3.auth.enc, 'base64'), K_LAUNCHER), 'KEY-z@example.com', 'a waiting small change never puts back an old sign-in');
    assert.ok(d3.watched.w2);
    assert.strictEqual(d3.user.email, 'z@example.com');
    // A damaged file is not taken for news.
    fs.writeFileSync(path.join(dir, 'tv.json'), '{ half a fi'); await tick();
    assert.ok(L.watched(['w2']).w2, 'a damaged file changes nothing here');
    L.setWatched('w3', true); L.flush();
    assert.ok(read(dir).watched.w3 && read(dir).watched.w2, 'and the next save repairs it');
  }

  // ---------- Cable TV's file
  {
    const file = path.join(TMP, 'cable.json');
    const tvFake = { search: async () => [], meta: async () => null };
    const A = createCable({ tv: tvFake, file }), B = createCable({ tv: tvFake, file });
    const e0 = A.eras();
    assert.ok(Array.isArray(e0) && e0.length, 'eras listed');
    const pick = e0[0].id, pick2 = e0[1].id;
    A.setEras([pick]); A.flush(); await tick();
    assert.deepStrictEqual(B.eras().filter((e) => e.current).map((e) => e.id), [pick], 'the other sees the picked era');
    B.setEras([pick, pick2]); B.flush(); await tick();
    assert.deepStrictEqual(A.eras().filter((e) => e.current).map((e) => e.id).sort(), [pick, pick2].sort(), 'and the other way round');
  }

  // ---------- small parts of Couch TV's app core
  {
    const d = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }, { workArea: { x: 1920, y: 0, width: 1280, height: 984 } }];
    assert.ok(util.onScreen({ x: 100, y: 100, width: 1280, height: 760 }, d));
    assert.ok(util.onScreen({ x: 2000, y: 50, width: 1000, height: 700 }, d), 'on the second screen');
    assert.ok(!util.onScreen({ x: 4000, y: 100, width: 1280, height: 760 }, d), 'on a screen that is gone');
    assert.ok(!util.onScreen({ x: 100, y: -400, width: 1280, height: 760 }, d), 'title bar above the screen');
    assert.ok(!util.onScreen({ x: 100, y: 100, width: 50, height: 50 }, d), 'too small');
    assert.ok(!util.onScreen({ x: 'a', y: 1, width: 900, height: 600 }, d) && !util.onScreen(null, d) && !util.onScreen({}, d));
    assert.deepStrictEqual(util.pickOwn({ tvMode: 'light', theme: 'frosted', games: 1, tvQuality: '4K', displayId: 7 }), { tvMode: 'light', tvQuality: '4K' });
    assert.deepStrictEqual(util.pickOwn(null), {});
  }
  // ---------- which commercial is opened first (in a hurry: a good one already known)
  {
    const { adOrder } = require(path.join(ROOT, 'src', 'tvmain.js'));
    const known = { w1: { w: 1920, h: 1080 }, w2: { w: 1280, h: 720 }, b1: { w: 640, h: 480 }, b2: { w: 480, h: 360 } };
    const info = (v) => known[v.id];
    const ids = (l) => l.map((v) => v.id).join(' ');
    const pool = ['f1', 'b2', 'f2', 'w1', 'f3', 'b1', 'f4', 'w2'].map((id) => ({ id }));
    assert.strictEqual(ids(adOrder(pool, info, false)), 'f1 f2 f3 w1 w2 b1 b2 f4', 'with time: a few not opened yet, then the good, then the best of the rest');
    assert.strictEqual(ids(adOrder(pool, info, true)).split(' ')[0], 'w1', 'in a hurry: a known good one first');
    assert.strictEqual(ids(adOrder(pool, info, true)), 'w1 f1 f2 f3 w2 b1 b2 f4', 'nothing listed twice');
    assert.strictEqual(ids(adOrder(pool.filter((v) => v.id[0] !== 'w'), info, true)), 'f1 f2 f3 b1 b2 f4', 'in a hurry with no good one known: as before');
    const many = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id })), allGood = () => ({ w: 1920, h: 1080 });
    assert.strictEqual(ids(adOrder(many, allGood, false)), 'a b c d e');
    assert.strictEqual(ids(adOrder([], info, true)), '');
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('shared data ok');
})().catch((e) => { console.error(e); process.exit(1); });
