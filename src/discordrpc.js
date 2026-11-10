'use strict';
// Discord's official local connection ("RPC"), through your own Discord app (made once at
// discord.com/developers). It lets the launcher see who's in a voice call, join and leave
// calls, and mute / deafen you. Discord asks you to approve it the first time.
// live() keeps listening: who's in your call and who's talking right now (for the call shown on
// screen), and Discord's message notifications (for the launcher's own pop-ups; that one needs
// the extra "read notifications" permission, asked for when you connect or allow it again).
//
// Talks to the Discord app on this PC over its local pipe: each message is
// [opcode int32 LE][length int32 LE][JSON]. Opcodes: 0 handshake, 1 frame, 2 close, 3 ping, 4 pong.

const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const SCOPES = ['rpc', 'rpc.voice.read', 'rpc.voice.write', 'identify'];
const MESSAGES = 'rpc.notifications.read';
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
  let sock = null, ready = null, buf = Buffer.alloc(0), authed = false, me = null, scopes = [];
  const pending = new Map();
  const listeners = new Set(); // (evt, data) for everything Discord sends by itself

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
    sock = null; ready = null; authed = false; scopes = []; buf = Buffer.alloc(0);
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
      if (msg.cmd === 'DISPATCH') { if (msg.evt) for (const fn of Array.from(listeners)) { try { fn(String(msg.evt), msg.data || {}); } catch (_) { /* a listener's own trouble */ } } continue; }
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
  // evt: only for SUBSCRIBE / UNSUBSCRIBE (which event).
  function command(cmd, args, ms, evt) {
    if (!sock) return Promise.reject(new Error('Discord isn’t connected'));
    const nonce = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(nonce); reject(new Error('Discord didn’t answer')); }, ms || 10000);
      pending.set(nonce, { resolve, reject, t });
      try { sock.write(encode(1, evt ? { cmd, evt, args: args || {}, nonce } : { cmd, args: args || {}, nonce })); }
      catch (e) { pending.delete(nonce); clearTimeout(t); reject(new Error('Discord isn’t connected')); }
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
    scopes = Array.isArray(d && d.scopes) ? d.scopes.map(String) : [];
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
    // With the permission to read message notifications (for the launcher's own pop-ups) when
    // Discord gives it; if Discord refuses that one, the same as before without it.
    let code;
    const ask = async (list) => (await command('AUTHORIZE', { client_id: clientId, scopes: list }, 120000)).code;
    const cancelled = (e) => /cancel|denied|reject|didn’t answer/i.test(String(e && e.message));
    try {
      try { code = await ask(SCOPES.concat(MESSAGES)); }
      catch (e) { if (cancelled(e) || !sock) throw e; code = await ask(SCOPES); }
    } catch (e) {
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

  // ----- live: your call as it changes, and message notifications
  // onVoice(null | { id, name, people: [{ id, name, pic, muted, deaf, speaking }] }) on every change;
  // onMessage({ title, body, icon }) for each Discord notification. Returns { stop() }.
  const CALL_EVENTS = ['VOICE_STATE_CREATE', 'VOICE_STATE_UPDATE', 'VOICE_STATE_DELETE', 'SPEAKING_START', 'SPEAKING_STOP'];
  function live(onVoice, onMessage, o) {
    o = o || {};
    let on = true, wired = null, msgs = null, chan = null, seq = 0, syncedAt = 0, busy = false, last = 'null';
    let folks = new Map();
    const talking = new Set();
    const snapshot = () => (chan ? { id: chan.id, name: chan.name, people: Array.from(folks.values()).map((p) => Object.assign({}, p, { speaking: talking.has(p.id) })) } : null);
    const push = () => { const v = snapshot(), s = JSON.stringify(v); if (s === last) return; last = s; try { onVoice(v); } catch (_) { /* theirs */ } };
    const clear = () => { chan = null; folks = new Map(); talking.clear(); push(); };
    // The call you're in is now `ch` (null: none). Listens to that channel only.
    function setChannel(ch) {
      const old = chan;
      if (old && (!ch || ch.id !== old.id)) for (const e of CALL_EVENTS) command('UNSUBSCRIBE', { channel_id: old.id }, 10000, e).catch(() => {});
      if (!ch || !ch.id) { clear(); return; }
      const fresh = !old || old.id !== ch.id;
      chan = { id: String(ch.id), name: String(ch.name || 'Voice').slice(0, 80) };
      folks = new Map(people(ch.voice_states).filter((p) => p.id).map((p) => [p.id, p]));
      for (const id of Array.from(talking)) if (!folks.has(id) || fresh) talking.delete(id);
      push();
      if (fresh) for (const e of CALL_EVENTS) command('SUBSCRIBE', { channel_id: chan.id }, 10000, e).catch(() => {});
    }
    function onEvent(evt, d) {
      if (!on) return;
      if (evt === 'VOICE_CHANNEL_SELECT') {
        const mine = ++seq;
        if (!d.channel_id) { setChannel(null); return; }
        command('GET_CHANNEL', { channel_id: String(d.channel_id) }).then((ch) => { if (on && mine === seq && ch) setChannel(ch); }).catch(() => {});
        return;
      }
      if (evt === 'NOTIFICATION_CREATE') {
        const m = d.message || {}, a = m.author || {};
        const title = String(d.title || a.global_name || a.username || 'Discord').replace(/\s+/g, ' ').trim().slice(0, 80);
        const body = String(d.body || m.content || '').replace(/\s+/g, ' ').trim().slice(0, 220);
        const icon = /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\//.test(String(d.icon_url || '')) ? String(d.icon_url) : avatar(a);
        if (title || body) { try { onMessage({ title: title || 'Discord', body, icon }); } catch (_) { /* theirs */ } }
        return;
      }
      if (!chan) return;
      if (d.channel_id && String(d.channel_id) !== chan.id) return; // a late one from the call you left
      if (evt === 'VOICE_STATE_CREATE' || evt === 'VOICE_STATE_UPDATE') { const p = people([d])[0]; if (p && p.id) { folks.set(p.id, p); push(); } }
      else if (evt === 'VOICE_STATE_DELETE') { const id = d.user && d.user.id; if (id) { folks.delete(id); talking.delete(id); push(); } }
      else if (evt === 'SPEAKING_START') { if (d.user_id && folks.has(String(d.user_id))) { talking.add(String(d.user_id)); push(); } }
      else if (evt === 'SPEAKING_STOP') { if (d.user_id && talking.delete(String(d.user_id))) push(); }
    }
    // Connects when Discord is there, listens, and looks again every so often in case an event
    // was missed. Quiet when Discord isn't running or isn't set up.
    async function tick() {
      if (!on || busy) return;
      busy = true;
      try {
        const c = read();
        if (!c.clientId || !c.secret) { if (chan) clear(); return; }
        await ensure();
        if (!on) return;
        const s = sock;
        if (wired !== s) {
          chan = null; folks = new Map(); talking.clear(); // a new connection listens to nothing yet
          await command('SUBSCRIBE', {}, 10000, 'VOICE_CHANNEL_SELECT');
          if (sock !== s || !on) return;
          wired = s; syncedAt = 0;
        }
        // Message notifications, once Discord has given the permission (also when it is given later).
        if (msgs !== s && scopes.includes(MESSAGES)) {
          const ok = await command('SUBSCRIBE', {}, 10000, 'NOTIFICATION_CREATE').then(() => true, () => false);
          if (sock !== s || !on) return;
          if (ok) msgs = s;
        }
        if (Date.now() - syncedAt >= (o.resyncMs || 20000)) {
          const mine = ++seq;
          const sel = await command('GET_SELECTED_VOICE_CHANNEL', {});
          if (on && sock === s && mine === seq) { syncedAt = Date.now(); setChannel(sel || null); }
        }
      } catch (_) {
        if (!sock || !authed) { wired = null; if (chan) clear(); }
      } finally { busy = false; }
    }
    listeners.add(onEvent);
    const timer = setInterval(tick, o.everyMs || 4000);
    tick();
    return { stop() { on = false; clearInterval(timer); listeners.delete(onEvent); }, tick };
  }

  return {
    configured: () => { const c = read(); return !!(c.clientId && c.secret); },
    connected: () => !!(sock && authed),
    // Did Discord give the permission to read message notifications?
    messagesAllowed: () => !!(sock && authed) && scopes.includes(MESSAGES),
    // Asks Discord again with the app you already set up (to add that permission).
    reapprove() { const c = read(); if (!c.clientId || !c.secret) return Promise.reject(new Error('Connect Discord for calls first')); return connect(c.clientId, c.secret); },
    connect, state, join, leave, toggle, live,
    disconnect() { drop(); try { fs.unlinkSync(file); } catch (_) { /* already gone */ } },
    close: () => drop(),
    _encode: encode
  };
}

module.exports = { createDiscordRpc };
