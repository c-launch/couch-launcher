'use strict';
// Phone remote: a small web server on your home network. Your phone opens the link (or scans the
// QR code in Settings › Controllers) and gets a remote: d-pad, A/B/X/Y, Home for the guide,
// typing into text boxes, and your game list to start a game from.
// The link carries a secret code; only devices on your own network are answered.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = 47317;
const BUTTONS = ['up', 'down', 'left', 'right', 'A', 'B', 'X', 'Y', 'MENU', 'VIEW', 'LB', 'RB', 'LT', 'RT', 'HOME'];

// Is this address on a home network (or this PC)?
function isLocal(addr) {
  let a = String(addr || '').toLowerCase();
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (a === '::1' || a.startsWith('127.')) return true;
  if (/^10\./.test(a) || /^192\.168\./.test(a) || /^169\.254\./.test(a)) return true;
  const m = /^172\.(\d+)\./.exec(a);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(a) || /^fe80:/.test(a)) return true;
  return false;
}
// This PC's address on the home network (the one a phone can reach).
function lanAddress() {
  const nets = os.networkInterfaces();
  const found = [];
  for (const [name, list] of Object.entries(nets)) {
    for (const n of list || []) {
      if (n.family !== 'IPv4' && n.family !== 4) continue;
      if (n.internal || !isLocal(n.address) || /^169\.254\./.test(n.address)) continue;
      // Virtual adapters (WSL, Hyper-V, VPNs, VirtualBox) can't be reached from a phone.
      const virt = /vethernet|wsl|hyper-v|virtualbox|vmware|vpn|tailscale|zerotier|hamachi|loopback|bluetooth/i.test(name);
      found.push({ addr: n.address, score: (virt ? 0 : 10) + (/^192\.168\./.test(n.address) ? 3 : /^10\./.test(n.address) ? 2 : 1) });
    }
  }
  found.sort((a, b) => b.score - a.score);
  return found.length ? found[0].addr : null;
}
const newToken = () => crypto.randomBytes(16).toString('hex');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// opts: token() -> code, onButton(b) -> result, onText(text, enter) -> result, onLaunch(id) -> result,
// games() -> [{ id, title, platform, art }], state() -> { playing, guide },
// volume() -> { volume, muted }, setVolume({ v | step | mute }) -> { volume, muted }
function createPhoneRemote(opts) {
  let server = null, port = 0;
  const pagePath = path.join(__dirname, 'phone.html');
  const json = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  };
  const readBody = (req) => new Promise((resolve) => {
    let size = 0; const parts = [];
    req.on('data', (c) => { size += c.length; if (size > 8192) { req.destroy(); resolve(null); } else parts.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch (_) { resolve(null); } });
    req.on('error', () => resolve(null));
  });

  async function route(req, res) {
    if (!isLocal(req.socket.remoteAddress)) { res.writeHead(403); return res.end(); }
    const u = new URL(req.url, 'http://x');
    const m = /^\/r\/([0-9a-f]{32})(\/[a-z]+)?(?:\/([\w-]{1,80}))?$/.exec(u.pathname);
    if (!m || !same(m[1], opts.token())) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const what = m[2] || '/', arg = m[3];
    if (req.method === 'GET' && what === '/') {
      let html = '';
      try { html = fs.readFileSync(pagePath, 'utf8'); } catch (_) { html = '<p>Phone remote page missing</p>'; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      return res.end(html);
    }
    if (req.method === 'GET' && what === '/state') return json(res, 200, opts.state());
    if (req.method === 'GET' && what === '/volume') {
      try { return json(res, 200, await opts.volume()); } catch (e) { return json(res, 200, { error: String(e && e.message || e) }); }
    }
    if (req.method === 'GET' && what === '/games') return json(res, 200, opts.games().map((g) => ({ id: g.id, title: g.title, platform: g.platform || '', art: !!g.art })));
    if (req.method === 'GET' && what === '/apps') return json(res, 200, [{ id: 'app:tv', title: 'Movies & TV' }, { id: 'app:youtube', title: 'YouTube' }]);
    if (req.method === 'GET' && what === '/art' && arg) {
      const g = opts.games().find((x) => x.id === arg);
      if (!g || !g.art) { res.writeHead(404); return res.end(); }
      const ext = path.extname(g.art).toLowerCase();
      const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[ext];
      if (!type) { res.writeHead(404); return res.end(); }
      return fs.readFile(g.art, (err, data) => {
        if (err) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=3600' });
        res.end(data);
      });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!body) return json(res, 400, { error: 'Bad request' });
      if (what === '/press') {
        if (!BUTTONS.includes(body.b)) return json(res, 400, { error: 'Unknown button' });
        return json(res, 200, (await opts.onButton(body.b)) || { ok: true });
      }
      if (what === '/text') {
        const t = typeof body.t === 'string' ? body.t.slice(0, 200) : '';
        return json(res, 200, (await opts.onText(t, !!body.enter)) || { ok: true });
      }
      if (what === '/volume') {
        const req2 = {};
        if (typeof body.v === 'number' && isFinite(body.v)) req2.v = Math.max(0, Math.min(100, Math.round(body.v)));
        if (typeof body.step === 'number' && isFinite(body.step)) req2.step = Math.max(-20, Math.min(20, Math.round(body.step)));
        if (typeof body.mute === 'boolean') req2.mute = body.mute;
        if (!Object.keys(req2).length) return json(res, 400, { error: 'Bad request' });
        try { return json(res, 200, await opts.setVolume(req2)); } catch (e) { return json(res, 200, { error: String(e && e.message || e) }); }
      }
      if (what === '/launch') {
        if (typeof body.id !== 'string' || body.id.length > 120) return json(res, 400, { error: 'Bad request' });
        return json(res, 200, (await opts.onLaunch(body.id)) || { ok: true });
      }
    }
    res.writeHead(404); res.end();
  }

  function start() {
    if (server) return Promise.resolve(port);
    return new Promise((resolve, reject) => {
      let tryPort = PORT;
      const s = http.createServer((req, res) => { route(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch (_) { /* gone */ } }); });
      s.on('error', (e) => {
        if (e.code === 'EADDRINUSE' && tryPort < PORT + 5) { tryPort++; s.listen(tryPort, '0.0.0.0'); return; }
        reject(e);
      });
      s.on('listening', () => { server = s; port = tryPort; resolve(port); });
      s.listen(tryPort, '0.0.0.0');
    });
  }
  function stop() { if (server) { try { server.close(); server.closeAllConnections && server.closeAllConnections(); } catch (_) { /* gone */ } } server = null; port = 0; }
  function url() {
    const ip = lanAddress();
    return server && ip ? 'http://' + ip + ':' + port + '/r/' + opts.token() : null;
  }
  return { start, stop, url, get running() { return !!server; }, get port() { return port; } };
}

module.exports = { createPhoneRemote, newToken, isLocal, lanAddress, BUTTONS };
