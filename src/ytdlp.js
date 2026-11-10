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
  : process.platform === 'darwin' ? (process.arch === 'arm64' ? 'deno-aarch64-apple-darwin.zip' : 'deno-x86_64-apple-darwin.zip')
  : process.platform === 'linux' && process.arch === 'x64' ? 'deno-x86_64-unknown-linux-gnu.zip' : null;
const ASSET = process.platform === 'win32' ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp';

// The picture on its own (H.264 first: every PC plays it without effort) plus the sound on its
// own, both as plain links; else one file with both.
const FORMAT = 'bv[height<=1080][vcodec^=avc1][protocol^=http]+ba[protocol^=http]/bv[height<=1080][protocol^=http]+ba[protocol^=http]/best[height<=1080][acodec!=none][vcodec!=none]/best';
// yt-dlp's description of a video (-J) -> what the player needs (see media() below), or null.
function pickMedia(j) {
  if (!j || typeof j !== 'object') return null;
  const ok = (u) => typeof u === 'string' && /^https:\/\//.test(u);
  const has = (x) => !!x && x !== 'none';
  const num = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.round(Number(n)) : 0);
  const one = (j.formats || []).filter((f) => f && ok(f.url) && has(f.vcodec) && has(f.acodec) && /^https?$/.test(String(f.protocol || '')) && num(f.height) <= 720)
    .sort((a, b) => num(b.height) - num(a.height))[0] || null;
  const plain = one ? one.url : null;
  const req = Array.isArray(j.requested_formats) ? j.requested_formats.filter((f) => f && ok(f.url)) : [];
  const video = req.find((f) => has(f.vcodec));
  const audio = req.find((f) => f !== video && has(f.acodec) && !has(f.vcodec));
  if (video && audio) return { url: video.url, audio: audio.url, width: num(video.width || j.width), height: num(video.height || j.height), plain };
  if (video && has(video.acodec)) return { url: video.url, audio: null, width: num(video.width || j.width), height: num(video.height || j.height), plain: plain || video.url };
  if (ok(j.url)) return { url: j.url, audio: null, width: num(j.width), height: num(j.height), plain: plain || j.url };
  if (one) return { url: one.url, audio: null, width: num(one.width), height: num(one.height), plain: one.url };
  return null;
}

