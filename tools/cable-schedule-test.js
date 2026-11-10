// Cable TV's schedule against awkward data and the days the clocks change (run with TZ=America/New_York).
const assert = require('assert');
const C = require('../src/cable.js');
let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const check = (list, ds, what) => {
  const end = C.dayStart(ds + 36 * 3600e3);
  assert.ok(list.length > 0 && list.length < 3000, what + ': has programs');
  assert.strictEqual(list[0].start, ds, what + ': starts with the day');
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    assert.ok(p.end > p.start && p.video && p.showId, what + ': a real program');
    if (i) assert.strictEqual(p.start, list[i - 1].end, what + ': no gap or overlap at ' + i);
  }
  assert.strictEqual(list[list.length - 1].end, end, what + ': runs to the next day’s start (' + (end - ds) / 3600e3 + ' h)');
};
const t0 = Date.now();
// the clocks going back (25 h day), forward (23 h day), and ordinary days
const days = [new Date(2026, 9, 31, 12), new Date(2026, 10, 1, 12), new Date(2027, 2, 13, 12), new Date(2027, 2, 14, 12), new Date(2026, 10, 10, 12), new Date(2027, 11, 31, 23, 59)];
const lens = new Set();
for (const d of days) {
  const ds = C.dayStart(d.getTime());
  assert.strictEqual(new Date(ds).getHours(), 6);
  for (const ads of [false, true]) {
    const shows = ['a', 'b', 'c'].map((id) => ({ id, runtimeMin: 22, episodes: Array.from({ length: 20 }, (_, j) => ({ id: id + j })) }));
    check(C.daySchedule('nick', shows, ds, ads), ds, d.toDateString() + (ads ? ' ads' : ''));
  }
  lens.add((C.dayStart(ds + 36 * 3600e3) - ds) / 3600e3);
}
assert.ok(lens.has(25) && lens.has(23) && lens.has(24), 'covered 23, 24 and 25 hour days: ' + [...lens]);
// awkward shows: one episode, odd runtimes, junk
const junk = [0, -5, -500, NaN, null, undefined, 'abc', Infinity, 1e9, 0.0001, 3, 180, '22'];
for (let n = 0; n < 400; n++) {
  const k = 1 + Math.floor(rnd() * 5);
  const shows = Array.from({ length: k }, (_, i) => ({ id: 's' + i, runtimeMin: junk[Math.floor(rnd() * junk.length)], episodes: Array.from({ length: 1 + Math.floor(rnd() * 4) }, (_, j) => ({ id: 's' + i + 'e' + j })) }));
  const ds = C.dayStart(new Date(2026, Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 28), 12).getTime());
  const ads = rnd() < 0.5;
  check(C.daySchedule('ch' + n, shows, ds, ads), ds, 'junk ' + n + ' ' + JSON.stringify(shows.map((s) => String(s.runtimeMin))));
  // every part of every slot can be found, and the parts add up to the slot
  const list = C.daySchedule('ch' + n, shows, ds, ads);
  for (const p of list.slice(0, 6)) {
    const slot = (p.end - p.start) / 1000, ep = [0, 1, 600, 1320, slot - 1, slot, slot + 500][Math.floor(rnd() * 7)];
    const plan = C.breakPlan(slot, ep, ads);
    const total = plan.reduce((a, x) => a + (x.kind === 'show' ? x.to - x.from : x.len), 0);
    assert.ok(Math.abs(total - Math.round(slot)) <= 1, 'parts add up: ' + total + ' vs ' + slot + ' ' + JSON.stringify(plan));
    assert.ok(plan.every((x) => (x.kind === 'show' ? x.to > x.from : x.len > 0)), 'no empty parts: ' + JSON.stringify(plan));
    for (const off of [0, 0.5, slot / 2, slot - 0.01, slot, slot + 100, -5]) { const l = C.locate(plan, off); assert.ok(l && l.part && l.left >= 0 && l.into >= 0, 'found at ' + off); }
  }
}
// shows with nothing usable in them never stall it
assert.deepStrictEqual(C.daySchedule('x', [{ id: 'a', episodes: [] }, null, { id: 'b' }], C.dayStart(Date.now())), []);
const mixed = C.daySchedule('x', [{ id: 'a', runtimeMin: 22, episodes: [null, undefined] }, { id: 'b', runtimeMin: 22, episodes: [{ id: 'b1' }] }], C.dayStart(Date.now()));
assert.ok(mixed.length > 0 && mixed.every((p) => p.video && p.showId === 'b'), 'only the usable show is on');
assert.ok(C.daySchedule('x', [{ id: 'a', runtimeMin: 22, episodes: [null] }], C.dayStart(Date.now())).length === 0, 'nothing usable: empty, not stuck');
assert.ok(Date.now() - t0 < 20000, 'quick: ' + (Date.now() - t0) + ' ms');
console.log('cable schedule fuzz ok (' + (Date.now() - t0) + ' ms)');
