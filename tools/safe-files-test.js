const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { readJson, writeJson } = require('../src/safefile.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-')), f = path.join(dir, 'sub', 'data.json');
assert.strictEqual(readJson(f), undefined, 'nothing saved yet');
writeJson(f, { a: 1 }); assert.deepStrictEqual(readJson(f), { a: 1 }); assert.ok(!fs.existsSync(f + '.tmp') && !fs.existsSync(f + '.bak'));
writeJson(f, { a: 2 }); assert.deepStrictEqual(JSON.parse(fs.readFileSync(f + '.bak', 'utf8')), { a: 1 }, 'the last good copy is kept');
writeJson(f, { a: 3 }); assert.deepStrictEqual(JSON.parse(fs.readFileSync(f + '.bak', 'utf8')), { a: 1 }, 'not refreshed on every save');
// a save cut off half way (power cut): the file is damaged -> the backup is read
fs.writeFileSync(f, '{"a": 3, "b": [1, 2');
assert.deepStrictEqual(readJson(f), { a: 1 }, 'falls back to the backup');
// saving over a damaged file never replaces the good backup with the damaged one
const realNow = Date.now; Date.now = () => realNow() + 10 * 60e3;
writeJson(f, { a: 4 });
assert.deepStrictEqual(JSON.parse(fs.readFileSync(f + '.bak', 'utf8')), { a: 1 }); assert.deepStrictEqual(readJson(f), { a: 4 });
Date.now = () => realNow() + 20 * 60e3; writeJson(f, { a: 5 }); assert.deepStrictEqual(JSON.parse(fs.readFileSync(f + '.bak', 'utf8')), { a: 4 }, 'refreshed later from a good file');
// an empty file, a file holding null, both files damaged
fs.writeFileSync(f, ''); assert.deepStrictEqual(readJson(f), { a: 4 });
fs.writeFileSync(f, 'null'); assert.deepStrictEqual(readJson(f), { a: 4 });
fs.writeFileSync(f + '.bak', 'x'); assert.strictEqual(readJson(f), undefined);
// a leftover .tmp from a crash doesn't get in the way; arrays work; nothing unsaveable is written
fs.writeFileSync(f + '.tmp', 'junk'); writeJson(f, [1, 2]); assert.deepStrictEqual(readJson(f), [1, 2]); assert.ok(!fs.existsSync(f + '.tmp'));
assert.throws(() => writeJson(f, undefined)); assert.deepStrictEqual(readJson(f), [1, 2]);
// the swap refused (file held open by another program on Windows): written directly instead
const realRename = fs.renameSync; fs.renameSync = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
writeJson(f, { a: 9 }); fs.renameSync = realRename; assert.deepStrictEqual(readJson(f), { a: 9 }); assert.ok(!fs.existsSync(f + '.tmp'));
fs.rmSync(dir, { recursive: true, force: true });
console.log('safe files ok');
