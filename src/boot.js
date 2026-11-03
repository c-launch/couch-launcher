'use strict';
// Starts Couch Launcher. If an installed update (from a CouchLauncher-update zip) is newer than
// the built-in app, runs that instead, so updates don't need a rebuild.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const Module = require('module');

const builtIn = require('../package.json').version;

// Mac: the folders Windows names APPDATA / LOCALAPPDATA / USERPROFILE are ~/Library/Application
// Support and your home folder, so the places emulators keep their settings and saves are found.
if (process.platform === 'darwin' && process.env.HOME) {
  const support = path.join(process.env.HOME, 'Library', 'Application Support');
  if (!process.env.APPDATA) process.env.APPDATA = support;
  if (!process.env.LOCALAPPDATA) process.env.LOCALAPPDATA = support;
  if (!process.env.USERPROFILE) process.env.USERPROFILE = process.env.HOME;
}

function newer(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

let entry = path.join(__dirname, 'main.js');
let version = builtIn;
try {
  const dir = path.join(app.getPath('userData'), 'update');
  const info = JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8'));
  const updMain = path.join(dir, 'src', 'main.js');
  if (newer(info.version, builtIn) && fs.existsSync(updMain)) {
    // Packages such as koffi live inside the installed app; let the update find them there.
    process.env.NODE_PATH = [path.join(__dirname, '..', 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
    Module._initPaths();
    entry = updMain;
    version = info.version;
  }
} catch (_) { /* no update installed */ }

global.couchVersion = version;
global.couchBuiltIn = builtIn;
global.couchNewer = newer;

try {
  require(entry);
} catch (err) {
  // A broken update must never stop the launcher from starting: fall back to the built-in app.
  if (entry !== path.join(__dirname, 'main.js')) {
    try { fs.renameSync(path.join(app.getPath('userData'), 'update'), path.join(app.getPath('userData'), 'update-failed-' + Date.now())); } catch (_) { /* ignore */ }
    global.couchVersion = builtIn;
    global.couchUpdateFailed = String(err && err.message || err);
    require('./main.js');
  } else {
    throw err;
  }
}
