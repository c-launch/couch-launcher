// Discord's local connection against a pretend Discord (a local socket speaking its protocol).
const net = require('net'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { createDiscordRpc } = require('../src/discordrpc.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcl-'));
const pipe = path.join(dir, 'discord-ipc-0');
const enc = (op, o) => { const b = Buffer.from(JSON.stringify(o)); const h = Buffer.alloc(8); h.writeInt32LE(op, 0); h.writeInt32LE(b.length, 4); return Buffer.concat([h, b]); };
const D = { scopes: ['rpc', 'rpc.voice.read', 'rpc.voice.write', 'identify'], channel: null, subs: [], unsubs: [], auths: [], conns: 0, refuseFull: false };
const vs = (id, name, extra) => ({ nick: name, user: { id, username: name.toLowerCase(), avatar: null }, voice_state: Object.assign({ self_mute: false, self_deaf: false }, extra || {}) });
let client = null;
const srv = net.createServer((s) => {
  client = s; D.conns++; let buf = Buffer.alloc(0);
  s.on('error', () => {});
  s.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    while (buf.length >= 8) {
      const op = buf.readInt32LE(0), len = buf.readInt32LE(4); if (buf.length < 8 + len) break;
      const m = JSON.parse(buf.slice(8, 8 + len).toString()); buf = buf.slice(8 + len);
      if (op === 0) { s.write(enc(1, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1 } })); continue; }
      const ok = (data) => s.write(enc(1, { cmd: m.cmd, data, nonce: m.nonce }));
      const err = (message, code) => s.write(enc(1, { cmd: m.cmd, evt: 'ERROR', data: { message, code }, nonce: m.nonce }));
      if (m.cmd === 'AUTHENTICATE') ok({ user: { id: '1', username: 'me', global_name: 'Me' }, scopes: D.scopes });
      else if (m.cmd === 'AUTHORIZE') { D.auths.push(m.args.scopes); if (D.refuseFull && m.args.scopes.includes('rpc.notifications.read')) err('Invalid scope', 4002); else { D.scopes = m.args.scopes; ok({ code: 'c0de' }); } }
      else if (m.cmd === 'SUBSCRIBE') { if (m.evt === 'NOTIFICATION_CREATE' && !D.scopes.includes('rpc.notifications.read')) err('no permission', 4006); else { D.subs.push(m.evt + ':' + (m.args.channel_id || '')); ok({ evt: m.evt }); } }
      else if (m.cmd === 'UNSUBSCRIBE') { D.unsubs.push(m.evt + ':' + (m.args.channel_id || '')); ok({ evt: m.evt }); }
      else if (m.cmd === 'GET_SELECTED_VOICE_CHANNEL') ok(D.channel);
      else if (m.cmd === 'GET_CHANNEL') setTimeout(() => ok(D.channels[m.args.channel_id] || null), D.slow && D.slow[m.args.channel_id] || 0);
      else if (m.cmd === 'GET_VOICE_SETTINGS') ok({ mute: false, deaf: false });
      else ok({});
    }
  });
});
const emit = (evt, data) => client.write(enc(1, { cmd: 'DISPATCH', evt, data }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await new Promise((r) => srv.listen(pipe, r));
  const ud = path.join(dir, 'ud');
  const mk = () => createDiscordRpc(ud, null, { paths: [pipe], fetch: async () => ({ ok: true, json: async () => ({ access_token: 'tok', refresh_token: 'ref' }) }) });
  let rpc = mk();
  const voice = [], msgs = [];
  // not set up yet: quiet
  let lv = rpc.live((v) => voice.push(v), (m) => msgs.push(m), { everyMs: 60, resyncMs: 400 });
  await wait(200); assert.strictEqual(D.conns, 0, 'no connection before setup'); assert.deepStrictEqual(voice, []);
  // connect: asks for the notifications permission too
  D.channels = { 77: { id: '77', name: 'Squad', voice_states: [vs('1', 'Me'), vs('2', 'Ana')] }, 88: { id: '88', name: 'Other', voice_states: [vs('1', 'Me'), vs('9', 'Zed')] } };
  await rpc.connect('123456789012345678', 'abcdefghijklmnopqrstuvwx');
  assert.ok(D.auths[0].includes('rpc.notifications.read') && rpc.messagesAllowed(), 'asked for and got message notifications');
  await wait(300);
  assert.ok(D.subs.includes('VOICE_CHANNEL_SELECT:') && D.subs.includes('NOTIFICATION_CREATE:'), 'listening: ' + D.subs);
  assert.deepStrictEqual(voice, [], 'not in a call: nothing shown');
  // you join a call
  D.channel = D.channels[77]; emit('VOICE_CHANNEL_SELECT', { channel_id: '77', guild_id: '5' }); await wait(120);
  let v = voice[voice.length - 1];
  assert.ok(v && v.name === 'Squad' && v.people.map((p) => p.name).join() === 'Me,Ana' && v.people.every((p) => !p.speaking), JSON.stringify(v));
  for (const e of ['VOICE_STATE_CREATE', 'VOICE_STATE_UPDATE', 'VOICE_STATE_DELETE', 'SPEAKING_START', 'SPEAKING_STOP']) assert.ok(D.subs.includes(e + ':77'), e);
  // talking
  emit('SPEAKING_START', { channel_id: '77', user_id: '2' }); await wait(60);
  v = voice[voice.length - 1]; assert.ok(v.people.find((p) => p.id === '2').speaking && !v.people.find((p) => p.id === '1').speaking);
  const n = voice.length; emit('SPEAKING_START', { channel_id: '77', user_id: '2' }); await wait(60); assert.strictEqual(voice.length, n, 'no repeat for no change');
  emit('SPEAKING_STOP', { channel_id: '77', user_id: '2' }); await wait(60); assert.ok(!voice[voice.length - 1].people.some((p) => p.speaking));
  emit('SPEAKING_START', { channel_id: '77', user_id: '404' }); await wait(60); assert.ok(!voice[voice.length - 1].people.some((p) => p.speaking), 'a stranger talking is ignored');
  // someone joins, mutes, leaves
  emit('VOICE_STATE_CREATE', vs('3', 'Bo')); await wait(60); assert.strictEqual(voice[voice.length - 1].people.length, 3);
  emit('VOICE_STATE_UPDATE', vs('3', 'Bo', { self_mute: true })); await wait(60); assert.ok(voice[voice.length - 1].people.find((p) => p.id === '3').muted);
  emit('SPEAKING_START', { channel_id: '77', user_id: '3' }); emit('VOICE_STATE_DELETE', vs('3', 'Bo')); await wait(60);
  v = voice[voice.length - 1]; assert.ok(v.people.length === 2 && !v.people.some((p) => p.speaking));
  // a missed event is caught by the look every so often
  D.channels[77].voice_states.push(vs('4', 'Cy')); await wait(600); assert.ok(voice[voice.length - 1].people.some((p) => p.name === 'Cy'), 'resync');
  // switching calls quickly: the slow answer for the first one never wins
  D.slow = { 77: 150 }; D.channel = D.channels[88];
  emit('VOICE_CHANNEL_SELECT', { channel_id: '77' }); emit('VOICE_CHANNEL_SELECT', { channel_id: '88' }); await wait(350);
  v = voice[voice.length - 1]; assert.ok(v.name === 'Other' && v.people.map((p) => p.name).join() === 'Me,Zed', JSON.stringify(v));
  assert.ok(D.unsubs.includes('SPEAKING_START:77') && D.subs.includes('SPEAKING_START:88'));
  emit('SPEAKING_START', { channel_id: '77', user_id: '1' }); await wait(60); assert.ok(!voice[voice.length - 1].people.some((p) => p.speaking), 'late event from the old call ignored');
  // a message notification
  emit('NOTIFICATION_CREATE', { channel_id: '5', title: 'Ana (#general)', body: 'yo   get on\nfortnite', icon_url: 'https://cdn.discordapp.com/avatars/2/a.png', message: { content: 'x', author: { id: '2', username: 'ana' } } });
  emit('NOTIFICATION_CREATE', { message: { content: 'hi', author: { id: '2', username: 'ana', avatar: 'abc' } }, icon_url: 'http://evil.example/x.png' });
  await wait(60);
  assert.deepStrictEqual(msgs[0], { title: 'Ana (#general)', body: 'yo get on fortnite', icon: 'https://cdn.discordapp.com/avatars/2/a.png' });
  assert.deepStrictEqual(msgs[1], { title: 'ana', body: 'hi', icon: 'https://cdn.discordapp.com/avatars/2/abc.png?size=64' }, 'only Discord pictures');
  // you leave the call
  D.channel = null; emit('VOICE_CHANNEL_SELECT', { channel_id: null }); await wait(60); assert.strictEqual(voice[voice.length - 1], null);
  // Discord closes: nothing shown, and it comes back by itself
  D.channel = D.channels[88]; emit('VOICE_CHANNEL_SELECT', { channel_id: '88' }); await wait(100); assert.ok(voice[voice.length - 1]);
  const before = D.conns;
  await new Promise((r) => { srv.close(r); client.destroy(); }); await wait(300);
  assert.strictEqual(voice[voice.length - 1], null, 'cleared when Discord goes away');
  await new Promise((r) => srv.listen(pipe, r));
  const realNow = Date.now; Date.now = () => realNow() + 61000; // (it waits a minute before trying a Discord that wasn't there)
  await wait(700); assert.ok(D.conns > before && voice[voice.length - 1] && voice[voice.length - 1].name === 'Other', 'back after Discord returns: ' + D.conns);
  assert.ok(D.subs.filter((s) => s === 'SPEAKING_START:88').length >= 2, 'listening again on the new connection');
  // the older sign-in without the permission: calls work, no message subscription, then allowed later
  lv.stop(); rpc.close();
  D.scopes = ['rpc', 'rpc.voice.read', 'rpc.voice.write', 'identify']; D.subs.length = 0; voice.length = 0; msgs.length = 0;
  rpc = mk(); lv = rpc.live((x) => voice.push(x), (m) => msgs.push(m), { everyMs: 60, resyncMs: 400 });
  await wait(300);
  assert.ok(!rpc.messagesAllowed() && !D.subs.includes('NOTIFICATION_CREATE:') && voice[voice.length - 1].name === 'Other', 'calls without the permission');
  await rpc.reapprove(); await wait(200);
  assert.ok(rpc.messagesAllowed() && D.subs.includes('NOTIFICATION_CREATE:'), 'allowed later, picked up without restarting');
  emit('NOTIFICATION_CREATE', { title: 'T', body: 'B' }); await wait(60); assert.strictEqual(msgs.length, 1);
  // Discord refuses that permission: connecting still works without it
  lv.stop(); rpc.close(); D.refuseFull = true; D.auths.length = 0;
  rpc = mk(); await rpc.connect('123456789012345678', 'abcdefghijklmnopqrstuvwx');
  assert.ok(D.auths.length === 2 && !D.auths[1].includes('rpc.notifications.read') && rpc.connected() && !rpc.messagesAllowed(), 'falls back: ' + JSON.stringify(D.auths));
  // stop() really stops
  lv = rpc.live((x) => voice.push(x), () => {}, { everyMs: 60 }); await wait(150); lv.stop(); const k = voice.length;
  emit('VOICE_CHANNEL_SELECT', { channel_id: null }); await wait(150); assert.strictEqual(voice.length, k);
  rpc.close(); srv.close(); fs.rmSync(dir, { recursive: true, force: true });
  console.log('discord live ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
