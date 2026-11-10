'use strict';
// Which programs are running, asked from Windows directly.
//
// Until 1.28.2 the launcher started PowerShell every 3 seconds while a store game ran (to see
// whether the game was still there) and `tasklist` every 5 seconds during a game's first
// minutes. Starting a program just to ask that costs far more than the question. Windows
// answers the same thing in about a millisecond through its "toolhelp" list.
//
// What that list can't always tell is where a program's file is: the launcher isn't allowed to
// look at some programs (anti-cheat games, Windows' own services). PowerShell (through Windows'
// management service) can. So createTracker() below only falls back to PowerShell for the
// programs it can't see into, remembers the answer, and checks its own result against
// PowerShell once a minute: if they ever differ, PowerShell's answer is used and the difference
// is written to errors.log. The result is the same list as before, without the cost.
//
// Everything Windows-specific is in winApi(); the rest takes it as a parameter, so it can be
// tested anywhere.

const path = require('path');

// PROCESSENTRY32W, read by hand (64-bit: 568 bytes; 32-bit: 556).
const LAYOUT = process.arch === 'ia32'
  ? { size: 556, pid: 8, ppid: 24, name: 36 }
  : { size: 568, pid: 8, ppid: 32, name: 44 };
function parseEntry(buf, L) {
  L = L || LAYOUT;
  let end = L.name;
  while (end + 1 < L.name + 520 && end + 1 < buf.length && (buf[end] || buf[end + 1])) end += 2;
  return { pid: buf.readUInt32LE(L.pid), ppid: buf.readUInt32LE(L.ppid), name: buf.toString('utf16le', L.name, end) };
}

function winApi() {
  const koffi = require('koffi');
  const k32 = koffi.load('kernel32.dll');
  const Snapshot = k32.func('__stdcall', 'CreateToolhelp32Snapshot', 'intptr_t', ['uint32', 'uint32']);
  const First = k32.func('__stdcall', 'Process32FirstW', 'bool', ['intptr_t', 'void *']);
  const Next = k32.func('__stdcall', 'Process32NextW', 'bool', ['intptr_t', 'void *']);
  const CloseSnap = k32.func('__stdcall', 'CloseHandle', 'bool', ['intptr_t']);
  const OpenProcess = k32.func('__stdcall', 'OpenProcess', 'void *', ['uint32', 'bool', 'uint32']);
  const CloseHandle = k32.func('__stdcall', 'CloseHandle', 'bool', ['void *']);
  const ImageName = k32.func('__stdcall', 'QueryFullProcessImageNameW', 'bool', ['void *', 'uint32', 'void *', koffi.inout(koffi.pointer('uint32'))]);
  return {
    // Every running program: [{ pid, ppid, name }]. Throws when Windows won't give the list.
    list() {
      const snap = Snapshot(0x2, 0); // TH32CS_SNAPPROCESS
      if (snap === -1 || snap === -1n || !snap) throw new Error('no process list');
      try {
        const out = [];
        const buf = Buffer.alloc(LAYOUT.size);
        buf.writeUInt32LE(LAYOUT.size, 0);
        let ok = First(snap, buf);
        while (ok && out.length < 20000) {
          out.push(parseEntry(buf));
          buf.fill(0, 4); buf.writeUInt32LE(LAYOUT.size, 0);
          ok = Next(snap, buf);
        }
        return out;
      } finally { CloseSnap(snap); }
    },
    // The full path of a program's file, or null when the launcher isn't allowed to look.
    pathOf(pid) {
      const h = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
      if (!h) return null;
      try {
        const buf = Buffer.alloc(4096); const len = [2047];
        return ImageName(h, 0, buf, len) && len[0] > 0 ? buf.toString('utf16le', 0, len[0] * 2) : null;
      } finally { CloseHandle(h); }
    }
  };
}

// o (all optional, for tests): { api, self, exe }
function createProcs(o) {
  o = o || {};
  let api = o.api || null;
  if (!api) {
    if (process.platform !== 'win32') return null;
    try { api = winApi(); } catch (_) { return null; }
  }
  const self = o.self || process.pid, exe = o.exe || process.execPath;
  // Is the list believable? The launcher itself must be in it, under its own name and path.
  // Asked once; when it isn't, nobody uses this and everything works the old way.
  let trusted = null;
  function ok() {
    if (trusted !== null) return trusted;
    try {
      const me = api.list().find((p) => p.pid === self);
      const mine = api.pathOf(self);
      trusted = !!me && me.name.toLowerCase() === path.win32.basename(exe).toLowerCase() && !!mine && mine.toLowerCase() === String(exe).toLowerCase();
    } catch (_) { trusted = false; }
    return trusted;
  }
  return {
    ok,
    list: () => api.list(),
    pathOf: (pid) => api.pathOf(pid),
    // The given programs and everything they started (children, their children…), without the launcher.
    family(roots) {
      const kids = new Map();
      for (const p of api.list()) { if (p.pid && p.ppid && p.pid !== p.ppid) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p.pid); } }
      const all = new Set(roots.filter(Boolean));
      const stack = Array.from(all);
      while (stack.length) for (const k of kids.get(stack.pop()) || []) if (!all.has(k) && k !== self) { all.add(k); stack.push(k); }
      return Array.from(all);
    },
    // The names of everything running, the way `tasklist /FO CSV /NH` starts each line.
    asTasklist: () => api.list().map((p) => '"' + p.name + '"').join('\r\n')
  };
}

