'use strict';
const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r || !r.ok) throw new Error((r && r.error) || 'Something went wrong');
  return r.value;
}

contextBridge.exposeInMainWorld('launcher', {
  load: () => call('lib:load'),
  save: (lib) => call('lib:save', lib),
  scan: (source) => call('scan', source || null),
  launch: (id) => call('launch', id),
  cancelLaunch: () => call('launch:cancel'),
  closeGame: (force) => call('game:close', !!force),
  gameStatus: () => call('game:status'),
  openEmulator: (id) => call('emu:open', id),
  artStatus: () => call('art:status'),
  artConnect: (key) => call('art:connect', key),
  artDisconnect: () => call('art:disconnect'),
  findArt: (title, id, want) => call('art:find', title, id, want || null),
  openArtKeyPage: () => call('link:open', 'https://www.steamgriddb.com/profile/preferences/api'),
  listDisplays: () => call('display:list'),
  setDisplay: (id) => call('display:set', id),
  steamStatus: () => call('steam:status'),
  steamConnect: (key, profile) => call('steam:connect', key, profile || null),
  steamDisconnect: () => call('steam:disconnect'),
  steamFriends: () => call('steam:friends'),
  steamMe: () => call('steam:me'),
  media: (cmd, prefer) => call('media:run', cmd, prefer || ''),
  launchMusic: (app) => call('media:launch', app),
  musicRunning: () => call('media:running'),
  closeMusic: (app) => call('media:close', app),
  openSteamKeyPage: () => call('link:open', 'https://steamcommunity.com/dev/apikey'),
  detectEmuDeck: () => call('emu:detect'),
  exeFromScript: (file) => call('emu:fromScript', file),
  hideOverlay: () => call('overlay:hide'),
  goHome: () => call('app:home'),
  openStore: (id) => call('store:open', String(id || '')),
  discordStatus: () => call('discord:status'),
  dcRpcStatus: () => call('dcrpc:status'),
  dcRpcConnect: (id, secret) => call('dcrpc:connect', String(id || ''), String(secret || '')),
  dcRpcDisconnect: () => call('dcrpc:disconnect'),
  dcRpcState: (ids) => call('dcrpc:state', Array.isArray(ids) ? ids.map(String) : []),
  dcRpcJoin: (id) => call('dcrpc:join', String(id || '')),
  dcRpcLeave: () => call('dcrpc:leave'),
  dcRpcToggle: (which) => call('dcrpc:toggle', which === 'deafen' ? 'deafen' : 'mute'),
  openDiscordDevPage: () => call('link:open', 'https://discord.com/developers/applications'),
  discordSetup: (set) => call('discord:setup', set === true ? true : null),
  discordCheck: (url) => call('discord:check', String(url || '')),
  discordClipboard: () => call('discord:clipboard'),
  discordOpen: (url, join) => call('discord:open', url ? String(url) : null, !!join),
  discordKey: (which) => call('discord:key', which === 'deafen' ? 'deafen' : 'mute'),
  discordType: (text) => call('discord:type', String(text || '')),
  balance: (b, prefer) => call('audio:balance', b == null ? null : Number(b), prefer || ''),
  overlayAction: (req) => call('overlay:action', req),
  checkUpdate: () => call('update:check'),
  installUpdate: () => call('update:install'),
  resumeGame: () => call('game:resume'),
  importArt: (src, id, kind) => call('art:import', src, id, kind),
  listDir: (dir, exts) => call('fs:list', dir || '', exts || []),
  pickNative: (opts) => call('fs:pick', opts || {}),
  statPath: (p) => call('fs:stat', p),
  info: () => call('app:info'),
  setAutostart: (on) => call('app:autostart', !!on),
  power: (action) => call('app:power', action),
  xboxStatus: () => call('xbox:status'),
  xboxConnect: (key) => call('xbox:connect', key),
  xboxDisconnect: () => call('xbox:disconnect'),
  xboxProfile: () => call('xbox:profile'),
  xboxFriends: () => call('xbox:friends'),
  openXblSite: () => call('link:open', 'https://xbl.io'),
  on: (channel, fn) => {
    const allowed = ['game:exited', 'game:started', 'launch:cancelled', 'overlay', 'window:focus', 'guide', 'update:found', 'overlay:open', 'overlay:closed', 'remote'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  }
});