function createYtdlp(binDir) {
  const exe = path.join(binDir, ASSET);
  let installing = null;
  const have = () => { try { return fs.statSync(exe).size > 1e6; } catch (_) { return false; } };

  // A download from GitHub's "latest release" address (no sign-in, no hourly limit), checked
  // against the size GitHub says it has. Says plainly when the internet is the problem.
  async function download(url, minBytes, timeout) {
    let dl;
    try { dl = await fetch(url, { headers: { 'User-Agent': 'CouchLauncher' }, signal: AbortSignal.timeout(timeout || 300000) }); }
    catch (e) { throw new Error(/timeout|abort/i.test(String(e && (e.name + e.message))) ? 'The download took too long' : 'Couldn’t reach GitHub (no internet?)'); }
    if (!dl.ok) throw new Error('Download failed (' + dl.status + ')');
    let data;
    try { data = Buffer.from(await dl.arrayBuffer()); } catch (_) { throw new Error('The download was cut off'); }
    const size = Number(dl.headers && dl.headers.get && dl.headers.get('content-length')) || 0;
    if (data.length < minBytes || (size && data.length !== size)) throw new Error('The download was incomplete');
    return data;
  }
  // Does the yt-dlp on disk actually start? (A cut-off or blocked file is there but can't run.)
  let checked = false;
  function works() {
    return new Promise((resolve) => execFile(exe, ['--version'], { windowsHide: true, timeout: 60000 }, (err, out) => resolve(!err && /^\d{4}\./.test(String(out || '').trim()))));
  }
  async function install() {
    if (have() && checked) return exe;
    if (installing) return installing;
    installing = (async () => {
      if (have()) {
        if (await works()) { checked = true; return exe; }
        try { fs.unlinkSync(exe); } catch (_) { /* replaced below */ } // broken: get it again
      }
      const data = await download('https://github.com/yt-dlp/yt-dlp/releases/latest/download/' + ASSET, 1e6);
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(exe + '.part', data);
      fs.renameSync(exe + '.part', exe);
      if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
      if (!(await works())) { try { fs.unlinkSync(exe); } catch (_) { /* gone */ } throw new Error('yt-dlp was downloaded but can’t start (blocked by antivirus?)'); }
      checked = true;
      return exe;
    })().finally(() => { installing = null; });
    return installing;
  }
  // ---- the JavaScript engine (Deno)
  const deno = path.join(binDir, process.platform === 'win32' ? 'deno.exe' : 'deno');
  const haveDeno = () => { try { return fs.statSync(deno).size > 20e6; } catch (_) { return false; } };
  const sh = (cmd, args, timeout) => new Promise((resolve, reject) => execFile(cmd, args, { windowsHide: true, timeout: timeout || 120000 }, (err) => (err ? reject(err) : resolve())));
  let denoing = null, denoTried = 0, denoWhy = '';
  function runtime() {
    if (!DENO_ZIP || haveDeno()) return Promise.resolve(haveDeno());
    if (denoing) return denoing;
    if (Date.now() - denoTried < 10 * 60e3) return Promise.resolve(false); // failed just now: not on every video
    denoTried = Date.now();
    denoing = (async () => {
      const data = await download('https://github.com/denoland/deno/releases/latest/download/' + DENO_ZIP, 10e6, 600000);
      fs.mkdirSync(binDir, { recursive: true });
      const zip = path.join(binDir, 'deno.zip'), tmp = path.join(binDir, 'deno-new');
      fs.writeFileSync(zip, data);
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });
      try {
        if (process.platform === 'win32') {
          // Windows' own tar opens zip files; PowerShell when it can't.
          try { await sh(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', tmp]); }
          catch (_) { const q = (s) => "'" + String(s).replace(/'/g, "''") + "'"; await sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath ' + q(zip) + ' -DestinationPath ' + q(tmp) + ' -Force']); }
        } else await sh('/usr/bin/unzip', ['-o', '-q', zip, '-d', tmp]);
        const got = path.join(tmp, path.basename(deno));
        if (!(fs.statSync(got).size > 20e6)) throw new Error('The download was incomplete');
        if (process.platform !== 'win32') fs.chmodSync(got, 0o755);
        // It has to start, too (a blocked or damaged file is there but can't run).
        try { await sh(got, ['--version'], 60000); } catch (_) { throw new Error('It was downloaded but can’t start (blocked by antivirus?)'); }
        fs.renameSync(got, deno);
      } finally {
        fs.rmSync(zip, { force: true });
        fs.rmSync(tmp, { recursive: true, force: true });
      }
      denoWhy = '';
      return true;
    })().catch((e) => { denoWhy = String((e && e.message) || e).slice(0, 120); return false; }).finally(() => { denoing = null; });
    return denoing;
  }

  function run(args, timeout) {
    return new Promise((resolve, reject) => {
      execFile(exe, args, { windowsHide: true, timeout: timeout || 60000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          // yt-dlp's own reason ("ERROR: …") when it gave one, else why it couldn't run.
          const why = String(stderr || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => /^ERROR:/i.test(l)).pop();
          const msg = why ? why.replace(/^ERROR:\s*/i, '').replace(/^\[[^\]]*\]\s*[\w-]{11}:\s*/, '') : err.killed ? 'YouTube took too long to answer' : err.code === 'ENOENT' ? 'yt-dlp is missing' : typeof err.code === 'string' ? 'yt-dlp couldn’t start (' + err.code + ')' : 'yt-dlp stopped with an error';
          // (Plain words for the usual ones: this is what the break card shows.)
          const plain = /unable to connect|getaddrinfo|name resolution|timed out|unreachable|connection (reset|refused|aborted)|proxy/i.test(msg) ? 'YouTube couldn’t be reached'
            : /sign in to confirm|not a bot/i.test(msg) ? 'YouTube is asking this PC to sign in (too many requests); it usually passes after a while'
            : msg.split(/[;(]/)[0].trim() || msg;
          reject(new Error(plain.slice(0, 160)));
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
  // What the player needs to play a YouTube video:
  //   { url, audio, width, height, plain }
  // url: the picture, as good as the upload has, up to 1080p. YouTube keeps picture and sound
  // apart above 360p, so `audio` is the sound's own link (null when `url` already has it).
  // plain: one file with picture and sound (360p these days), for a player that can't take the
  // two apart, or null.
  async function media(id) {
    if (!/^[\w-]{11}$/.test(id)) throw new Error('Bad video id');
    await install();
    const js = await runtime();
    const base = (js ? ['--js-runtimes', 'deno:' + deno] : []).concat(['--no-warnings', '--no-playlist']);
    const page = 'https://www.youtube.com/watch?v=' + id;
    const ask = async (args) => {
      try { return await run(base.concat(args, page), 60000); } catch (e) {
        // Without the JavaScript engine YouTube refuses every video: say that, not YouTube's vague reason.
        const real = !js && DENO_ZIP ? new Error('the JavaScript engine yt-dlp needs couldn’t be set up' + (denoWhy ? ': ' + denoWhy : '')) : e;
        if (!(await update())) throw real;
        try { return await run(base.concat(args, page), 60000); } catch (e2) { throw !js && DENO_ZIP ? real : e2; }
      }
    };
    let found = null;
    try { found = pickMedia(JSON.parse(await ask(['-J', '-f', FORMAT]))); } catch (e) { found = null; if (/JavaScript engine|couldn’t be reached|sign in/i.test(String(e && e.message))) throw e; }
    if (found) return found;
    // Anything unexpected in that answer: the simple way it always worked (one file, 360p to 720p).
    const out = await ask(['-g', '-f', 'best[height<=720][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]/best']);
    const url = out.split(/\r?\n/).map((l) => l.trim()).find((l) => /^https:\/\//.test(l));
    if (!url) throw new Error('No playable link');
    return { url, audio: null, width: 0, height: 0, plain: url };
  }
  const directUrl = async (id) => { const m = await media(id); return m.plain || m.url; };
  return { install, runtime, search, media, directUrl, update, get installed() { return have(); }, exe };
}

module.exports = { createYtdlp, pickMedia, FORMAT };
