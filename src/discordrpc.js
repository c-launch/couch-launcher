'use strict';
// Discord's official local connection ("RPC"), through your own Discord app (made once at
// discord.com/developers). It lets the launcher see who's in a voice call, join and leave
// calls, and mute / deafen you. Discord asks you to approve it the first time.
//
// Talks to the Discord app on this PC over its local pipe: each message is
// [opcode int32 LE][length int32 LE][JSON]. Opcodes: 0 handshake, 1 frame, 2 close, 3 ping, 4 pong.

const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const SCOPES = ['rpc', 'rpc.voice.read', 'rpc.voice.write', 'identify'];
const REDIRECT = 'http://127.0.0.1';

function pipePaths() {
  if (process.platform === 'win32') return Array.from({ length: 10 }, (_, i) => '\\\\?\\pipe\\discord-ipc-' + i);
  const dir = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || '/tmp';
  return Array.from({ length: 10 }, (_, i) => path.join(dir, 'discord-ipc-' + i));
}

function encode(op, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

// opts.paths / opts.fetch / opts.tokenUrl are only overridden by tests.
function createDiscordRpc(userDataDir, safeStorage, opts) {
  opts = opts || {};
  const file = path.join(userDataDir, 'discord-rpc.json');
  const doFetch = opts.fetch || ((...a) => fetch(...a));
  const tokenUrl = opts.tokenUrl || 'https://discord.com/api/oauth2/token';
  let sock = null, ready = null, buf = Buffer.alloc(0), authed = false, me = null;
  const pending = new Map();

  // ----- saved app ID, secret and tokens (encrypted on this PC)
  const enc = (s) => (safeStorage && safeStorage.isEncryptionAvailable() ? { e: safeStorage.encryptString(s).toString('base64') } : { p: s });
  const dec = (v) => { if (!v) return null; try { return v.e ? safeStorage.decryptString(Buffer.from(v.e, 'base64')) : v.p || null; } catch (_) { return null; } };
  function read() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { clientId: j.clientId || null, secret: dec(j.secret), access: dec(j.access), refresh: dec(j.refresh) };
    } catch (_) { return { clientId: null, secret: null, access: null, refresh: null }; }
  }
  function write(c) {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ clientId: c.clientId, secret: c.secret ? enc(c.secret) : null, access: c.access ? enc(c.access) : null, refresh: c.refresh ? enc(c.refresh) : null }));
  }

  // ----- the pipe
  function drop(err) {
    if (ready && ready.reject) { clearTimeout(ready.timer); const rj = ready.reject; ready.reject = null; rj(err || new Error('Discord closed the connection')); }
    if (sock) { try { sock.destroy(); } catch (_) { /* gone */ } }
    sock = null; ready = null; authed = false; buf = Buffer.alloc(0);
    for (const [, p] of pending) { clearTimeout(p.t); p.reject(err || new Error('Discord closed the connection')); }
    pending.clear();
  }
  function onData(chunk) {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 8) {
      const op = buf.readInt32LE(0), len = buf.readInt32LE(4);
      if (buf.length < 8 + len) break;
      let msg = null;
      try { msg = JSON.parse(buf.slice(8, 8 + len).toString('utf8')); } catch (_) { msg = null; }
      buf = buf.slice(8 + len);
      if (op === 3) { try { sock.write(encode(4, msg || {})); } catch (_) { /* gone */ } continue; }
      if (op === 2) { drop(new Error((msg && msg.message) || 'Discord closed the connection')); return; }
      if (!msg) continue;
      if (msg.cmd === 'DISPATCH' && msg.evt === 'READY' && ready && ready.resolve) { clearTimeout(ready.timer); ready.reject = null; ready.resolve(msg.data || {}); continue; }
      const p = msg.nonce && pending.get(msg.nonce);
      if (!p) continue;
      pending.delete(msg.nonce); clearTimeout(p.t);
      if (msg.evt === 'ERROR') p.reject(Object.assign(new Error((msg.data && msg.data.message) || 'Discord said no'), { code: msg.data && msg.data.code }));
      else p.resolve(msg.data);
    }
  }
  function tryPath(p) {
    return new Promise((resolve) => {
      const s = net.createConnection(p);
      const fail = () => { s.destroy(); resolve(null); };
      s.once('error', fail);
      s.once('connect', () => { s.removeListener('error', fail); resolve(s); });
    });
  }
  async function open(clientId) {
    if (sock && ready && ready.done) return;
    if (ready && ready.promise) return ready.promise;
    const mine = ready = {};
    mine.promise = (async () => {
      let s = null;
      for (const p of (opts.paths || pipePaths())) { s = await tryPath(p); if (s) break; }
      if (ready !== mine) { if (s) s.destroy(); throw new Error('Discord connection was restarted'); }
      if (!s) { ready = null; throw new Error('Discord isn’t running'); }
      sock = s;
      // Only react to this socket: a newer connection may already have replaced it.
      s.on('data', (c) => { if (sock === s) onData(c); });
      s.on('error', () => { if (sock === s) drop(); });
      s.on('close', () => { if (sock === s) drop(); });
      const hello = new Promise((resolve, reject) => {
        mine.resolve = resolve; mine.reject = reject;
        mine.timer = setTimeout(() => { if (mine.reject) { mine.reject = null; reject(new Error('Discord didn’t answer')); } }, 10000);
      });
      s.write(encode(0, { v: 1, client_id: String(clientId) }));
      await hello;
      mine.done = true;
      return s;
    })();
    const p = mine.promise;
    p.catch(() => { if (ready === mine) drop(); });
    return p;
  }
  function command(cmd, args, ms) {
    if (!sock) return Promise.reject(new Error('Discord isn’t connected'));
    const nonce = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(nonce); reject(new Error('Discord didn’t answer')); }, ms || 10000);
      pending.set(nonce, { resolve, reject, t });
      sock.write(encode(1, { cmd, args: args || {}, nonce }));
    });
  }

  // ----- sign-in
  async function token(c, params) {
    const res = await doFetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(Object.assign({ client_id: c.clientId, client_secret: c.secret }, params)).toString(),
      signal: AbortSignal.timeout(15000)
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) {
      const why = j.error_description || j.error || ('HTTP ' + res.status);
      throw new Error(/invalid_client/i.test(String(j.error)) ? 'Discord didn’t accept the app ID or secret' : 'Discord sign-in failed: ' + why);
    }
    c.access = j.access_token; c.refresh = j.refresh_token || c.refresh;
    write(c);
  }
  async function authenticate(c) {
    const d = await command('AUTHENTICATE', { access_token: c.access });
    me = d && d.user ? d.user : null;
    authed = true;
  }
  // Connects (and signs in with the saved token, refreshing it when it has expired).
  // One at a time, and after a failed sign-in it waits a minute before trying Discord again.
  let ensuring = null, failedAt = 0, failErr = null;
  function ensure() {
    if (authed && sock) return Promise.resolve();
    if (ensuring) return ensuring;
    if (failErr && Date.now() - failedAt < 60000) return Promise.reject(failErr);
    ensuring = ensureOnce().then(() => { failErr = null; }, (e) => { failErr = e; failedAt = Date.now(); throw e; }).finally(() => { ensuring = null; });
    return ensuring;
  }
  async function ensureOnce() {
    const c = read();
    if (!c.clientId || !c.secret) throw new Error('NOT_SET_UP');
    await open(c.clientId);
    if (authed) return;
    if (!c.access) throw new Error('NEED_APPROVAL');
    try { await authenticate(c); }
    catch (e) {
      if (!c.refresh) throw new Error('NEED_APPROVAL');
      try { await token(c, { grant_type: 'refresh_token', refresh_token: c.refresh }); await authenticate(c); }
      catch (_) { throw new Error('NEED_APPROVAL'); }
    }
  }

  // First-time setup: saves the app ID + secret, then Discord shows an "Authorize" box.
  async function connect(clientId, secret) {
    clientId = String(clientId || '').trim(); secret = String(secret || '').trim();
    if (!/^\d{15,25}$/.test(clientId)) throw new Error('The Application ID is a long number (copy it from General Information)');
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(secret)) throw new Error('That doesn’t look like a Client Secret (OAuth2 › Reset Secret, then copy)');
    const prev = read();
    if (prev.clientId !== clientId) drop();
    failErr = null;
    // Saved only once Discord approves, so cancelling keeps a working sign-in.
    const c = { clientId, secret, access: null, refresh: null };
    await open(clientId);
    let code;
    try { code = (await command('AUTHORIZE', { client_id: clientId, scopes: SCOPES }, 120000)).code; }
    catch (e) {
      if (/not.*(allow|whitelist|tester)|4000|5000/i.test(String(e.message) + ' ' + e.code)) throw new Error('Discord blocked it: add yourself under App Testers in your Discord app, then try again');
      throw new Error(/cancel|denied|reject/i.test(e.message) ? 'You didn’t approve it in Discord' : e.message);
    }
    try { await token(c, { grant_type: 'authorization_code', code }); }
    catch (e) {
      if (!/redirect/i.test(e.message)) throw e;
      await token(c, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT });
    }
    await authenticate(c);
    return { name: me ? (me.global_name || me.username) : 'Discord' };
  }

  // ----- what the guide uses
  const avatar = (u) => (u && u.avatar ? 'https://cdn.discordapp.com/avatars/' + u.id + '/' + u.avatar + '.png?size=64' : null);
  function people(states) {
    return (states || []).map((s) => {
      const u = s.user || {}, v = s.voice_state || {};
      return { id: u.id, name: s.nick || u.global_name || u.username || 'Someone', pic: avatar(u), muted: !!(v.self_mute || v.mute), deaf: !!(v.self_deaf || v.deaf) };
    });
  }
  async function state(pinIds) {
    await ensure();
    const sel = await command('GET_SELECTED_VOICE_CHANNEL', {});
    const vs = await command('GET_VOICE_SETTINGS', {}).catch(() => null);
    const pins = {};
    for (const id of (pinIds || []).slice(0, 10)) {
      if (sel && sel.id === id) { pins[id] = people(sel.voice_states); continue; }
      try { const ch = await command('GET_CHANNEL', { channel_id: id }); pins[id] = people(ch && ch.voice_states); } catch (_) { pins[id] = null; }
    }
    return {
      me: me ? { id: me.id, name: me.global_name || me.username } : null,
      call: sel ? { id: sel.id, name: sel.name || 'Voice', guildId: sel.guild_id || null, people: people(sel.voice_states) } : null,
      muted: !!(vs && vs.mute), deaf: !!(vs && vs.deaf),
      pins
    };
  }
  async function join(channelId) {
    await ensure();
    if (!/^\d{5,25}$/.test(String(channelId))) throw new Error('Not a voice channel');
    // force: you pressed Join, so move from another call if you're in one.
    const ch = await command('SELECT_VOICE_CHANNEL', { channel_id: String(channelId), force: true, timeout: 10 }, 15000);
    return { name: (ch && ch.name) || 'the call' };
  }
  async function leave() { await ensure(); await command('SELECT_VOICE_CHANNEL', { channel_id: null }); return true; }
  async function toggle(which) {
    await ensure();
    const vs = await command('GET_VOICE_SETTINGS', {});
    const key = which === 'deafen' ? 'deaf' : 'mute';
    const on = !(vs && vs[key]);
    await command('SET_VOICE_SETTINGS', { [key]: on });
    return on;
  }

  return {
    configured: () => { const c = read(); return !!(c.clientId && c.secret); },
    connected: () => !!(sock && authed),
    connect, state, join, leave, toggle,
    disconnect() { drop(); try { fs.unlinkSync(file); } catch (_) { /* already gone */ } },
    close: () => drop(),
    _encode: encode
  };
}

module.exports = { createDiscordRpc };