// Crash reporters (Roblox, Unity, Unreal…) keep running after a game closes: never counted.
const NOT_THE_GAME = /crash|bugreport|errorreport|crashpad|werfault/i;

// Follows which running programs live in one folder (a game's install folder).
//   procs: createProcs()'s result
//   dir: the folder
//   slow(): the old way: a Promise of the pids in that folder (PowerShell), or null when it failed
//   o: { now, verifyMs, slowGapMs, onMismatch(detail) }
// pids(): a Promise of the pids in the folder right now, or null when it can't be told this time
// (exactly what the old way gave, so the code that uses it didn't have to change).
function createTracker(procs, dir, slow, o) {
  o = o || {};
  const now = o.now || Date.now;
  const VERIFY = o.verifyMs || 60000, SLOW_GAP = o.slowGapMs || 3000;
  const d = (dir.endsWith('\\') ? dir : dir + '\\').toLowerCase();
  // What is known about each program seen so far. key: pid + name (a pid can be used again by
  // another program later). value: 'in' | 'out' | 'unknown' (can't look, PowerShell not asked yet).
  const known = new Map();
  const key = (p) => p.pid + '|' + p.name.toLowerCase();
  let lastSlow = -Infinity, lastVerify = -Infinity, slowBusy = null, broken = false, emptyConfirmed = false;

  // Asks the old way and takes its word for every program that was alive when it was asked.
  // Resolves true when it answered.
  function askSlow(alive) {
    if (slowBusy) return slowBusy;
    lastSlow = now();
    slowBusy = Promise.resolve().then(slow).then((pids) => {
      if (!Array.isArray(pids)) return false;
      const yes = new Set(pids);
      const diff = [];
      for (const p of alive) {
        if (NOT_THE_GAME.test(p.name)) continue;
        const k = key(p), was = known.get(k), is = yes.has(p.pid) ? 'in' : 'out';
        if (was === undefined) continue; // gone, and forgotten, while PowerShell was answering
        if (was !== 'unknown' && was !== is) diff.push(p.name + ' ' + was + '->' + is);
        known.set(k, is);
      }
      if (diff.length && o.onMismatch) { try { o.onMismatch(diff.slice(0, 6).join(', ')); } catch (_) { /* theirs */ } }
      lastVerify = now();
      return true;
    }, () => false).finally(() => { slowBusy = null; });
    return slowBusy;
  }

  async function pids() {
    if (broken || !procs || !procs.ok()) return slow();
    let alive;
    try { alive = procs.list(); } catch (_) { alive = null; }
    if (!alive || !alive.length) { broken = true; return slow(); } // the list stopped working: the old way from now on
    const t = now();
    // Forget programs that are gone; look at the new ones.
    const live = new Set(alive.map(key));
    for (const k of Array.from(known.keys())) if (!live.has(k)) known.delete(k);
    let unknown = 0;
    for (const p of alive) {
      const k = key(p), was = known.get(k);
      if (was === 'unknown') { unknown++; continue; }
      if (was) continue;
      if (NOT_THE_GAME.test(p.name) || !p.pid) { known.set(k, 'out'); continue; }
      let file = null;
      try { file = procs.pathOf(p.pid); } catch (_) { file = null; }
      if (file) known.set(k, file.toLowerCase().startsWith(d) ? 'in' : 'out');
      else { known.set(k, 'unknown'); unknown++; }
    }
    const answer = () => alive.filter((p) => known.get(key(p)) === 'in').map((p) => p.pid);
    const empty = answer().length === 0;
    if (!empty) emptyConfirmed = false;
    // The old way is asked when there are programs that can't be looked into, when it's time to
    // double-check, and before ever saying "nothing there" (never said on this list's word alone).
    const need = unknown > 0 || t - lastVerify >= VERIFY || (empty && !emptyConfirmed);
    if (!need) return answer();
    // Asked a moment ago, or it didn't answer: with programs still unaccounted for, or with
    // "nothing there" unconfirmed, the answer is "can't tell this time" (null, as the old way
    // gave when PowerShell failed). Only a missed double-check lets what is known stand.
    const unsure = unknown > 0 || empty;
    if (t - lastSlow < SLOW_GAP && !slowBusy) return unsure ? null : answer();
    const answered = await askSlow(alive);
    if (!answered) return unsure ? null : answer();
    const a = answer();
    emptyConfirmed = a.length === 0;
    return a;
  }
  return { pids, get known() { return known; } };
}

module.exports = { createProcs, createTracker, parseEntry, NOT_THE_GAME, LAYOUT };
