// Run before every publish: the update fail-safe. An update that loads but never shows its first
// screen is given two starts; the third start runs the built-in app instead. One that did show
// its screen is never dropped.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const start = (dir, started) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'smoke-test.js')], { env: Object.assign({}, process.env, { COUCH_SMOKE_DIR: dir, COUCH_SMOKE_STARTED: started ? '1' : '' }), timeout: 60000 }).toString().trim().split('\n').pop());
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'couch-failsafe-'));
// 1) never shows its screen
let dir = mk();
for (const n of [1, 2]) { const r = start(dir, false); assert.ok(!r.fellBack && !r.problems.length, 'start ' + n + ' runs the update: ' + JSON.stringify(r)); }
let r = start(dir, false);
assert.ok(r.fellBack && /first screen/.test(r.why), 'third start falls back to the built-in app: ' + JSON.stringify(r));
assert.ok(!fs.existsSync(path.join(dir, 'userData', 'update')) && fs.readdirSync(path.join(dir, 'userData')).some((f) => f.startsWith('update-failed-')), 'the update is set aside');
r = start(dir, false); assert.ok(r.fellBack === false || r.fellBack === true, 'and it keeps starting');
assert.ok(!fs.existsSync(path.join(dir, 'userData', 'update')), 'built-in from now on');
fs.rmSync(dir, { recursive: true, force: true });
// 2) shows its screen on the first start: never dropped, however often it starts
dir = mk();
r = start(dir, true); assert.ok(!r.fellBack);
for (let n = 0; n < 4; n++) { r = start(dir, false); assert.ok(!r.fellBack && fs.existsSync(path.join(dir, 'userData', 'update', 'src', 'main.js')), 'healthy update kept, start ' + (n + 2)); }
// 3) one bad start, then a good one: the count starts over
dir = mk();
start(dir, false); r = start(dir, true); assert.ok(!r.fellBack);
for (let n = 0; n < 3; n++) assert.ok(!start(dir, false).fellBack);
// 4) a damaged health file changes nothing
fs.writeFileSync(path.join(dir, 'userData', 'update-health.json'), '{not json');
assert.ok(!start(dir, false).fellBack && !start(dir, false).fellBack);
assert.ok(start(dir, false).fellBack, 'counted from scratch after the damaged file');
fs.rmSync(dir, { recursive: true, force: true });
console.log('update fail-safe ok');
