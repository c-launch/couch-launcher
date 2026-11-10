'use strict';
// Pauses (suspends) a game's processes while the guide or launcher is in front, so the controller
// only drives the menu. Windows lets every program read the controller, so pausing is the only
// reliable way to keep a game from reacting. Every pause is undone exactly once.
const { execFile } = require('child_process');
const fs = require('fs');

// Fail-safe: which programs are paused right now is also written to a small file. If the
// launcher is killed or crashes while a game is paused, nobody is left to wake the game: it
// would sit frozen until closed from Task Manager. The next start reads the file and wakes them.
// (Waking a program that isn't paused does nothing.)
function createPausedNote(file) {
  return {
    read() { try { const l = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(l) ? l.map(Number).filter((p) => Number.isInteger(p) && p > 4) : []; } catch (_) { return []; } },
    write(pids) { if (!file) return; try { if (pids.length) fs.writeFileSync(file, JSON.stringify(pids)); else fs.unlinkSync(file); } catch (_) { /* best effort */ } },
    clear() { if (!file) return; try { fs.unlinkSync(file); } catch (_) { /* none */ } }
  };
}

// noteFile: where the paused programs are written down (see createPausedNote).
// procs: Windows' own list of programs (procs.js), when it can be had.
function createPauser(noteFile, procs) {
  const off = { available: false, async pause() {}, resumeAll() {}, resumeAfterPending: async () => {}, isPaused: () => false, has: () => false };
  if (process.platform === 'darwin') return createMacPauser();
  if (process.platform !== 'win32') return off;
  let api;
  try {
    const koffi = require('koffi');
    const k32 = koffi.load('kernel32.dll');
    const nt = koffi.load('ntdll.dll');
    api = {
      OpenProcess: k32.func('__stdcall', 'OpenProcess', 'void *', ['uint32', 'bool', 'uint32']),
      CloseHandle: k32.func('__stdcall', 'CloseHandle', 'bool', ['void *']),
      Suspend: nt.func('__stdcall', 'NtSuspendProcess', 'int32', ['void *']),
      Resume: nt.func('__stdcall', 'NtResumeProcess', 'int32', ['void *'])
    };
  } catch (_) { return off; }

  const PROCESS_SUSPEND_RESUME = 0x0800;
  const paused = new Set();

  function act(pid, fn) {
    const h = api.OpenProcess(PROCESS_SUSPEND_RESUME, false, pid);
    if (!h) return false;
    try { return fn(h) >= 0; } finally { api.CloseHandle(h); }
  }

  // A game started by an .exe may run its real game in a child process: include the whole family.
  function familyOf(rootPids) {
    return new Promise((resolve) => {
      // From Windows' own list (a millisecond); PowerShell (about a second) only without it.
      if (procs && procs.ok()) { try { return resolve(procs.family(rootPids)); } catch (_) { /* PowerShell below */ } }
      const ps = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }';
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 10000 }, (err, out) => {
        const all = new Set(rootPids);
        if (!err) {
          const kids = new Map();
          for (const line of String(out).split(/\r?\n/)) {
            const [p, pp] = line.trim().split(/\s+/).map(Number);
            if (p && pp) { if (!kids.has(pp)) kids.set(pp, []); kids.get(pp).push(p); }
          }
          const stack = [...rootPids];
          while (stack.length) for (const k of kids.get(stack.pop()) || []) if (!all.has(k) && k !== process.pid) { all.add(k); stack.push(k); }
        }
        resolve([...all]);
      });
    });
  }

  // Left paused by a launcher that was killed or crashed: wake them now.
  const note = createPausedNote(noteFile);
  if (noteFile) { for (const pid of note.read()) { try { act(pid, api.Resume); } catch (_) { /* gone */ } } note.clear(); }

  let busy = Promise.resolve();
  return {
    available: true,
    isPaused: () => paused.size > 0,
    has: (pid) => paused.has(pid),
    // stillWanted(): checked again right before pausing, in case you went back to the game meanwhile.
    pause(rootPids, stillWanted) {
      busy = busy.then(async () => {
        if (!rootPids.filter(Boolean).length) return;
        const pids = (await familyOf(rootPids.filter(Boolean))).filter((p) => p !== process.pid && !paused.has(p));
        if (stillWanted && !stillWanted()) return;
        for (const pid of pids) {
          // (Written down before each one is frozen, so a crash right here still leaves a record.)
          note.write(Array.from(paused).concat(pid));
          if (act(pid, api.Suspend)) paused.add(pid);
        }
        note.write(Array.from(paused));
      }).catch(() => {});
      return busy;
    },
    // Synchronous on purpose: also used while the app is quitting.
    resumeAll() {
      for (const pid of paused) act(pid, api.Resume);
      if (paused.size) note.clear();
      paused.clear();
    },
    // Waits for any pause still being set up, then undoes everything.
    resumeAfterPending() { return busy.then(() => this.resumeAll()); }
  };
}

// Mac: the game's processes are stopped (SIGSTOP) and continued (SIGCONT), like Windows' suspend.
function createMacPauser() {
  const paused = new Set();
  const familyOf = (rootPids) => new Promise((resolve) => {
    execFile('/bin/ps', ['-A', '-o', 'pid=,ppid='], { timeout: 8000 }, (err, out) => {
      const all = new Set(rootPids);
      if (!err) {
        const kids = new Map();
        for (const line of String(out).split('\n')) {
          const [p, pp] = line.trim().split(/\s+/).map(Number);
          if (p && pp) { if (!kids.has(pp)) kids.set(pp, []); kids.get(pp).push(p); }
        }
        const stack = [...rootPids];
        while (stack.length) for (const k of kids.get(stack.pop()) || []) if (!all.has(k) && k !== process.pid) { all.add(k); stack.push(k); }
      }
      resolve([...all]);
    });
  });
  const sig = (pid, s) => { try { process.kill(pid, s); return true; } catch (_) { return false; } };
  let busy = Promise.resolve();
  return {
    available: true,
    isPaused: () => paused.size > 0,
    has: (pid) => paused.has(pid),
    pause(rootPids, stillWanted) {
      busy = busy.then(async () => {
        if (!rootPids.filter(Boolean).length) return;
        const pids = (await familyOf(rootPids.filter(Boolean))).filter((p) => p !== process.pid && p > 1 && !paused.has(p));
        if (stillWanted && !stillWanted()) return;
        for (const pid of pids) if (sig(pid, 'SIGSTOP')) paused.add(pid);
      }).catch(() => {});
      return busy;
    },
    resumeAll() { for (const pid of paused) sig(pid, 'SIGCONT'); paused.clear(); },
    resumeAfterPending() { return busy.then(() => this.resumeAll()); }
  };
}

module.exports = { createPauser, createPausedNote };
