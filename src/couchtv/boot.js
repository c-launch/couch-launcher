'use strict';
// Starts Couch TV: Movies & TV and Cable TV from Couch Launcher as an app of its own, in a
// normal window. Same code as the launcher's Movies & TV, same addons, list and history.
const { app } = require('electron');
const path = require('path');

// Mac: the folders Windows names APPDATA / LOCALAPPDATA / USERPROFILE (see ../boot.js).
if (process.platform === 'darwin' && process.env.HOME) {
  const support = path.join(process.env.HOME, 'Library', 'Application Support');
  if (!process.env.APPDATA) process.env.APPDATA = support;
  if (!process.env.LOCALAPPDATA) process.env.LOCALAPPDATA = support;
  if (!process.env.USERPROFILE) process.env.USERPROFILE = process.env.HOME;
}

// Its own settings folder ("Couch TV"), beside the launcher's ("Couch Launcher").
// (COUCH_TV_HOME / COUCH_TV_SHARED: other folders, for the build check and tests.)
const appData = app.getPath('appData');
app.setName('Couch TV');
app.setPath('userData', process.env.COUCH_TV_HOME || path.join(appData, 'Couch TV'));
global.couchTvShared = process.env.COUCH_TV_SHARED || path.join(appData, 'Couch Launcher');

// Updates: the same update files as Couch Launcher's (one version for both). An installed
// update newer than this app is run instead of the built-in code; one that can't be started
// (or that twice didn't get as far as its first screen, see main.js) is set aside and the
// built-in app runs.
const fs = require('fs');
const Module = require('module');
const builtIn = require('../../package.json').version;
function newer(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}
const own = path.join(__dirname, 'main.js');
let entry = own;
let version = builtIn;
try {
  const dir = path.join(app.getPath('userData'), 'update');
  const info = JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8'));
  const updMain = path.join(dir, 'src', 'couchtv', 'main.js');
  if (newer(info.version, builtIn) && fs.existsSync(updMain) && fs.existsSync(path.join(dir, 'src', 'renderer', 'index.html'))) {
    // Packages such as koffi live inside the installed app; let the update find them there.
    process.env.NODE_PATH = [path.join(__dirname, '..', '..', 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
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
  if (entry === own) throw err;
  try { fs.renameSync(path.join(app.getPath('userData'), 'update'), path.join(app.getPath('userData'), 'update-failed-' + Date.now())); } catch (_) { /* ignore */ }
  global.couchVersion = builtIn;
  global.couchUpdateFailed = String((err && err.message) || err);
  require('./main.js');
}
