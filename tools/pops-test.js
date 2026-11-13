// The pop-ups layer with pretend windows: what is shown when, and that it never asks for focus.
const assert = require('assert'), EventEmitter = require('events');
const { createPops } = require('../src/pops.js');
const made = [];
class BW extends EventEmitter {
  constructor(o) { super(); this.o = o; this.visible = false; this.sent = []; this.calls = []; made.push(this);
    this.webContents = Object.assign(new EventEmitter(), { send: (ch, v) => this.sent.push(JSON.parse(JSON.stringify(v))), setWindowOpenHandler() {} });
    this.loadMs = BW.loadMs; }
  loadFile(f, q) { this.file = f; this.query = q.query; setTimeout(() => this.webContents.emit('did-finish-load'), this.loadMs); }
  setIgnoreMouseEvents(v) { this.clickThrough = v; } setAlwaysOnTop(v, lvl) { this.top = lvl; } setVisibleOnAllWorkspaces() {}
  setBounds(b) { this.bounds = b; } isVisible() { return this.visible; } isDestroyed() { return !!this.dead; }
  showInactive() { this.visible = true; this.calls.push('showInactive'); } show() { this.calls.push('SHOW'); this.visible = true; } focus() { this.calls.push('FOCUS'); }
  hide() { this.visible = false; this.calls.push('hide'); } moveTop() {} destroy() { this.dead = true; this.emit('closed'); }
}
BW.loadMs = 30;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let disp = { bounds: { x: 1920, y: 0, width: 1920, height: 1080 } }, soundOn = true;
  const pops = createPops({ BrowserWindow: BW, file: '/x/pops.html', preload: '/x/preload.js', display: () => disp, mac: false, sound: () => soundOn });
  assert.strictEqual(made.length, 0, 'no window until something is shown');
  // a notification
  assert.ok(pops.toast({ title: 'Ana is online', body: 'Say hi' }));
  const tw = made[0];
  assert.ok(tw.o.focusable === false && tw.o.transparent && tw.o.skipTaskbar && tw.clickThrough === true && tw.top === 'screen-saver', 'cannot be clicked or focused, on top');
  assert.deepStrictEqual(tw.query, { mode: 'toasts' });
  assert.deepStrictEqual(tw.o.x + tw.o.width, 1920 + 1920, 'at the right edge of the chosen display'); assert.strictEqual(tw.o.y, 0);
  assert.ok(tw.o.width === 600 && tw.visible && tw.sent.length === 0, 'shown; nothing sent before the page loaded');
  await wait(80);
  assert.deepStrictEqual(tw.sent[tw.sent.length - 1].toasts.map((t) => [t.title, t.body, t.sound]), [['Ana is online', 'Say hi', true]], 'sent once loaded, with its sound');
  // the same one again shows once; another stacks under it; the sound only plays for the new one
  assert.strictEqual(pops.toast({ title: 'Ana is online', body: 'Say hi' }), false);
  soundOn = false;
  pops.toast({ title: 'Bo joined Squad', body: 'Discord', from: 'Discord', icon: 'https://cdn.discordapp.com/avatars/2/a.png' });
  let last = tw.sent[tw.sent.length - 1].toasts;
  assert.deepStrictEqual(last.map((t) => [t.title, t.sound, t.icon, t.from]), [['Ana is online', false, null, ''], ['Bo joined Squad', false, 'https://cdn.discordapp.com/avatars/2/a.png', 'Discord']]);
  // pictures only from Discord; empty ones ignored; long text trimmed
  pops.toast({ title: 'x', icon: 'https://evil.example/a.png' }); assert.strictEqual(tw.sent[tw.sent.length - 1].toasts[2].icon, null);
  assert.strictEqual(pops.toast({ title: '  ', body: '' }), false);
  pops.toast({ title: 'T'.repeat(300), body: 'B'.repeat(900) });
  last = tw.sent[tw.sent.length - 1].toasts; assert.ok(last[3].title.length === 90 && last[3].body.length === 240);
  // more than four wait their turn
  pops.toast({ title: 'fifth' }); pops.toast({ title: 'sixth' });
  assert.strictEqual(tw.sent[tw.sent.length - 1].toasts.length, 4); assert.strictEqual(pops.state.waiting, 2);
  assert.ok(!tw.calls.includes('SHOW') && !tw.calls.includes('FOCUS'), 'never show() or focus(): ' + tw.calls);
  // they go away by themselves, the waiting ones come up, then the window hides
  await wait(6700);
  last = tw.sent[tw.sent.length - 1].toasts.map((t) => t.title);
  assert.ok(last.includes('fifth') && last.includes('sixth') && !last.includes('Ana is online'), 'next ones up: ' + last);
  assert.ok(tw.visible);
  await wait(9600);
  assert.deepStrictEqual(tw.sent[tw.sent.length - 1].toasts, [], 'all gone');
  assert.ok(!tw.visible && tw.calls[tw.calls.length - 1] === 'hide', 'window hidden when empty');
  // a new one after that shows the same window again, on the display chosen now
  disp = { bounds: { x: 0, y: 0, width: 2560, height: 1440 } };
  pops.toast({ title: 'again' });
  assert.ok(tw.visible && made.length === 1 && tw.bounds.width === 800 && tw.bounds.x === 2560 - 800, JSON.stringify(tw.bounds));
  assert.deepStrictEqual(tw.sent[tw.sent.length - 1].toasts.map((t) => t.title), ['again']);

  // the Discord call
  const P = (id, name, x) => Object.assign({ id, name, pic: 'https://cdn.discordapp.com/avatars/' + id + '/a.png', muted: false, deaf: false, speaking: false }, x || {});
  pops.voice({ id: '77', name: 'Squad', people: [P('1', 'Me'), P('2', 'Ana', { speaking: true }), P('3', 'Bo', { muted: true, pic: 'javascript:alert(1)' })] }, false);
  const vw = made[1];
  assert.ok(vw.o.focusable === false && vw.clickThrough && vw.o.x === 0 && vw.o.y === 0 && vw.query.mode === 'voice' && vw.visible);
  await wait(80);
  let v = vw.sent[vw.sent.length - 1].voice;
  assert.ok(v.people.length === 3 && v.people[1].speaking && v.people[2].muted && v.people[2].pic === null && v.more === 0, JSON.stringify(v));
  pops.voice({ id: '77', name: 'Squad', people: [P('1', 'Me'), P('2', 'Ana', { speaking: true })] }, true);
  v = vw.sent[vw.sent.length - 1].voice; assert.deepStrictEqual(v.people.map((p) => p.name), ['Ana'], 'only who is talking');
  pops.voice({ id: '77', name: 'Big', people: Array.from({ length: 11 }, (_, i) => P(String(i + 1), 'P' + i)) }, false);
  v = vw.sent[vw.sent.length - 1].voice; assert.ok(v.people.length === 8 && v.more === 3);
  pops.voice(null);
  assert.ok(!vw.visible && vw.sent[vw.sent.length - 1].voice === null, 'call ended: gone');
  assert.ok(!vw.calls.includes('SHOW') && !vw.calls.includes('FOCUS'));
  // the display changes
  disp = { bounds: { x: 0, y: 0, width: 1280, height: 720 } }; pops.place();
  assert.ok(tw.bounds.width === 400 && tw.bounds.x === 880 && vw.bounds.x === 0);
  // a window that got closed is made again
  tw.destroy(); pops.toast({ title: 'after close' }); assert.ok(made.length === 3 && made[2].visible);
  // the Discord call's spot: where its window sits, and what the page is told
  let spot = 'bottom-right';
  const sp = createPops({ BrowserWindow: BW, file: '/x/pops.html', preload: '/x/preload.js', display: () => ({ bounds: { x: 0, y: 0, width: 1600, height: 900 } }), mac: false, callSpot: () => spot });
  sp.voice({ id: '5', name: 'Sq', people: [P('1', 'Me')] }, false);
  await wait(60); // the page loads
  const sv = made[made.length - 1], bw = sv.bounds, bh = sv.bounds.height;
  assert.ok(bw.x === 1600 - bw.width && bw.y === 900 - bh && sv.sent[sv.sent.length - 1].spot === 'bottom-right', 'bottom right: ' + JSON.stringify(bw));
  spot = 'middle-left'; sp.place();
  assert.ok(sv.bounds.x === 0 && sv.bounds.y === Math.round((900 - bh) / 2) && sv.sent[sv.sent.length - 1].spot === 'middle-left', 'middle left: ' + JSON.stringify(sv.bounds));
  spot = 'bottom-left'; sp.place();
  assert.ok(sv.bounds.x === 0 && sv.bounds.y === 900 - bh, 'bottom left');
  spot = 'nonsense'; sp.place();
  assert.ok(sv.bounds.x === 0 && sv.bounds.y === 0 && sv.sent[sv.sent.length - 1].spot === 'top-left', 'unknown spot falls back to top left');
  sp.close();
  // closing: no more windows
  pops.close(); assert.ok(made[2].dead && vw.dead); assert.strictEqual(pops.toast({ title: 'late' }), false); pops.voice({ name: 'x', people: [] }); assert.strictEqual(made.length, 4);
  console.log('pops ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
