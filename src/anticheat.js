'use strict';
// Games protected by anti-cheat (Easy Anti-Cheat, BattlEye, EA's and Riot's). While one runs, the
// launcher keeps its hands off it: no pausing it, no keys pressed for you, no background
// controller reader and no moving its window. Fortnite's BattlEye kicked players with
// "forbidden tool" for things like that.
const fs = require('fs');
const path = require('path');

const DIR_MARK = /^(easyanticheat(_eos)?|battleye|eaanticheat|vanguard|anticheat|anti-cheat|xigncode|nprotect|gameguard)$/i;
const FILE_MARK = /^(easyanticheat(_eos)?(_setup)?\.exe|beservice(_x64)?\.exe|start_protected_game\.exe|eaanticheat\.(installer|gameservice)\.exe|battleye_launcher\.exe|.*_be\.exe|.*_eac\.exe|.*_eac_eos\.exe)$/i;
// While a protected game runs, its anti-cheat service runs too.
const PROC_MARK = /^(beservice(_x64)?|easyanticheat(_eos)?|eaanticheat\.gameservice|fortniteclient-win64-shipping_(be|eac|eac_eos)|valorant-win64-shipping)\.exe$/i;
// Known by name when nothing else gives it away.
const TITLE_MARK = /\b(fortnite|valorant|league of legends|apex legends|rainbow six|pubg|battlegrounds|call of duty|warzone|destiny 2|dead by daylight|the finals|marvel rivals|fall guys|rocket league|overwatch|counter-strike 2|cs2|escape from tarkov|rust|arma|dayz|halo infinite|xdefiant|naraka|elden ring)\b/i;

// Looks a few folders deep for anti-cheat folders or files (stops after a few thousand entries).
function dirIsProtected(dir, opts) {
  opts = opts || {};
  const fsx = opts.fs || fs;
  if (!dir) return false;
  let seen = 0;
  const walk = (d, depth) => {
    let list;
    try { list = fsx.readdirSync(d, { withFileTypes: true }); } catch (_) { return false; }
    for (const e of list) {
      if (++seen > 4000) return false;
      if (e.isDirectory() ? DIR_MARK.test(e.name) : FILE_MARK.test(e.name)) return true;
    }
    if (depth <= 0) return false;
    for (const e of list) if (e.isDirectory() && !/^(\.|_commonredist|redist|movies|content|paks|saved|logs)/i.test(e.name) && walk(path.join(d, e.name), depth - 1)) return true;
    return false;
  };
  return walk(dir, 4);
}
// tasklist /FO CSV /NH output: is an anti-cheat service running?
function processesShowProtection(csv) {
  for (const line of String(csv || '').split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line.trim());
    if (m && PROC_MARK.test(m[1])) return true;
  }
  return false;
}
const titleIsProtected = (title) => TITLE_MARK.test(String(title || ''));

module.exports = { dirIsProtected, processesShowProtection, titleIsProtected };
