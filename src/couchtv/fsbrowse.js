'use strict';
// Browsing for a file (the same three questions the launcher's screens ask its app core):
// what is in a folder, the system's own "Open" window, and checking a typed path.
const fs = require('fs');
const path = require('path');

function registerFsBrowse(handle, { app, dialog, win }) {
  const MAC = process.platform === 'darwin';
  handle('fs:list', (dir, exts) => {
    const want = Array.isArray(exts) && exts.length ? new Set(exts.map((e) => String(e).toLowerCase())) : null;
    if (!dir) {
      const places = [];
      for (const [label, key] of [['Desktop', 'desktop'], ['Downloads', 'downloads'], ['Documents', 'documents']]) {
        try { places.push({ name: label, path: app.getPath(key), isDir: true, place: true }); } catch (_) { /* skip */ }
      }
      places.push({ name: 'Home folder', path: app.getPath('home'), isDir: true, place: true });
      if (MAC) places.unshift({ name: 'Applications', path: '/Applications', isDir: true, place: true });
      if (process.platform === 'win32') {
        for (let c = 67; c <= 90; c++) { // C: to Z:
          const d = String.fromCharCode(c) + ':\\';
          try { if (fs.existsSync(d)) places.push({ name: 'Drive ' + d.slice(0, 2), path: d, isDir: true, place: true }); } catch (_) { /* skip */ }
        }
      } else places.push({ name: 'Computer', path: '/', isDir: true, place: true });
      return { path: '', parent: null, entries: places };
    }
    const resolved = path.resolve(String(dir));
    const entries = [];
    for (const e of fs.readdirSync(resolved, { withFileTypes: true })) {
      if (e.name.startsWith('$') || e.name.startsWith('.')) continue;
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) { try { isDir = fs.statSync(path.join(resolved, e.name)).isDirectory(); } catch (_) { continue; } }
      if (MAC && isDir && /\.app$/i.test(e.name) && want && (want.has('.exe') || want.has('.app'))) isDir = false;
      else if (!isDir && want && !want.has(path.extname(e.name).toLowerCase()) && !(MAC && want.has('.exe') && path.extname(e.name) === '')) continue;
      entries.push({ name: e.name, path: path.join(resolved, e.name), isDir });
    }
    entries.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    const parent = path.dirname(resolved);
    return { path: resolved, parent: parent === resolved ? '' : parent, entries };
  });
  handle('fs:pick', async (opts) => {
    opts = opts || {};
    const exts = (opts.exts || []).map((e) => String(e).replace(/^\./, '')).filter(Boolean);
    const w = win();
    const r = await dialog.showOpenDialog(w, {
      title: opts.title || 'Choose',
      defaultPath: opts.start || undefined,
      properties: [opts.folder ? 'openDirectory' : 'openFile'],
      filters: opts.folder || !exts.length ? [] : [{ name: opts.filterName || 'Supported files', extensions: exts }, { name: 'All files', extensions: ['*'] }]
    });
    if (w && !w.isDestroyed()) w.focus();
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });
  handle('fs:stat', (p) => {
    const clean = String(p || '').trim().replace(/^"(.*)"$/, '$1');
    if (!clean) return { exists: false, path: '' };
    try { const st = fs.statSync(clean); return { exists: true, isDir: st.isDirectory(), path: path.resolve(clean) }; }
    catch (_) { return { exists: false, path: clean }; }
  });
}

module.exports = { registerFsBrowse };
