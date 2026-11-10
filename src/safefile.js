'use strict';
// Saved files that survive a crash or a power cut in the middle of a save.
//  - Saving writes a new file beside the old one and swaps them in one step, so the file on
//    disk is always either the old one or the new one, never half of one.
//  - The last good copy is kept as <file>.bak (refreshed at most every few minutes, and never
//    from a damaged file), and reading falls back to it when the main file can't be read.
const fs = require('fs');
const path = require('path');

const BAK_EVERY = 5 * 60 * 1000;
const lastBak = new Map();

// The saved value, or undefined when neither the file nor its backup can be read.
function readJson(file) {
  for (const f of [file, file + '.bak']) {
    try { const v = JSON.parse(fs.readFileSync(f, 'utf8')); if (v !== null && v !== undefined) return v; } catch (_) { /* the backup next */ }
  }
  return undefined;
}

function writeJson(file, data, pretty) {
  const text = JSON.stringify(data, null, pretty ? 2 : undefined);
  if (typeof text !== 'string') throw new Error('Nothing to save');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  const t = Date.now();
  if (t - (lastBak.get(file) || 0) >= BAK_EVERY) {
    try { JSON.parse(fs.readFileSync(file, 'utf8')); fs.copyFileSync(file, file + '.bak'); lastBak.set(file, t); } catch (_) { /* no good copy to keep yet */ }
  }
  try { fs.renameSync(tmp, file); }
  catch (_) {
    // (Windows can refuse the swap while another program has the file open: write it directly.)
    fs.writeFileSync(file, text);
    try { fs.unlinkSync(tmp); } catch (__) { /* gone */ }
  }
}

module.exports = { readJson, writeJson };
