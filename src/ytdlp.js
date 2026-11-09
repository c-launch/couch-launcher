'use strict';
// yt-dlp: a free helper for YouTube videos. Cable TV uses it for its commercial breaks: it finds
// recordings of old commercial breaks on YouTube and gets a playable link for the player.
// Downloaded once into the launcher's own folder (about 18 MB), from yt-dlp's GitHub page.
// YouTube also makes players run a piece of JavaScript before it hands out a video, so yt-dlp
// needs a JavaScript engine beside it: Deno, the one yt-dlp recommends (about 45 MB to download,
// 120 MB on disk), from Deno's GitHub page. Without it every video comes back "not available".

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DENO_ZIP = process.platform === 'win32' ? 'deno-x86_64-pc-windows-msvc.zip'
  : process.platform === 'darwin' ? (process.arch === 'arm64' ? 'deno-aarch64-apple-darwin.zip' : 'deno-x86_64-apple-darwin.zip') : null;
const ASSET = process.platform === 'win32' ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp';

function createYtdlp(binDir) {
  const exe = path.join(binDir, ASSET);
  let installing = null;
  const have = () => { try { return fs.statSync(exe).size > 1e6; } catch (_) { return false; } };

  async function install() {
    if (have()) return exe;
    if (installing) return installing;
    installing = (async () => {
      const res = await fetch('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', { headers: { 'User-Agent': 'CouchLauncher', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error('Couldn’t reach GitHub (' + res.status + ')');
      const rel = await res.json();
      const asset = (rel.assets || []).find((a) => a.name === ASSET);
      if (!asset || !/^https:\/\/github\.com\/yt-dlp\/yt-dlp\/releases\/download\//.test(asset.browser_download_url || '')) throw new Error('yt-dlp download not found');
      const dl = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'CouchLauncher' }, signal: AbortSignal.timeout(300000) });
      if (!dl.ok) throw new Error('Download failed (' + dl.status + ')');
      const data = Buffer.from(await dl.arrayBuffer());
      if (asset.size && data.length !== asset.size) throw new Error('The download was incomplete');
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(exe + '.part', data);
      fs.renameSync(exe + '.part', exe);
      if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
      return exe;
    })().finally(() => { installing = null; });
    return installing;
  }
  // ---- the JavaScript engine (Deno)
  const deno = path.join(binDir, process.platform === 'win32' ? 'deno.exe' : 'deno');
  const haveDeno = () => { try { return fs.statSync(deno).size > 20e6; } catch (_) { return false; } };
  const sh = (cmd, args, timeout) => new Promise((resolve, reject) => execFile(cmd, args, { windowsHide: true, timeout: timeout || 120000 }, (err) => (err ? reject(err) : resolve())));
  let denoing = null, denoTried = 0;
  function runtime() {
    if (!DENO_ZIP || haveDeno()) return Promise.resolve(haveDeno());
    if (denoing) return denoing;
    if (Date.now() - denoTried < 10 * 60e3) return Promise.resolve(false); // failed just now: not on every video
    denoTried = Date.now();
    denoing = (async () => {
      const dl = await fetch('https://github.com/denoland/deno/releases/latest/download/' + DENO_ZIP, { headers: { 'User-Agent': 'CouchLauncher' }, signal: AbortSignal.timeout(600000) });
      if (!dl.ok) throw new Error('Download failed (' + dl.status + ')');
      const data = Buffer.from(await dl.arrayBuffer());
      const size = Number(dl.headers.get('content-length')) || 0;
      if (data.length < 10e6 || (size && data.length !== size)) throw new Error('The download was incomplete');
      fs.mkdirSync(binDir, { recursive: true });
      const zip = path.join(binDir, 'deno.zip'), tmp = path.join(binDir, 'deno-new');
      fs.writeFileSync(zip, data);
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });
      try {
        if (process.platform === 'win32') {
          // Windows' own tar opens zip files; PowerShell when it can't.
          try { await sh(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', tmp]); }
          catch (_) { await sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force', zip, tmp]); }
        } else await sh('/usr/bin/unzip', ['-o', '-q', zip, '-d', tmp]);
        const got = path.join(tmp, path.basename(deno));
        if (!(fs.statSync(got).size > 20e6)) throw new Error('The download was incomplete');
        fs.renameSync(got, deno);
        if (process.platform !== 'win32') fs.chmodSync(deno, 0o755);
      } finally {
        fs.rmSync(zip, { force: true });
        fs.rmSync(tmp, { recursive: true, force: true });
      }
      return true;
    })().catch(() => false).finally(() => { denoing = null; });
    return denoing;
  }

  function run(args, timeout) {
    return new Promise((resolve, reject) => {
      execFile(exe, args, { windowsHide: true, timeout: timeout || 60000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          // yt-dlp's own reason ("ERROR: …") when it gave one, else why it couldn't run.
          const why = String(stderr || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => /^ERROR:/i.test(l)).pop();
          const msg = why ? why.replace(/^ERROR:\s*/i, '').replace(/^\[[^\]]*\]\s*[\w-]{11}:\s*/, '') : err.killed ? 'YouTube took too long to answer' : err.code === 'ENOENT' ? 'yt-dlp is missing' : typeof err.code === 'string' ? 'yt-dlp couldn’t start (' + err.code + ')' : 'yt-dlp stopped with an error';
          reject(new Error(msg.slice(0, 160)));
        } else resolve(String(stdout || ''));
      });
    });
  }
  // YouTube changes often and an old yt-dlp stops working: it updates itself (at most every six
  // hours) when a video can't be opened.
  let updatedAt = 0, updating = null;
  function update() {
    if (updating) return updating;
    if (Date.now() - updatedAt < 6 * 3600e3) return Promise.resolve(false);
    updatedAt = Date.now();
    // (The nightly build: YouTube fixes land there first, as yt-dlp itself advises.)
    updating = run(['--update-to', 'nightly'], 180000).then(() => true, () => false).finally(() => { updating = null; });
    return updating;
  }
  // YouTube search: [{ id, title, duration }] (without opening each video, so it's quick).
  async function search(query, n) {
    await install();
    const out = await run(['--flat-playlist', '-J', '--no-warnings', 'ytsearch' + Math.max(1, Math.min(40, n || 20)) + ':' + String(query).slice(0, 120)], 90000);
    let j;
    try { j = JSON.parse(out); } catch (_) { return []; }
    return (j.entries || []).filter((e) => e && /^[\w-]{11}$/.test(e.id || '')).map((e) => ({ id: e.id, title: String(e.title || '').slice(0, 160), duration: Number(e.duration) || 0 }));
  }
  // A link the player can open directly (one file with picture and sound, 720p at most).
  async function directUrl(id) {
    if (!/^[\w-]{11}$/.test(id)) throw new Error('Bad video id');
    await install();
    const js = await runtime();
    const args = (js ? ['--js-runtimes', 'deno:' + deno] : []).concat(['-g', '--no-warnings', '--no-playlist', '-f', 'best[height<=720][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]/best', 'https://www.youtube.com/watch?v=' + id]);
    let out;
    try { out = await run(args, 60000); } catch (e) {
      if (!(await update())) throw e;
      out = await run(args, 60000);
    }
    const url = out.split(/\r?\n/).map((l) => l.trim()).find((l) => /^https:\/\//.test(l));
    if (!url) throw new Error('No playable link');
    return url;
  }
  return { install, runtime, search, directUrl, update, get installed() { return have(); }, exe };
}

module.exports = { createYtdlp };
