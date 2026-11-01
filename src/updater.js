'use strict';
// One-step updates: download a CouchLauncher-update zip from the chat, and the launcher finds it in
// your Downloads folder, checks it's newer, and installs it when you say so.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const NAME = /^CouchLauncher-update.*\.zip$/i;

function run(cmd, args) {
  return new Promise((resolve, reject) => execFile(cmd, args, { windowsHide: true, timeout: 120000 }, (err) => (err ? reject(err) : resolve())));
}

// folders: every place to look for update zips (Downloads, G:\\launcher, ...). The newest zip wins.
function createUpdater({ userData, folders, currentVersion, newer }) {
  const staging = path.join(userData, 'update-staging');
  const target = path.join(userData, 'update');
  let ready = null; // { version, notes, zip }

  // Picks the update zip with the highest version in its name (CouchLauncher-update-1.2.3.zip);
  // if names have no version, the most recently saved one.
  function newestZip() {
    const found = [];
    for (const folder of folders) {
      let names = [];
      try { names = fs.readdirSync(folder); } catch (_) { continue; } // folder or drive not there
      for (const n of names) {
        if (!NAME.test(n)) continue;
        const full = path.join(folder, n);
        let st;
        try { st = fs.statSync(full); } catch (_) { continue; }
        const m = /(\d+\.\d+\.\d+)/.exec(n);
        found.push({ path: full, mtimeMs: st.mtimeMs, version: m ? m[1] : null });
      }
    }
    found.sort((a, b) => {
      if (a.version && b.version && a.version !== b.version) return newer(a.version, b.version) ? -1 : 1;
      if (!!a.version !== !!b.version) return a.version ? -1 : 1;
      return b.mtimeMs - a.mtimeMs;
    });
    return found.length ? found[0].path : null;
  }

  async function unzip(zip, dest) {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    try {
      await run('tar', ['-xf', zip, '-C', dest]); // built into Windows 10 and 11
    } catch (_) {
      const ps = "Expand-Archive -LiteralPath '" + zip.replace(/'/g, "''") + "' -DestinationPath '" + dest.replace(/'/g, "''") + "' -Force";
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    }
  }

  // Looks for an update. Returns { status: 'none' | 'current' | 'ready', version, notes }.
  async function check() {
    const zip = newestZip();
    if (!zip) return { status: 'none' };
    await unzip(zip, staging);
    let info;
    try { info = JSON.parse(fs.readFileSync(path.join(staging, 'version.json'), 'utf8')); } catch (_) { throw new Error('That update file is damaged. Download it again.'); }
    if (!fs.existsSync(path.join(staging, 'src', 'main.js')) || !fs.existsSync(path.join(staging, 'src', 'renderer', 'index.html'))) throw new Error('That update file is incomplete. Download it again.');
    if (!newer(info.version, currentVersion)) { fs.rmSync(staging, { recursive: true, force: true }); return { status: 'current', version: currentVersion }; }
    ready = { version: info.version, notes: info.notes || '', zip };
    return { status: 'ready', version: info.version, notes: ready.notes };
  }

  // Puts the checked update in place. The app restarts right after.
  function install() {
    if (!ready || !fs.existsSync(staging)) throw new Error('Check for the update first');
    const old = target + '-old';
    fs.rmSync(old, { recursive: true, force: true });
    if (fs.existsSync(target)) fs.renameSync(target, old);
    fs.renameSync(staging, target);
    fs.rmSync(old, { recursive: true, force: true });
    return ready.version;
  }

  // Online updates: asks GitHub for the newest release and downloads its update zip into
  // `into` (one of the folders above), where check() then finds it like any other zip.
  async function download(repo, into) {
    // 1) updates/latest.json in the repo: { version, notes, file, size }
    const raw = 'https://raw.githubusercontent.com/' + repo + '/main/updates/';
    const m = await fetch(raw + 'latest.json?t=' + Date.now(), { headers: { 'User-Agent': 'CouchLauncher' }, signal: AbortSignal.timeout(15000) });
    if (m.ok) {
      const info = await m.json();
      const version = (/^(\d+\.\d+\.\d+)$/.exec(String(info.version || '')) || [])[1];
      const fileName = String(info.file || '');
      if (!version || !/^CouchLauncher-update-\d+\.\d+\.\d+\.zip$/.test(fileName)) throw new Error('The update list is damaged');
      if (!newer(version, currentVersion)) return { status: 'current', version: currentVersion };
      return fetchZip(raw + fileName, Number(info.size) || 0, version, into);
    }
    if (m.status !== 404) throw new Error('Couldn’t reach the update server (' + m.status + ')');
    // 2) GitHub Releases, if the repo uses them.
    const api = 'https://api.github.com/repos/' + repo + '/releases/latest';
    const res = await fetch(api, { headers: { 'User-Agent': 'CouchLauncher', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
    if (res.status === 404) return { status: 'none' };
    if (!res.ok) throw new Error('Couldn’t reach the update server (' + res.status + ')');
    const rel = await res.json();
    const version = (/(\d+\.\d+\.\d+)/.exec(String(rel.tag_name || '')) || [])[1];
    if (!version || !newer(version, currentVersion)) return { status: 'current', version: currentVersion };
    const asset = (rel.assets || []).find((a) => NAME.test(a.name || ''));
    if (!asset) return { status: 'none' };
    return fetchZip(asset.browser_download_url, asset.size, version, into);
  }
  async function fetchZip(url, size, version, into) {
    const name = 'CouchLauncher-update-' + version + '.zip';
    const file = path.join(into, name);
    if (fs.existsSync(file) && (!size || fs.statSync(file).size === size)) return { status: 'downloaded', version };
    fs.mkdirSync(into, { recursive: true });
    const dl = await fetch(url, { headers: { 'User-Agent': 'CouchLauncher' }, signal: AbortSignal.timeout(300000) });
    if (!dl.ok) throw new Error('Download failed (' + dl.status + ')');
    const buf = Buffer.from(await dl.arrayBuffer());
    if (size && buf.length !== size) throw new Error('Download was incomplete');
    fs.writeFileSync(file + '.part', buf);
    fs.renameSync(file + '.part', file);
    // Older downloaded updates aren't needed any more.
    for (const n of fs.readdirSync(into)) if (NAME.test(n) && n !== name) { try { fs.rmSync(path.join(into, n)); } catch (_) { /* in use */ } }
    return { status: 'downloaded', version };
  }

  return { check, install, download };
}

module.exports = { createUpdater };
