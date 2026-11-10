'use strict';
// Couch TV reads the Stremio sign-in that Couch Launcher saved (and saves it so the launcher can
// read it back), so you sign in once for both.
//
// The launcher keeps that sign-in encrypted the way every Chromium program on Windows does:
//   - a random key, itself protected by Windows for your Windows account (DPAPI), kept in the
//     file "Local State" in the launcher's settings folder;
//   - the text is "v10" + 12 random bytes + AES-256-GCM of the text + the 16-byte check.
// Any program you run under your own Windows account can ask Windows to unprotect that key;
// that is what this does. Nothing here weakens how it is kept.
//
// Windows only. Everywhere else (and whenever anything here doesn't work) open() gives null and
// Couch TV keeps its own sign-in instead.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// ----- asking Windows to unprotect something (two ways; the second starts PowerShell once)
let koffiWay = null; // (made once: a named type can't be declared twice)
function dpapiKoffi() {
  if (koffiWay) return koffiWay;
  const koffi = require('koffi');
  const crypt32 = koffi.load('crypt32.dll');
  const k32 = koffi.load('kernel32.dll');
  const BLOB = koffi.struct('CTV_DATA_BLOB', { cbData: 'uint32', pbData: 'void *' });
  const Unprotect = crypt32.func('__stdcall', 'CryptUnprotectData', 'bool', [koffi.pointer(BLOB), 'void *', 'void *', 'void *', 'void *', 'uint32', koffi.out(koffi.pointer(BLOB))]);
  const LocalFree = k32.func('__stdcall', 'LocalFree', 'void *', ['void *']);
  koffiWay = (buf) => {
    const out = {};
    if (!Unprotect({ cbData: buf.length, pbData: buf }, null, null, null, null, 1 /* no windows */, out) || !out.pbData) return null;
    try { return Buffer.from(koffi.decode(out.pbData, koffi.array('uint8', out.cbData))); }
    finally { LocalFree(out.pbData); }
  };
  return koffiWay;
}
function dpapiPowerShell(buf) {
  const script = 'Add-Type -AssemblyName System.Security; ' +
    '[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($env:CTV_BLOB), $null, 0))';
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: Object.assign({}, process.env, { CTV_BLOB: buf.toString('base64') }), windowsHide: true, timeout: 20000, encoding: 'utf8'
  });
  const b = Buffer.from(String(out).trim(), 'base64');
  return b.length ? b : null;
}
// Each way, in order; the name of the one that worked is kept for the build check.
const ways = () => [['koffi', (b) => dpapiKoffi()(b)], ['powershell', dpapiPowerShell]];
function unprotect(buf, list) {
  for (const [name, fn] of list || ways()) {
    try { const r = fn(buf); if (r && r.length) return { key: r, how: name }; } catch (_) { /* the next way */ }
  }
  return null;
}

// ----- the text itself
function encrypt(text, key) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return Buffer.concat([Buffer.from('v10'), nonce, body, c.getAuthTag()]);
}
// The text, or null when it isn't in this form or wasn't made with this key.
function decrypt(buf, key) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 3 + 12 + 16 || buf.slice(0, 3).toString('latin1') !== 'v10') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.slice(3, 15));
    d.setAuthTag(buf.slice(buf.length - 16));
    return Buffer.concat([d.update(buf.slice(15, buf.length - 16)), d.final()]).toString('utf8');
  } catch (_) { return null; }
}

// The launcher's key from its settings folder, or null.
// o (for tests): { platform, ways }
function open(launcherDir, o) {
  o = o || {};
  if ((o.platform || process.platform) !== 'win32') return null;
  let got = null;
  try {
    const state = JSON.parse(fs.readFileSync(path.join(launcherDir, 'Local State'), 'utf8'));
    const raw = Buffer.from(String(state.os_crypt.encrypted_key), 'base64');
    if (raw.slice(0, 5).toString('latin1') !== 'DPAPI') return null;
    got = unprotect(raw.slice(5), o.ways);
  } catch (_) { return null; }
  if (!got || got.key.length !== 32) return null;
  const key = got.key;
  return { how: got.how, encrypt: (text) => encrypt(text, key), decrypt: (buf) => decrypt(buf, key) };
}

module.exports = { open, encrypt, decrypt, unprotect, ways };
