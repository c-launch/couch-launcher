// Reads what Couch TV's build check found (src/couchtv/selftest.js) and says whether it is right.
'use strict';
const r = require(require('path').resolve(process.argv[2]));
const show = Object.assign({}, r); delete show.console;
console.log(JSON.stringify(show, null, 1));
for (const c of (r.console || []).filter((x) => x[0] >= 2).slice(0, 20)) console.log('screen said:', JSON.stringify(c));
const bad = [];
const want = (ok, what) => { if (!ok) bad.push(what); };
const s = r.screen || {}, z = r.resized || {};
want(r.done === true, 'the check did not finish');
want(r.shown === true, 'the window is not a normal, visible, resizable window');
want(r.title === 'Couch TV', 'the title is ' + r.title);
want(/Couch TV$/.test(String(r.userData || '')), 'its settings folder is ' + r.userData);
want(s.stage === 'running' && s.tvapp === true && s.layer === true, 'the TV screens did not come up (' + s.stage + ')');
want(s.topbar === 'none', 'the launcher’s dock is showing');
want(Array.isArray(s.nav) && Array.isArray(s.gear) && s.sw <= s.w, 'the page does not fit its window');
want(Array.isArray(z.size) && Math.abs(z.size[0] - 900) <= 2 && Math.abs(z.size[1] - 600) <= 2, 'it could not be resized to 900 × 600: ' + JSON.stringify(z.size));
want(Array.isArray(z.nav) && Array.isArray(z.gear) && z.sw <= z.w && z.gear[0] >= z.nav[2] - 2 && z.nav[0] >= 0, 'at 900 × 600 the top of the page does not fit');
want(r.fullscreen === true, 'full screen and back did not work');
want(r.sharedKey === 'koffi' || r.sharedKey === 'powershell', 'the launcher’s sign-in key could not be had (' + r.sharedKey + ')');
want(r.sharedRead === true, 'what the launcher saved could not be read: ' + r.sharedRead);
want(r.status && typeof r.status.signedIn === 'boolean', 'Movies & TV did not answer: ' + JSON.stringify(r.status));
want(r.files && r.files.ownTv === false, 'a second copy of the Movies & TV data was made');
want(!String(r.errors || '').trim(), 'errors.log is not empty:\n' + r.errors);
if (bad.length) { console.error('Couch TV is not right on Windows:\n - ' + bad.join('\n - ')); process.exit(1); }
console.log('Couch TV runs on Windows.');
