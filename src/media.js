'use strict';
// Music controls for Apple Music, Spotify, or any player that shows up in Windows' media controls.
// A small PowerShell helper talks to Windows' media session API; it stays running while needed.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const SCRIPT = String.raw`
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
function Say($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + '`' + String.raw`1' })[0]
  function Await($op, [Type]$t) { $task = $asTaskGeneric.MakeGenericMethod($t).Invoke($null, @($op)); $null = $task.Wait(-1); $task.Result }
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
} catch { Say @{ error = 'Windows media controls aren''t available: ' + $_.Exception.Message }; exit 1 }
$volOk = $false
try {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
namespace CouchAudio {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom {}
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  }
  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    [PreserveSig] int GetAudioSessionControl(IntPtr a, int b, out IntPtr c);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr a, int b, out IntPtr c);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator e);
  }
  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, out IAudioSessionControl2 session);
  }
  [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int s);
    [PreserveSig] int GetDisplayName(out IntPtr n);
    [PreserveSig] int SetDisplayName(IntPtr n, ref Guid g);
    [PreserveSig] int GetIconPath(out IntPtr p);
    [PreserveSig] int SetIconPath(IntPtr p, ref Guid g);
    [PreserveSig] int GetGroupingParam(out Guid g);
    [PreserveSig] int SetGroupingParam(ref Guid g, ref Guid c);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr n);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr n);
    [PreserveSig] int GetSessionIdentifier(out IntPtr id);
    [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id);
    [PreserveSig] int GetProcessId(out uint pid);
  }
  [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISimpleAudioVolume {
    [PreserveSig] int SetMasterVolume(float level, ref Guid ctx);
    [PreserveSig] int GetMasterVolume(out float level);
  }
  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int Item(int index, out IMMDevice device);
  }
  public static class AppVolume {
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, System.Text.StringBuilder sb, ref uint size);
    static string PathOf(uint pid) {
      IntPtr h = OpenProcess(0x1000, false, pid);
      if (h == IntPtr.Zero) return "";
      try { var sb = new System.Text.StringBuilder(1024); uint n = 1024; return QueryFullProcessImageNameW(h, 0, sb, ref n) ? sb.ToString() : ""; }
      finally { CloseHandle(h); }
    }
    // A game's sound: its processes, or anything running from its folder (launchers start helpers).
    static Func<uint, string, string, bool> GameMatch(string pids, string dirs) {
      var ids = new HashSet<uint>();
      foreach (var x in (pids ?? "").Split(',')) { uint v; if (uint.TryParse(x, out v) && v > 0) ids.Add(v); }
      var ds = new List<string>();
      foreach (var x in (dirs ?? "").Split('|')) { var d = x.Trim(); if (d.Length > 3) ds.Add(d.EndsWith("\\") ? d : d + "\\"); }
      return (pid, pn, sid) => {
        if (ids.Contains(pid)) return true;
        if (ds.Count == 0) return false;
        var p = PathOf(pid);
        foreach (var d in ds) if (p.StartsWith(d, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
      };
    }
    public static int GetGame(string pids, string dirs) { return Read(Find(GameMatch(pids, dirs))); }
    public static int SetGame(string pids, string dirs, int pct) { return Write(Find(GameMatch(pids, dirs)), pct); }
    static int Read(List<KeyValuePair<ISimpleAudioVolume, bool>> l) {
      foreach (var v in l) { float x; if (v.Key.GetMasterVolume(out x) == 0) return (int)Math.Round(x * 100); }
      return -1;
    }
    static int Write(List<KeyValuePair<ISimpleAudioVolume, bool>> l, int pct) {
      pct = Math.Max(0, Math.Min(100, pct));
      Guid g = Guid.Empty; int done = 0;
      foreach (var v in l) { if (v.Key.SetMasterVolume(pct / 100f, ref g) == 0) done++; }
      return done > 0 ? Read(l) : -1;
    }
    static Func<uint, string, string, bool> AppMatch(string name, string token) {
      return (pid, pn, sid) => string.Equals(pn, name, StringComparison.OrdinalIgnoreCase) || sid.IndexOf(token, StringComparison.OrdinalIgnoreCase) >= 0;
    }
    // Every audio stream of the app, on every output device (it may not play on the default one).
    // Matched by process name, or by the app's package / exe in the session ID (helper processes).
    static List<KeyValuePair<ISimpleAudioVolume, bool>> Find(Func<uint, string, string, bool> match) {
      var list = new List<KeyValuePair<ISimpleAudioVolume, bool>>();
      var en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
      IntPtr colPtr;
      if (en.EnumAudioEndpoints(0, 1, out colPtr) != 0 || colPtr == IntPtr.Zero) return list; // render, active
      var col = (IMMDeviceCollection)Marshal.GetObjectForIUnknown(colPtr);
      Marshal.Release(colPtr);
      int devs; col.GetCount(out devs);
      for (int d = 0; d < devs; d++) {
        IMMDevice dev;
        if (col.Item(d, out dev) != 0 || dev == null) continue;
        Guid iid = typeof(IAudioSessionManager2).GUID;
        object o;
        if (dev.Activate(ref iid, 23, IntPtr.Zero, out o) != 0 || o == null) continue;
        IAudioSessionEnumerator se;
        if (((IAudioSessionManager2)o).GetSessionEnumerator(out se) != 0 || se == null) continue;
        int n; se.GetCount(out n);
        for (int i = 0; i < n; i++) {
          IAudioSessionControl2 c;
          if (se.GetSession(i, out c) != 0 || c == null) continue;
          uint pid; c.GetProcessId(out pid);
          if (pid == 0) continue;
          string pn = "";
          try { pn = Process.GetProcessById((int)pid).ProcessName; } catch { }
          string sid = "";
          IntPtr p;
          if (c.GetSessionIdentifier(out p) == 0 && p != IntPtr.Zero) { sid = Marshal.PtrToStringUni(p) ?? ""; Marshal.FreeCoTaskMem(p); }
          if (!match(pid, pn, sid)) continue;
          int state; c.GetState(out state);
          list.Add(new KeyValuePair<ISimpleAudioVolume, bool>((ISimpleAudioVolume)c, state == 1));
        }
      }
      // Streams that are playing right now first.
      list.Sort((a, b) => (b.Value ? 1 : 0) - (a.Value ? 1 : 0));
      return list;
    }
    public static int Get(string name, string token) { return Read(Find(AppMatch(name, token))); }
    public static int Set(string name, string token, int pct) { return Write(Find(AppMatch(name, token)), pct); }
  }
}
'@
$volOk = $true
} catch { $volOk = $false }
function ProcOf($app) { if ($app -eq 'Apple Music') { 'AppleMusic' } elseif ($app -eq 'Spotify') { 'Spotify' } else { '' } }
function TokenOf($app) { if ($app -eq 'Apple Music') { 'AppleInc.AppleMusic' } elseif ($app -eq 'Spotify') { 'Spotify.exe' } else { '' } }
Say @{ ready = $true }
$lastArtKey = ''
function Pick($prefer) {
  $sessions = @($mgr.GetSessions())
  if ($prefer) { $s = $sessions | Where-Object { $_.SourceAppUserModelId -like ('*' + $prefer + '*') } | Select-Object -First 1; if ($s) { return $s } }
  $cur = $mgr.GetCurrentSession(); if ($cur) { return $cur }
  return ($sessions | Select-Object -First 1)
}
function AppName($id) { if ($id -like '*AppleMusic*') { 'Apple Music' } elseif ($id -like '*Spotify*') { 'Spotify' } else { $id } }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $parts = $line.Split(' ', 2); $cmd = $parts[0]; $prefer = ''; if ($parts.Count -gt 1) { $prefer = $parts[1] }
  if ($cmd -eq 'gamevol' -or $cmd -eq 'gameget') {
    # "gamevol pct|pid,pid|dir|dir": the game's own volume
    try {
      if (-not $volOk) { throw 'no audio' }
      $f = $prefer.Split('|'); $dirs = (@($f) | Select-Object -Skip 2) -join '|'
      if ($cmd -eq 'gamevol') { $gv = [CouchAudio.AppVolume]::SetGame($f[1], $dirs, [int]$f[0]) } else { $gv = [CouchAudio.AppVolume]::GetGame($f[1], $dirs) }
      Say @{ game = $gv }
    } catch { Say @{ game = -1 } }
    continue
  }
  try {
    $s = Pick $prefer
    if (-not $s) { Say @{ none = $true }; continue }
    switch ($cmd) {
      'toggle' { $null = Await ($s.TryTogglePlayPauseAsync()) ([bool]) }
      'next' { $null = Await ($s.TrySkipNextAsync()) ([bool]) }
      'prev' { $null = Await ($s.TrySkipPreviousAsync()) ([bool]) }
      'shuffle' { $on = [bool]$s.GetPlaybackInfo().IsShuffleActive; $null = Await ($s.TryChangeShuffleActiveAsync(-not $on)) ([bool]) }
    }
    if ($cmd -ne 'state' -and $cmd -notlike 'vol*') { Start-Sleep -Milliseconds 300 }
    $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $info = $s.GetPlaybackInfo()
    $key = '' + $p.Title + '|' + $p.Artist + '|' + $p.AlbumTitle
    $o = @{ app = (AppName $s.SourceAppUserModelId); title = $p.Title; artist = $p.Artist; album = $p.AlbumTitle; key = $key;
      playing = ($info.PlaybackStatus.ToString() -eq 'Playing'); shuffle = [bool]$info.IsShuffleActive }
    if ($p.Thumbnail -and $key -ne $lastArtKey) {
      $bytes = $null
      try {
        $stream = Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
        $size = [uint32]$stream.Size
        if ($size -gt 0) {
          $reader = [Windows.Storage.Streams.DataReader]::new($stream.GetInputStreamAt(0))
          $null = Await ($reader.LoadAsync($size)) ([uint32])
          $bytes = New-Object byte[] $size
          $reader.ReadBytes($bytes)
          $reader.Dispose()
        }
      } catch { $bytes = $null }
      if (-not $bytes) {
        try {
          $stream2 = Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
          $net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream2)
          $ms = New-Object System.IO.MemoryStream; $net.CopyTo($ms); $bytes = $ms.ToArray()
        } catch { $bytes = $null }
      }
      if ($bytes -and $bytes.Length -gt 0) {
        $o.art = 'data:image/jpeg;base64,' + [Convert]::ToBase64String($bytes)
        $lastArtKey = $key
      }
    }
    if ($volOk) {
      $pn = ProcOf $o.app
      if ($pn) {
        try {
          $tk = TokenOf $o.app
          $v = [CouchAudio.AppVolume]::Get($pn, $tk)
          if ($v -ge 0 -and $cmd -eq 'volup') { $v = [CouchAudio.AppVolume]::Set($pn, $tk, $v + 10) }
          if ($v -ge 0 -and $cmd -eq 'voldown') { $v = [CouchAudio.AppVolume]::Set($pn, $tk, $v - 10) }
          if ($v -ge 0 -and $cmd -like 'volset:*') { $v = [CouchAudio.AppVolume]::Set($pn, $tk, [int]$cmd.Substring(7)) }
          $o.volume = $v
        } catch { $o.volume = -1 }
      }
    }
    Say $o
  } catch { Say @{ error = $_.Exception.Message } }
}
`;

function createMedia(userDataDir) {
  let proc = null, buf = '', waiters = [], art = { key: null, url: null }, starting = null;

  function stop() {
    if (proc) { try { proc.kill(); } catch (_) { /* gone */ } }
    proc = null; buf = '';
    while (waiters.length) waiters.shift().reject(new Error('Music helper stopped'));
  }

  function start() {
    if (process.platform !== 'win32') return Promise.reject(new Error('Music controls need Windows'));
    if (proc) return Promise.resolve();
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      const file = path.join(userDataDir, 'media-helper.ps1');
      try { fs.mkdirSync(userDataDir, { recursive: true }); fs.writeFileSync(file, SCRIPT); } catch (e) { starting = null; return reject(e); }
      proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      proc.stdout.setEncoding('utf8');
      let first = true;
      proc.stdout.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
          if (first) {
            first = false; starting = null;
            if (msg.error) { stop(); reject(new Error(msg.error)); } else resolve();
            continue;
          }
          const w = waiters.shift();
          if (w) w.resolve(msg);
        }
      });
      proc.on('exit', () => { const was = starting; proc = null; starting = null; if (was && first) reject(new Error('Music helper couldn’t start')); while (waiters.length) waiters.shift().reject(new Error('Music helper stopped')); });
      proc.on('error', (e) => { starting = null; reject(e); });
      setTimeout(() => { if (first) { stop(); starting = null; reject(new Error('Music helper took too long to start')); } }, 15000);
    });
    return starting;
  }

  async function send(cmd, prefer) {
    await start();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { stop(); reject(new Error('Music app didn’t answer')); }, 8000);
      waiters.push({ resolve: (m) => { clearTimeout(t); resolve(m); }, reject: (e) => { clearTimeout(t); reject(e); } });
      proc.stdin.write(cmd + (prefer ? ' ' + prefer : '') + '\n');
    });
  }

  // Backup for album art: when Windows doesn't hand over the cover, look the song up in Apple's
  // public music catalog (no key needed). Results are remembered per song.
  const coverCache = new Map(); // key -> url | null (null = looked, nothing found)
  const looking = new Set();
  const norm = (x) => String(x || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const big = (u) => (u ? u.replace(/\/\d+x\d+bb\./, '/600x600bb.') : null);
  async function search(term, entity) {
    const res = await fetch('https://itunes.apple.com/search?media=music&limit=15&entity=' + entity + '&term=' + encodeURIComponent(term), { signal: AbortSignal.timeout(8000) });
    const j = res.ok ? await res.json() : {};
    return Array.isArray(j.results) ? j.results : [];
  }
  async function deezer(term) {
    const res = await fetch('https://api.deezer.com/search?limit=15&q=' + encodeURIComponent(term), { signal: AbortSignal.timeout(8000) });
    const j = res.ok ? await res.json() : {};
    return (Array.isArray(j.data) ? j.data : []).map((d) => ({
      trackName: d.title, artistName: d.artist && d.artist.name, collectionName: d.album && d.album.title,
      art: d.album && (d.album.cover_xl || d.album.cover_big)
    }));
  }
  async function lookUpCover(key, title, artist, album) {
    if (looking.has(key) || coverCache.has(key)) return;
    looking.add(key);
    try {
      const t = norm(title), a = norm(artist), al = norm(album);
      const artistOk = (r) => !a || norm(r.artistName).includes(a) || a.includes(norm(r.artistName));
      let url = null;
      // 1. The song itself
      const songs = await search([artist, title].filter(Boolean).join(' '), 'song');
      const score = (r) => (norm(r.trackName) === t ? 4 : norm(r.trackName).startsWith(t) || t.startsWith(norm(r.trackName)) ? 2 : 0) +
        (artistOk(r) ? 2 : 0) + (al && norm(r.collectionName) === al ? 1 : 0);
      const bestSong = songs.map((r) => [score(r), r]).sort((x, y) => y[0] - x[0])[0];
      if (bestSong && bestSong[0] >= 4) url = big(bestSong[1].artworkUrl100);
      // 1b. The song on Deezer (a second big catalog, no key needed)
      let dz = [];
      if (!url) {
        try { dz = await deezer([artist, title].filter(Boolean).join(' ')); } catch (_) { dz = []; }
        const bestDz = dz.map((r) => [score(r), r]).sort((x, y) => y[0] - x[0])[0];
        if (bestDz && bestDz[0] >= 4 && bestDz[1].art) url = bestDz[1].art;
      }
      // 2. The album
      if (!url && album) {
        const albums = await search([artist, album].filter(Boolean).join(' '), 'album');
        const hit = albums.find((r) => artistOk(r) && (norm(r.collectionName) === al || norm(r.collectionName).startsWith(al))) || albums.find(artistOk);
        if (hit) url = big(hit.artworkUrl100);
      }
      // 3. Something by the same artist (better than a blank square)
      if (!url && a) {
        const anyDz = dz.find((r) => artistOk(r) && r.art);
        const any = anyDz ? null : songs.find(artistOk) || (await search(artist, 'album')).find(artistOk);
        url = anyDz ? anyDz.art : any ? big(any.artworkUrl100) : null;
      }
      coverCache.set(key, url);
    } catch (_) {
      // offline: try again later
    } finally {
      looking.delete(key);
    }
  }

  // Album art is only sent when the song changes; remember it for later answers.
  async function run(cmd, prefer) {
    return shape(await send(cmd, prefer));
  }
  // The running game's volume (pct = null just reads it). -1 / null when its sound isn't found.
  async function gameVolume(pct, pids, dirs) {
    const payload = [pct == null ? 0 : Math.round(pct), (pids || []).filter((n) => n > 0).join(',')].concat((dirs || []).filter(Boolean)).join('|');
    const m = await send(pct == null ? 'gameget' : 'gamevol', payload);
    return typeof m.game === 'number' && m.game >= 0 ? m.game : null;
  }
  // Turns the helper's answer into what the guide shows (also used by tests).
  function shape(m) {
    if (m.error) throw new Error(m.error);
    if (m.none) return { none: true };
    if (m.art) art = { key: m.key, url: m.art };
    else if (art.key !== m.key) art = { key: m.key, url: null };
    // Apple Music puts "Artist — Album" in the artist field: split it.
    let artist = m.artist || '', album = m.album || '';
    const parts = artist.split(/\s+[—–]\s+/);
    if (parts.length > 1) { artist = parts[0]; if (!album) album = parts.slice(1).join(' — '); }
    let cover = art.url;
    if (!cover && m.title) {
      if (coverCache.get(m.key)) cover = coverCache.get(m.key);
      else lookUpCover(m.key, m.title, artist, album); // shows up on the next refresh
    }
    const volume = typeof m.volume === 'number' && m.volume >= 0 ? m.volume : null;
    return { app: m.app, title: m.title || '', artist, album, playing: !!m.playing, shuffle: !!m.shuffle, art: cover, volume };
  }

  function launch(app) {
    return new Promise((resolve, reject) => {
      if (app === 'Spotify') { require('electron').shell.openExternal('spotify:').then(resolve, () => reject(new Error('Spotify isn’t installed'))); return; }
      // Apple Music is a Store app: open it by its app ID (looked up in the Start menu, with the
      // published ID as a fallback).
      const ps = "$a = (Get-StartApps | Where-Object { $_.Name -like 'Apple Music*' } | Select-Object -First 1).AppID; if (-not $a) { $a = 'AppleInc.AppleMusicWin_nzyj5cx40ttqa!App' }; $a";
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 }, (err, out) => {
        const id = String(out || '').trim();
        if (err || !id) return reject(new Error('Apple Music isn’t installed'));
        execFile('explorer.exe', ['shell:AppsFolder\\' + id], { windowsHide: true }, () => resolve(true));
      });
    });
  }

  return { run, launch, stop, shape, gameVolume, _covers: coverCache };
}

module.exports = { createMedia };
