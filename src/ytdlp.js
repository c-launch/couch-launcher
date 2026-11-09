'use strict';
// yt-dlp: a free helper for YouTube videos. Cable TV uses it for its commercial breaks: it finds
// recordings of old commercial breaks on YouTube and gets a playable link for the player.
// Downloaded once into the launcher's own folder (about 10 MB), from yt-dlp's GitHub page.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

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
    updating = run(['-U'], 180000).then(() => true, () => false).finally(() => { updating = null; });
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
    const args = ['-g', '--no-warnings', '--no-playlist', '-f', 'best[height<=720][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]/best', 'https://www.youtube.com/watch?v=' + id];
    let out;
    try { out = await run(args, 60000); } catch (e) {
      if (!(await update())) throw e;
      out = await run(args, 60000);
    }
    const url = out.split(/\r?\n/).map((l) => l.trim()).find((l) => /^https:\/\//.test(l));
    if (!url) throw new Error('No playable link');
    return url;
  }
  return { install, search, directUrl, update, get installed() { return have(); }, exe };
}

module.exports = { createYtdlp };
