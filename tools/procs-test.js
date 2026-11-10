// Run before every publish: following a game's programs without starting PowerShell each time.
// A pretend Windows (programs that start and stop, some the launcher can't look into) and a
// pretend PowerShell that knows the truth. Whatever happens, the tracker's answer must be the
// truth or "can't tell" (never a wrong list, never "nothing there" while the game runs), and
// PowerShell must be asked only rarely.
'use strict';
const assert = require('assert');
const { createProcs, createTracker, parseEntry, LAYOUT } = require('../src/procs.js');
const DIR = 'C:\\Games\\GTA V';

function world() {
  const w = { t: 0, procs: new Map(), next: 100, slowCalls: 0, slowFails: false, listBroken: false, mismatch: [] };
  w.add = (name, file, readable, ppid) => { const pid = w.next += 4; w.procs.set(pid, { pid, ppid: ppid || 4, name, file, readable: readable !== false }); return pid; };
  w.kill = (pid) => w.procs.delete(pid);
  w.truth = () => Array.from(w.procs.values()).filter((p) => p.file.toLowerCase().startsWith(DIR.toLowerCase() + '\\') && !/crash|bugreport|errorreport|crashpad|werfault/i.test(p.name)).map((p) => p.pid).sort();
  w.self = w.add('Couch Launcher.exe', 'C:\\Apps\\Couch Launcher\\Couch Launcher.exe');
  w.add('System', '', false); w.add('csrss.exe', 'C:\\Windows\\System32\\csrss.exe', false); w.add('explorer.exe', 'C:\\Windows\\explorer.exe'); w.add('steam.exe', 'C:\\Steam\\steam.exe');
  w.api = { list: () => { if (w.listBroken) throw new Error('x'); return Array.from(w.procs.values()).map((p) => ({ pid: p.pid, ppid: p.ppid, name: p.name })); },
    pathOf: (pid) => { const p = w.procs.get(pid); w.pathCalls = (w.pathCalls || 0) + 1; return p && p.readable ? p.file : null; } };
  w.procsApi = createProcs({ api: w.api, self: w.self, exe: 'C:\\Apps\\Couch Launcher\\Couch Launcher.exe' });
  w.slow = async () => { w.slowCalls++; return w.slowFails ? null : w.truth(); };
  w.tracker = createTracker(w.procsApi, DIR, w.slow, { now: () => w.t, onMismatch: (d) => w.mismatch.push(d) });
  w.ask = async (dt) => { w.t += dt == null ? 1500 : dt; const r = await w.tracker.pids(); if (r !== null) assert.deepStrictEqual(r.slice().sort(), w.truth(), 'the answer is the truth at ' + w.t); else w.nulls = (w.nulls || 0) + 1; return r; };
  return w;
}

