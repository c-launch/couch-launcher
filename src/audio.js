'use strict';
// Sound output (guide › Profile & system › Sound): which device plays the sound (TV, headset,
// soundbar…), and its volume / mute, from the controller.
// Windows' own audio system (Core Audio) is used through a small PowerShell helper that keeps
// running, the same way the music controls work. Switching sets the default device for
// everything (games, apps and calls), like picking it in the taskbar's sound menu.

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
function Say($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush() }
try {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
namespace CouchOutputs {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom {}
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
  }
  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int Item(int index, out IMMDevice device);
  }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore store);
    [PreserveSig] int GetId(out IntPtr id);
    [PreserveSig] int GetState(out int state);
  }
  [StructLayout(LayoutKind.Sequential)] struct PropertyKey { public Guid fmtid; public int pid; public PropertyKey(Guid f, int p) { fmtid = f; pid = p; } }
  [StructLayout(LayoutKind.Sequential)] struct PropVariant { public ushort vt; public ushort r1; public ushort r2; public ushort r3; public IntPtr p; public IntPtr p2; }
  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetAt(int index, out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
  }
  [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
    [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
    [PreserveSig] int GetChannelCount(out int count);
    [PreserveSig] int SetMasterVolumeLevel(float level, ref Guid ctx);
    [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
    [PreserveSig] int GetMasterVolumeLevel(out float level);
    [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
    [PreserveSig] int SetChannelVolumeLevel(uint channel, float level, ref Guid ctx);
    [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid ctx);
    [PreserveSig] int GetChannelVolumeLevel(uint channel, out float level);
    [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }
  // Windows' own (undocumented, stable since Windows 7) way to change the default device.
  [ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")] class PolicyConfigCom {}
  [ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPolicyConfig {
    [PreserveSig] int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr format);
    [PreserveSig] int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id, int def, IntPtr format);
    [PreserveSig] int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id);
    [PreserveSig] int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr a, IntPtr b);
    [PreserveSig] int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string id, int def, IntPtr a, IntPtr b);
    [PreserveSig] int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr a);
    [PreserveSig] int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr mode);
    [PreserveSig] int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr mode);
    [PreserveSig] int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr key, IntPtr value);
    [PreserveSig] int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr key, IntPtr value);
    [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
  }
  public class Output { public string id; public string name; public string device; public string adapter; public int form; public bool isDefault; }
  public static class Outputs {
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant v);
    static readonly Guid NameSet = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");
    static readonly Guid AdapterSet = new Guid("026e516e-b814-414b-83cd-856d6fef4822");
    static readonly Guid FormSet = new Guid("1da5d803-d492-4edd-8c23-e0c0ffee7f0e");
    static IMMDeviceEnumerator En() { return (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom()); }
    static string Text(IPropertyStore ps, Guid set, int pid) {
      var k = new PropertyKey(set, pid); PropVariant v;
      if (ps.GetValue(ref k, out v) != 0) return "";
      try { return v.vt == 31 && v.p != IntPtr.Zero ? (Marshal.PtrToStringUni(v.p) ?? "") : ""; } finally { PropVariantClear(ref v); }
    }
    static int Number(IPropertyStore ps, Guid set, int pid) {
      var k = new PropertyKey(set, pid); PropVariant v;
      if (ps.GetValue(ref k, out v) != 0) return 0;
      try { return v.vt == 19 ? (int)(v.p.ToInt64() & 0xffffffffL) : 0; } finally { PropVariantClear(ref v); }
    }
    static string IdOf(IMMDevice d) {
      IntPtr p; if (d.GetId(out p) != 0 || p == IntPtr.Zero) return "";
      try { return Marshal.PtrToStringUni(p) ?? ""; } finally { Marshal.FreeCoTaskMem(p); }
    }
    static string DefaultId() {
      IMMDevice d; if (En().GetDefaultAudioEndpoint(0, 1, out d) != 0 || d == null) return "";
      return IdOf(d);
    }
    public static Output[] List() {
      var list = new List<Output>();
      IntPtr colPtr;
      if (En().EnumAudioEndpoints(0, 1, out colPtr) != 0 || colPtr == IntPtr.Zero) return list.ToArray(); // speakers etc., active ones
      var col = (IMMDeviceCollection)Marshal.GetObjectForIUnknown(colPtr);
      Marshal.Release(colPtr);
      string def = DefaultId();
      int n; col.GetCount(out n);
      for (int i = 0; i < n; i++) {
        IMMDevice d; if (col.Item(i, out d) != 0 || d == null) continue;
        IPropertyStore ps; if (d.OpenPropertyStore(0, out ps) != 0 || ps == null) continue;
        var o = new Output();
        o.id = IdOf(d);
        o.name = Text(ps, NameSet, 14);   // "Speakers (Realtek Audio)"
        o.device = Text(ps, NameSet, 2);  // "Speakers"
        o.adapter = Text(ps, AdapterSet, 2); // "Realtek Audio"
        o.form = Number(ps, FormSet, 0);  // 1 speakers, 3 headphones, 5 headset, 9 TV / monitor (HDMI) …
        o.isDefault = o.id == def;
        list.Add(o);
      }
      return list.ToArray();
    }
    public static bool SetDefault(string id) {
      var pc = (IPolicyConfig)(new PolicyConfigCom());
      int a = pc.SetDefaultEndpoint(id, 0), b = pc.SetDefaultEndpoint(id, 1), c = pc.SetDefaultEndpoint(id, 2); // console, multimedia, communications
      return a == 0 || b == 0;
    }
    static IAudioEndpointVolume Vol() {
      IMMDevice d; if (En().GetDefaultAudioEndpoint(0, 1, out d) != 0 || d == null) return null;
      Guid iid = typeof(IAudioEndpointVolume).GUID; object o;
      if (d.Activate(ref iid, 23, IntPtr.Zero, out o) != 0 || o == null) return null;
      return (IAudioEndpointVolume)o;
    }
    public static int GetVolume() { var v = Vol(); float x; return v != null && v.GetMasterVolumeLevelScalar(out x) == 0 ? (int)Math.Round(x * 100) : -1; }
    public static int SetVolume(int pct) { var v = Vol(); if (v == null) return -1; Guid g = Guid.Empty; v.SetMasterVolumeLevelScalar(Math.Max(0, Math.Min(100, pct)) / 100f, ref g); return GetVolume(); }
    public static int GetMute() { var v = Vol(); bool m; return v != null && v.GetMute(out m) == 0 ? (m ? 1 : 0) : -1; }
    public static int SetMute(bool on) { var v = Vol(); if (v == null) return -1; Guid g = Guid.Empty; v.SetMute(on, ref g); return GetMute(); }
  }
}
'@
} catch { Say @{ error = 'Sound settings aren''t available: ' + $_.Exception.Message }; exit 1 }
function State() {
  $list = @([CouchOutputs.Outputs]::List() | ForEach-Object { @{ id = $_.id; name = $_.name; device = $_.device; adapter = $_.adapter; form = $_.form; isDefault = $_.isDefault } })
  return @{ outputs = $list; volume = [CouchOutputs.Outputs]::GetVolume(); muted = ([CouchOutputs.Outputs]::GetMute() -eq 1) }
}
Say @{ ready = $true }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  try {
    $parts = $line.Split(' ', 2)
    $cmd = $parts[0]; $arg = if ($parts.Length -gt 1) { $parts[1] } else { '' }
    if ($cmd -eq 'set') { [void][CouchOutputs.Outputs]::SetDefault($arg) }
    elseif ($cmd -eq 'vol') { [void][CouchOutputs.Outputs]::SetVolume([int]$arg) }
    elseif ($cmd -eq 'mute') { [void][CouchOutputs.Outputs]::SetMute($arg -eq '1') }
    Say (State)
  } catch { Say @{ error = $_.Exception.Message } }
}
`;

// What kind of output it is (for its icon): Windows' "form factor", else the name.
function kindOf(o) {
  const n = String((o && (o.name || o.device)) || '').toLowerCase();
  const f = Number(o && o.form) || 0;
  if (f === 3 || f === 5 || /head(set|phone)|earbud|airpods|buds|arctis|kraken|hyperx|cloud|wh-|xm\d/.test(n)) return 'headset';
  if (f === 9 || /\btv\b|hdmi|display audio|nvidia high definition|amd high definition|intel\(r\) display|lg |samsung|sony|vizio|tcl|hisense|monitor/.test(n)) return 'tv';
  if (/soundbar|sound bar|sonos|bose|vizio sb|jbl bar/.test(n)) return 'soundbar';
  return 'speaker';
}
// A short name: the device's own ("Speakers", "LG TV") plus the hardware when that's the only
// way to tell two apart.
function labelsOf(outputs) {
  const list = (outputs || []).map((o) => Object.assign({}, o, { kind: kindOf(o), label: (o.device || o.name || 'Output').trim() }));
  const count = new Map();
  for (const o of list) count.set(o.label.toLowerCase(), (count.get(o.label.toLowerCase()) || 0) + 1);
  for (const o of list) {
    if (count.get(o.label.toLowerCase()) > 1 && o.adapter) o.label += ' · ' + o.adapter;
    o.sub = o.adapter && !o.label.includes(o.adapter) ? o.adapter : '';
  }
  return list;
}

// Mac: volume and mute through AppleScript; the outputs from system_profiler. Switching the
// output needs SwitchAudioSource (brew install switchaudio-osx), which macOS doesn't include.
function parseProfiler(json) {
  let d; try { d = JSON.parse(json); } catch (_) { return []; }
  const out = [];
  for (const grp of (d && d.SPAudioDataType) || []) {
    for (const it of (grp && grp._items) || []) {
      if (!it || !it.coreaudio_device_output) continue;
      const transport = String(it.coreaudio_device_transport || '');
      out.push({ id: String(it._name || ''), name: String(it._name || 'Output'), isDefault: it.coreaudio_default_audio_output_device === 'spaudio_yes',
        form: /hdmi|displayport/i.test(transport) ? 9 : 0 });
    }
  }
  return out.filter((o) => o.id);
}
function parseSwitchAudio(text, current) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let name = t;
    if (t.charAt(0) === '{') { try { const o = JSON.parse(t); if (o.type && o.type !== 'output') continue; name = String(o.name || ''); } catch (_) { continue; } }
    if (name && !out.some((o) => o.id === name)) out.push({ id: name, name, isDefault: name === current });
  }
  return out;
}
function createMacAudio(opts) {
  const ex = opts.execFile || execFile;
  const has = opts.exists || ((f) => { try { return fs.existsSync(f); } catch (_) { return false; } });
  const run = (cmd, args, ms) => new Promise((resolve, reject) => ex(cmd, args, { timeout: ms || 8000 }, (e, out) => (e ? reject(e) : resolve(String(out || '')))));
  const osa = (lines) => run('/usr/bin/osascript', [].concat(...lines.map((l) => ['-e', l])));
  const sas = () => ['/opt/homebrew/bin/SwitchAudioSource', '/usr/local/bin/SwitchAudioSource'].find(has) || null;
  let cache = null, cacheAt = 0;
  async function outputs(fresh) {
    if (!fresh && cache && Date.now() - cacheAt < 15000) return cache;
    const tool = sas();
    let list = [];
    if (tool) {
      try {
        const cur = (await run(tool, ['-c', '-t', 'output'])).trim();
        list = parseSwitchAudio(await run(tool, ['-a', '-t', 'output']), cur);
      } catch (_) { list = []; }
    }
    if (!list.length) { try { list = parseProfiler(await run('/usr/sbin/system_profiler', ['SPAudioDataType', '-json'], 15000)); } catch (_) { list = []; } }
    cache = labelsOf(list); cacheAt = Date.now();
    return cache;
  }
  async function state(fresh) {
    const [outs, vol] = await Promise.all([outputs(fresh), osa(['set s to get volume settings', 'return ((output volume of s) as text) & "," & ((output muted of s) as text)']).catch(() => '')]);
    const [v, m] = String(vol).trim().split(',');
    const volume = /^\d+$/.test(v || '') ? Number(v) : -1;
    return { outputs: outs, volume, muted: m === 'true', current: outs.find((o) => o.isDefault) || outs[0] || null };
  }
  return {
    state: () => state(false),
    async setOutput(id) {
      const tool = sas();
      if (!tool) throw new Error('To switch sound from here, install SwitchAudioSource (brew install switchaudio-osx). Or use Control Center › Sound.');
      const outs = await outputs(true);
      if (!outs.some((o) => o.id === String(id))) throw new Error('That sound output isn’t there any more');
      await run(tool, ['-t', 'output', '-s', String(id)]);
      return state(true);
    },
    async setVolume(v) { await osa(['set volume output volume ' + Math.max(0, Math.min(100, Math.round(Number(v) || 0)))]); return state(false); },
    async setMute(on) { await osa(['set volume output muted ' + (on ? 'true' : 'false')]); return state(false); },
    stop() {}
  };
}

function createAudio(userDataDir, opts) {
  opts = opts || {};
  const spawnFn = opts.spawn || spawn;
  const platform = opts.platform || process.platform;
  if (platform === 'darwin') return createMacAudio(opts);
  let proc = null, buf = '', waiters = [], starting = null;

  function stop() {
    if (proc) { try { proc.kill(); } catch (_) { /* gone */ } }
    proc = null; buf = '';
    while (waiters.length) waiters.shift().reject(new Error('Sound helper stopped'));
  }
  function start() {
    if (platform !== 'win32') return Promise.reject(new Error('Sound settings need Windows'));
    if (proc) return Promise.resolve();
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      const file = path.join(userDataDir, 'audio-helper.ps1');
      try { fs.mkdirSync(userDataDir, { recursive: true }); fs.writeFileSync(file, SCRIPT); } catch (e) { starting = null; return reject(e); }
      proc = spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      proc.stdout.setEncoding('utf8');
      let first = true;
      proc.stdout.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
          if (first) { first = false; starting = null; if (msg.error) { stop(); reject(new Error(msg.error)); } else resolve(); continue; }
          const w = waiters.shift();
          if (w) w.resolve(msg);
        }
      });
      proc.on('exit', () => { const was = starting; proc = null; starting = null; if (was && first) reject(new Error('Sound helper couldn’t start')); while (waiters.length) waiters.shift().reject(new Error('Sound helper stopped')); });
      proc.on('error', (e) => { starting = null; reject(e); });
      setTimeout(() => { if (first) { stop(); starting = null; reject(new Error('Sound helper took too long to start')); } }, 20000);
    });
    return starting;
  }
  async function send(line) {
    await start();
    const msg = await new Promise((resolve, reject) => {
      const t = setTimeout(() => { stop(); reject(new Error('Windows didn’t answer about sound')); }, 8000);
      waiters.push({ resolve: (m) => { clearTimeout(t); resolve(m); }, reject: (e) => { clearTimeout(t); reject(e); } });
      proc.stdin.write(line + '\n');
    });
    if (msg.error) throw new Error(msg.error);
    const outputs = labelsOf(Array.isArray(msg.outputs) ? msg.outputs : msg.outputs ? [msg.outputs] : []);
    return { outputs, volume: typeof msg.volume === 'number' ? msg.volume : -1, muted: !!msg.muted, current: outputs.find((o) => o.isDefault) || null };
  }
  let known = new Set();
  return {
    state: () => send('list').then((s) => { known = new Set(s.outputs.map((o) => o.id)); return s; }),
    // Only devices it listed (the id goes to Windows as is).
    async setOutput(id) {
      id = String(id || '');
      if (!known.has(id)) { const s = await send('list'); known = new Set(s.outputs.map((o) => o.id)); if (!known.has(id)) throw new Error('That sound output isn’t there any more'); }
      if (/[\r\n]/.test(id)) throw new Error('Unknown sound output');
      return send('set ' + id);
    },
    setVolume: (v) => send('vol ' + Math.max(0, Math.min(100, Math.round(Number(v) || 0)))),
    setMute: (on) => send('mute ' + (on ? 1 : 0)),
    stop
  };
}

module.exports = { createAudio, kindOf, labelsOf, SCRIPT, parseProfiler, parseSwitchAudio };
