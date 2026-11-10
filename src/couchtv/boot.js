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
global.couchVersion = require('../../package.json').version;

require('./main.js');