(async () => {
  // the entry Windows hands back, read by hand
  const b = Buffer.alloc(LAYOUT.size); b.writeUInt32LE(LAYOUT.size, 0); b.writeUInt32LE(4321, LAYOUT.pid); b.writeUInt32LE(77, LAYOUT.ppid); b.write('GTA5.exe', LAYOUT.name, 'utf16le');
  assert.deepStrictEqual(parseEntry(b), { pid: 4321, ppid: 77, name: 'GTA5.exe' });
  const full = Buffer.alloc(LAYOUT.size, 0x41); full.writeUInt32LE(1, LAYOUT.pid); assert.strictEqual(parseEntry(full).name.length, 260, 'a name filling the whole field');
  assert.strictEqual(LAYOUT.size, process.arch === 'ia32' ? 556 : 568);

  // 1) a game being played: PowerShell at the start and once a minute, not every tick
  let w = world();
  assert.ok(w.procsApi.ok(), 'the list is believed (the launcher finds itself in it)');
  assert.deepStrictEqual(await w.ask(), [], 'nothing there yet (PowerShell asked first, so the start is its word)');
  assert.strictEqual(w.slowCalls, 1);
  const calls0 = w.slowCalls;
  for (let i = 0; i < 20; i++) assert.deepStrictEqual(await w.ask(3000), []);
  assert.ok(w.slowCalls - calls0 <= 1, 'waiting for the game with nothing changing: no PowerShell (' + (w.slowCalls - calls0) + ')');
  const boot = w.add('PlayGTAV.exe', DIR + '\\PlayGTAV.exe'); assert.deepStrictEqual(await w.ask(3000), [boot], 'the game appears: seen at once');
  const game = w.add('GTA5.exe', DIR + '\\GTA5.exe', true, boot); w.add('CrashReporter.exe', DIR + '\\CrashReporter.exe'); w.kill(boot);
  assert.deepStrictEqual(await w.ask(), [game], 'bootstrapper gone, game there, crash reporter not counted');
  let c = w.slowCalls;
  for (let i = 0; i < 400; i++) { if (i % 7 === 0) { const x = w.add('chrome.exe', 'C:\\Chrome\\chrome.exe'); if (i % 14 === 0) w.kill(x); } assert.deepStrictEqual(await w.ask(), [game]); }
  assert.ok(w.slowCalls - c <= 11, 'ten minutes of play, other programs coming and going: PowerShell ' + (w.slowCalls - c) + ' times instead of 400');
  // the game closes: said only once PowerShell agrees, then repeated without asking again
  w.kill(game); c = w.slowCalls;
  assert.deepStrictEqual(await w.ask(), []); assert.deepStrictEqual(await w.ask(), []); assert.strictEqual(w.slowCalls - c, 1, 'one confirmation at the end');

  // 2) an anti-cheat game the launcher can't look into: PowerShell names it once, then it is followed by the list
  w = world(); await w.ask(); await w.ask(3000);
  const ac = w.add('FortniteClient-Win64-Shipping.exe', DIR + '\\FortniteClient-Win64-Shipping.exe', false);
  assert.deepStrictEqual(await w.ask(3000), [ac], 'found through PowerShell');
  c = w.slowCalls; for (let i = 0; i < 30; i++) assert.deepStrictEqual(await w.ask(), [ac]);
  assert.ok(w.slowCalls - c <= 1, 'then no more asking: ' + (w.slowCalls - c));
  const svc = w.add('EasyAntiCheat.exe', 'C:\\Program Files\\EAC\\EasyAntiCheat.exe', false); c = w.slowCalls;
  assert.deepStrictEqual(await w.ask(3000), [ac]); assert.strictEqual(w.slowCalls - c, 1, 'a new program that can’t be looked into: asked once');
  w.kill(ac); assert.deepStrictEqual(await w.ask(3000), [], 'its end is seen');

  // 3) PowerShell not answering: never "nothing there" on a guess
  w = world(); w.slowFails = true;
  for (let i = 0; i < 5; i++) assert.strictEqual(await w.ask(3000), null, 'can’t tell');
  const g3 = w.add('game.exe', DIR + '\\bin\\game.exe');
  assert.strictEqual(await w.ask(3000), null, 'still can’t tell (as before, when PowerShell failed)');
  w.slowFails = false; assert.deepStrictEqual(await w.ask(3000), [g3]);
  w.slowFails = true; for (let i = 0; i < 4; i++) assert.deepStrictEqual(await w.ask(3000), [g3], 'known and unchanged: reported without PowerShell');
  w.t += 61000; assert.deepStrictEqual(await w.tracker.pids(), [g3], 'a missed double-check changes nothing');
  w.kill(g3); assert.strictEqual(await w.ask(3000), null, 'its end isn’t claimed without confirmation');
  w.slowFails = false; assert.deepStrictEqual(await w.ask(3000), [], 'confirmed once PowerShell answers again');

  // 4) the list stops working, or was never believable: the old way, every time
  w = world(); await w.ask(); const g4 = w.add('game.exe', DIR + '\\game.exe'); assert.deepStrictEqual(await w.ask(3000), [g4]);
  w.listBroken = true; c = w.slowCalls; for (let i = 0; i < 5; i++) assert.deepStrictEqual(await w.ask(), [g4]); assert.strictEqual(w.slowCalls - c, 5, 'old way each time');
  w.listBroken = false; await w.ask(); assert.strictEqual(w.slowCalls - c, 6, 'and it stays with the old way');
  const bad = createProcs({ api: { list: () => [{ pid: 1, ppid: 0, name: 'x.exe' }], pathOf: () => 'C:\\x.exe' }, self: 999, exe: 'C:\\a\\Couch Launcher.exe' });
  assert.strictEqual(bad.ok(), false, 'a list without the launcher in it is not believed');
  let n = 0; const tb = createTracker(bad, DIR, async () => { n++; return [5]; }); assert.deepStrictEqual(await tb.pids(), [5]); assert.deepStrictEqual(await tb.pids(), [5]); assert.strictEqual(n, 2);
  assert.strictEqual(createProcs({ api: { list: () => { throw new Error('no'); }, pathOf: () => null }, self: 1, exe: 'x' }).ok(), false);
  let m = 0; const tn = createTracker(null, DIR, async () => { m++; return null; }); assert.strictEqual(await tn.pids(), null); assert.strictEqual(m, 1, 'no list at all (not Windows): the old way');

  // 5) the two disagree (the list says in the folder, PowerShell says not): PowerShell wins, and it is written down
  w = world(); await w.ask(); const odd = w.add('helper.exe', DIR + '\\helper.exe');
  const realTruth = w.truth; w.truth = () => realTruth().filter((p) => p !== odd);
  w.t += 61000; const r5 = await w.tracker.pids();
  assert.ok(r5 === null || !r5.includes(odd)); await w.ask(3000);
  assert.ok(w.mismatch.length >= 1 && /helper\.exe in->out/.test(w.mismatch[0]), 'difference noted: ' + w.mismatch);

  // 6) family: a game started by a launcher exe
  w = world(); const a = w.add('launcher.exe', 'C:\\g\\launcher.exe'); const k1 = w.add('game.exe', 'C:\\g\\game.exe', true, a); const k2 = w.add('render.exe', 'C:\\g\\r.exe', false, k1); w.add('other.exe', 'C:\\o.exe');
  w.procs.get(w.self).ppid = k2; // (the launcher itself is never part of a family)
  assert.deepStrictEqual(w.procsApi.family([a]).sort(), [a, k1, k2].sort());
  assert.deepStrictEqual(w.procsApi.family([k2, 0, null]), [k2]);
  assert.ok(/^"Couch Launcher\.exe"\r\n"System"/.test(w.procsApi.asTasklist()), 'names the way tasklist lists them');

  // 7) storm: programs of every kind starting and stopping at random, PowerShell failing now and then
  let seed = 5; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let ticks = 0, slows = 0, wrongEmpty = 0;
  for (let run = 0; run < 60; run++) {
    w = world(); const mine = [];
    for (let i = 0; i < 120; i++) {
      const k = Math.floor(rnd() * 10);
      if (k < 2) mine.push(w.add(['game.exe', 'GTA5.exe', 'CrashHandler.exe', 'sub.exe'][Math.floor(rnd() * 4)], DIR + '\\' + (rnd() < 0.5 ? 'bin\\' : '') + 'x' + i + '.exe', rnd() < 0.6));
      else if (k < 4 && mine.length) w.kill(mine.splice(Math.floor(rnd() * mine.length), 1)[0]);
      else if (k < 6) w.add('bg' + i + '.exe', 'C:\\Other\\bg.exe', rnd() < 0.7);
      else if (k === 6) w.add('near.exe', DIR + ' Online\\near.exe'); // a folder whose name only starts the same
      w.slowFails = rnd() < 0.15;
      const r = await w.ask([1500, 3000, 500, 7000, 61000][Math.floor(rnd() * 5)]);
      if (r && !r.length && w.truth().length) wrongEmpty++;
      ticks++;
    }
    slows += w.slowCalls;
  }
  assert.strictEqual(wrongEmpty, 0);
  console.log('procs ok (storm: ' + ticks + ' checks, PowerShell asked ' + slows + ' times even with everything changing constantly)');
})().catch((e) => { console.error(e); process.exit(1); });
