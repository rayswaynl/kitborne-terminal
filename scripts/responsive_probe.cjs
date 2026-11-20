#!/usr/bin/env node
'use strict';

// Standalone, read-only static layout evidence. CLI: node scripts/responsive_probe.cjs config.json
// Config: { root, minWidth, maxWidth, pages: ['index.html'], overlapPairs: [['#a','#b']], limits? }
// Pairs are the explicit allowlist of checks; no other overlap is considered a failure.
// Intervals are inclusive. Unknown intervals are never clean evidence or approval.
// maxWidths is a shared page/width measurement budget; skipped widths/pages are
// unknown. CLI exit 0 means complete evidence (which may contain failures), 2
// means incomplete/unavailable evidence, and 1 means invalid input.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const zlib = require('node:zlib');
const childProcess = require('node:child_process');
const loadPlaywright = require('../tests/playwright.cjs');

const CAPS = Object.freeze({ maxWidths: 4096, maxPages: 16, maxNodes: 20000,
  navigationTimeoutMs: 10000, overallTimeoutMs: 120000,
  maxResultBytes: 4 * 1024 * 1024, maxSampleBytes: 64 * 1024, maxDiagnosticBytes: 64 * 1024 });
const DEFAULTS = Object.freeze({ maxWidths: 2048, maxPages: 8, maxNodes: 10000,
  navigationTimeoutMs: 2000, overallTimeoutMs: 30000,
  maxResultBytes: 1024 * 1024, maxSampleBytes: 32 * 1024, maxDiagnosticBytes: 16 * 1024 });
const SECURITY = Object.freeze({ configBytes: 128 * 1024, identityChars: 128, classCount: 16,
  imageDimension: 2048, imagePixels: 1024 * 1024, aggregatePixels: 4 * 1024 * 1024,
  imageChunks: 1024, workerDataBytes: 512 * 1024 * 1024 });
const TYPES = { '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const CSP = "default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

// Lexical checks MUST precede realpath/lstat/open. Native filesystem APIs can
// perform SMB access independently of browser routing. Windows collection opens
// each component relative to a pinned local-volume handle, without reparse traversal.
function localPath(value, platform = process.platform) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f]/.test(value) ||
      /^[\\/]{2}/.test(value) || /^[\\/]/.test(value) && platform === 'win32' ||
      /:\/\//.test(value) || /^file:/i.test(value) || /^\\/.test(value) ||
      /^[a-z]:/i.test(value) && (platform !== 'win32' || !/^[a-z]:[\\/]/i.test(value))) {
    throw new Error('Local path policy: UNC, device, network and drive-relative paths are forbidden');
  }
  if (platform === 'win32' && (!/^[a-z]:[\\/]/i.test(value) || value.slice(2).includes(':'))) {
    throw new Error('Local path policy: require a local absolute drive path');
  }
  return value;
}

function confinedPath(root, target, platform = process.platform) {
  localPath(root, platform);
  localPath(target, platform);
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const relative = paths.relative(root, target);
  if (paths.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + paths.sep)) {
    throw new Error('Local path policy: resolved target escapes the static root');
  }
  return target;
}

async function readConfig(filename) {
  localPath(filename);
  if (process.platform === 'win32') {
    const value = await windowsCommand('config', filename, 10000);
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  }
  const before = await fs.lstat(filename);
  if (!before.isFile() || before.size > SECURITY.configBytes) throw new Error('Config byte budget exceeded or not a regular file');
  const flags = require('node:fs').constants;
  const handle = await fs.open(filename, flags.O_RDONLY | flags.O_NOFOLLOW | flags.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > SECURITY.configBytes || stat.ino !== before.ino || stat.dev !== before.dev) {
      throw new Error('Config byte budget exceeded, changed file or not a regular file');
    }
    const buffer = Buffer.alloc(SECURITY.configBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > SECURITY.configBytes) throw new Error('Config byte budget exceeded');
    return JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } finally { await handle.close(); }
}

// Only an audited subset of PNG is decoded. Other raster formats, APNG and SVG
// are unavailable evidence, never passed to Chromium's decoders. Dimensions,
// chunk structure/CRC and bounded inflate length are checked before serving.
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}
function pngPixels(content) {
  if (content.length < 45 || !content.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('Unsupported image content');
  let offset = 8, pixels = 0, rowBytes = 0, height = 0, chunks = 0, ended = false;
  const data = [];
  while (offset < content.length) {
    if (++chunks > SECURITY.imageChunks) throw new Error('PNG chunk budget exceeded');
    if (offset + 12 > content.length) throw new Error('Invalid PNG structure');
    const length = content.readUInt32BE(offset), end = offset + 12 + length;
    if (end > content.length) throw new Error('Invalid PNG chunk length');
    const type = content.toString('latin1', offset + 4, offset + 8);
    if (crc32(content.subarray(offset + 4, end - 4)) !== content.readUInt32BE(end - 4)) throw new Error('Invalid PNG checksum');
    if (type === 'IHDR' && offset === 8 && length === 13) {
      const width = content.readUInt32BE(offset + 8);
      height = content.readUInt32BE(offset + 12);
      pixels = width * height;
      if (!width || !height || width > SECURITY.imageDimension || height > SECURITY.imageDimension || pixels > SECURITY.imagePixels) throw new Error('Image pixel budget exceeded');
      const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[content[offset + 17]];
      if (content[offset + 16] !== 8 || !channels || content[offset + 18] || content[offset + 19] || content[offset + 20]) throw new Error('Unsupported PNG encoding');
      rowBytes = width * channels + 1;
    } else if (type === 'IDAT' && pixels && !ended) data.push(content.subarray(offset + 8, end - 4));
    else if (type === 'IEND' && length === 0 && pixels && data.length) { ended = true; if (end !== content.length) throw new Error('Trailing PNG content'); }
    else throw new Error('Unsupported PNG chunk/frame content');
    offset = end;
  }
  if (!ended) throw new Error('Incomplete PNG');
  const decoded = zlib.inflateSync(Buffer.concat(data), { maxOutputLength: rowBytes * height });
  if (decoded.length !== rowBytes * height) throw new Error('Invalid PNG decoded size');
  for (let row = 0; row < height; row++) if (decoded[row * rowBytes] > 4) throw new Error('Invalid PNG filter');
  return pixels;
}

function browserLaunchOptions(timeout, env = process.env) {
  return { headless: true, chromiumSandbox: true, host: '127.0.0.1', timeout,
    args: ['--disable-background-networking', '--no-proxy-server', '--renderer-process-limit=1',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
    ...(env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) };
}

const execFile = (file, args, options) => new Promise((resolve, reject) => {
  childProcess.execFile(file, args, options, (error, stdout, stderr) => {
    if (error) { error.stderr = String(stderr || '').trim().slice(0, 256); reject(error); }
    else resolve(stdout);
  });
});

// Windows has no Node O_NOFOLLOW equivalent. Use NT relative-handle opens on a
// whitelisted local disk device instead: no DOS device aliases, mapped drives,
// intermediate junctions or request-time path reopening can reach a network.
// Native helpers are generated in our temporary root, never the submitted root.
const WINDOWS_BRIDGE = String.raw`param([string]$Mode,[string]$Target)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -WarningAction SilentlyContinue -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public class ResponsiveNative {
 [StructLayout(LayoutKind.Sequential)] struct Unicode { public ushort Length, MaximumLength; public IntPtr Buffer; }
 [StructLayout(LayoutKind.Sequential)] struct Attributes { public int Length; public IntPtr RootDirectory, ObjectName; public uint Flags; public IntPtr Security, Quality; }
 [StructLayout(LayoutKind.Sequential)] struct Io { public IntPtr Status, Information; }
 [StructLayout(LayoutKind.Sequential)] struct Tag { public uint Attributes, ReparseTag; }
 [StructLayout(LayoutKind.Sequential)] struct Standard { public long Allocation, Size; public uint Links; public byte Deleted, Directory; }
 [StructLayout(LayoutKind.Sequential)] struct Identity { public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
 [StructLayout(LayoutKind.Sequential)] struct Basic { public long ProcessTime, JobTime; public uint Flags; public UIntPtr Min, Max; public uint Active; public UIntPtr Affinity; public uint Priority, Scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct Counters { public ulong Read, Write, Other, ReadBytes, WriteBytes, OtherBytes; }
 [StructLayout(LayoutKind.Sequential)] struct Limits { public Basic Basic; public Counters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob; }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Entry { public uint Size, Usage, Pid; public UIntPtr Heap; public uint Module, Threads, Parent; public int Priority; public uint Flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string Name; }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint QueryDosDevice(string name, StringBuilder buffer, int size);
 [DllImport("ntdll.dll")] static extern int NtCreateFile(out IntPtr handle, uint access, ref Attributes attributes, out Io io, IntPtr size, uint attr, uint share, uint disposition, uint options, IntPtr ea, uint length);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(IntPtr handle, int kind, IntPtr buffer, uint size);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetFileType(IntPtr handle);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr handle, out Identity identity);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr security, string name);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits info, uint size);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Limits info, uint size, IntPtr returned);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32First(IntPtr snapshot, ref Entry entry);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32Next(IntPtr snapshot, ref Entry entry);
 static Exception Failure(string message) { return new IOException(message + " (native " + Marshal.GetLastWin32Error() + ")"); }
 static T Info<T>(IntPtr handle, int kind) {
  int size = Marshal.SizeOf(typeof(T)); IntPtr buffer = Marshal.AllocHGlobal(size);
  try { if (!GetFileInformationByHandleEx(handle, kind, buffer, (uint)size)) throw Failure("Static descriptor unavailable"); return (T)Marshal.PtrToStructure(buffer, typeof(T)); }
  finally { Marshal.FreeHGlobal(buffer); }
 }
 static IntPtr Open(IntPtr parent, string name, bool directory) {
  IntPtr text = Marshal.StringToHGlobalUni(name), unicode = IntPtr.Zero;
  try {
   Unicode value = new Unicode { Length = checked((ushort)(name.Length * 2)), MaximumLength = checked((ushort)(name.Length * 2)), Buffer = text };
   unicode = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Unicode))); Marshal.StructureToPtr(value, unicode, false);
   Attributes attr = new Attributes { Length = Marshal.SizeOf(typeof(Attributes)), RootDirectory = parent, ObjectName = unicode, Flags = 0x40 };
   Io io; IntPtr handle;
   // SYNCHRONIZE | READ_DATA | READ_ATTRIBUTES; OPEN_REPARSE_POINT, synchronous,
   // and a required directory/non-directory type. Relative name is one component.
   int status = NtCreateFile(out handle, 0x100081, ref attr, out io, IntPtr.Zero, 0, 7, 1, (uint)(0x200020 | (directory ? 1 : 0x40)), IntPtr.Zero, 0);
   if (status < 0) throw new IOException("Static handle open failed: " + status);
   try { if (GetFileType(handle) != 1 || (Info<Tag>(handle, 9).Attributes & 0x400) != 0) throw new IOException("Static directory contains a symlink/reparse point or non-disk entry"); return handle; }
   catch { CloseHandle(handle); throw; }
  } finally { if (unicode != IntPtr.Zero) Marshal.FreeHGlobal(unicode); Marshal.FreeHGlobal(text); }
 }
 static IntPtr Local(string filename, bool directory) {
  if (filename.Length < 4 || filename[1] != ':' || filename[2] != '\\') throw new IOException("Local path policy");
  StringBuilder device = new StringBuilder(1024);
  if (QueryDosDevice(filename.Substring(0, 2), device, device.Capacity) == 0 || !System.Text.RegularExpressions.Regex.IsMatch(device.ToString(), @"^\\Device\\HarddiskVolume[0-9]+$")) throw new IOException("Local path policy: mapped/network/alias drive forbidden");
  string[] parts = filename.Substring(3).Split('\\');
  if (parts.Length > 64) throw new IOException("Local path depth limit");
  IntPtr current = Open(IntPtr.Zero, device.ToString() + "\\", true);
  try {
   for (int i = 0; i < parts.Length; i++) {
    string part = parts[i];
    if (part.Length == 0 || part == "." || part == ".." || part.IndexOfAny(new char[] { ':', '/', '\\' }) >= 0) throw new IOException("Local path policy");
    IntPtr next = Open(current, part, directory || i < parts.Length - 1); CloseHandle(current); current = next;
   }
   return current;
  } catch { CloseHandle(current); throw; }
 }
 static byte[] Read(IntPtr handle, int maximum) {
  Standard info = Info<Standard>(handle, 1);
  if (info.Directory != 0 || info.Size < 0 || info.Size > maximum) throw new IOException("Static resource byte limit or not a regular file");
  byte[] bytes = new byte[(int)info.Size + 1]; int length = 0;
  using (FileStream stream = new FileStream(new SafeFileHandle(handle, false), FileAccess.Read)) {
   while (length < bytes.Length) { int count = stream.Read(bytes, length, bytes.Length - length); if (count == 0) break; length += count; }
  }
  if (length != info.Size) throw new IOException("Static resource changed size");
  Array.Resize(ref bytes, length); return bytes;
 }
 public static string Config(string filename) {
  try { IntPtr file = Local(filename, false); try { return Convert.ToBase64String(Read(file, 131072)); } finally { CloseHandle(file); } }
  catch (IOException error) { throw new IOException("Config byte budget exceeded or not a regular file: " + error.Message); }
 }
 public class Resource { public string file; public string content; }
 int count, bytes; List<Resource> files = new List<Resource>();
 void Walk(IntPtr directory, string prefix, int depth) {
  if (depth > 16) throw new IOException("Static directory depth limit");
  IntPtr buffer = Marshal.AllocHGlobal(65536);
  try {
   bool first = true;
   while (true) {
    if (!GetFileInformationByHandleEx(directory, first ? 11 : 10, buffer, 65536)) { if (Marshal.GetLastWin32Error() == 18) break; throw Failure("Static enumeration unavailable"); }
    first = false; int offset = 0;
    do {
     IntPtr item = IntPtr.Add(buffer, offset); int length = Marshal.ReadInt32(item, 60), next = Marshal.ReadInt32(item);
     if (length < 0 || length > 510 || offset + 104 + length > 65536 || next < 0 || (next != 0 && next < 104)) throw new IOException("Static enumeration bounds");
     string name = Marshal.PtrToStringUni(IntPtr.Add(item, 104), length / 2);
     if (name != "." && name != "..") {
      if (++count > 256 || name.IndexOfAny(new char[] { '/', '\\', ':' }) >= 0) throw new IOException("Static entry limit/policy");
      uint attributes = unchecked((uint)Marshal.ReadInt32(item, 56));
      if ((attributes & 0x400) != 0) throw new IOException("Static directory contains a symlink/reparse point");
      bool isDirectory = (attributes & 16) != 0;
      if (isDirectory || System.Text.RegularExpressions.Regex.IsMatch(name, @"\.(html?|css|png|jpe?g|gif|webp|svg|woff2?)$", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) {
       IntPtr child = Open(directory, name, isDirectory);
       try {
        Identity identity;
        if (!GetFileInformationByHandle(child, out identity) || (((ulong)identity.IndexHigh << 32) | identity.IndexLow) != unchecked((ulong)Marshal.ReadInt64(item, 96))) throw new IOException("Static resource changed identity/confinement");
        if (!isDirectory && Info<Standard>(child, 1).Size != Marshal.ReadInt64(item, 40)) throw new IOException("Static resource changed size");
        if (isDirectory) Walk(child, prefix + name + "/", depth + 1);
        else { byte[] data = Read(child, 2097152); bytes += data.Length; if (bytes > 16777216) throw new IOException("Static resource byte limit"); files.Add(new Resource { file = prefix + name, content = Convert.ToBase64String(data) }); }
       } finally { CloseHandle(child); }
      }
     }
     if (next == 0) break; offset += next;
     if (offset > 65536 - 104) throw new IOException("Static enumeration bounds");
    } while (true);
   }
  } finally { Marshal.FreeHGlobal(buffer); }
 }
 public static Resource[] Snapshot(string root) { IntPtr directory = Local(root, true); try { ResponsiveNative probe = new ResponsiveNative(); probe.Walk(directory, "", 0); return probe.files.ToArray(); } finally { CloseHandle(directory); } }
 public static void Guard(uint root) {
  IntPtr job = CreateJobObject(IntPtr.Zero, null);
  if (job == IntPtr.Zero) throw Failure("Worker Job unavailable");
  try {
   Limits limits = new Limits(); limits.Basic.Flags = 0x100 | 0x2000; limits.ProcessMemory = new UIntPtr(536870912);
   uint size = (uint)Marshal.SizeOf(typeof(Limits)); Limits installed;
   if (!SetInformationJobObject(job, 9, ref limits, size) || !QueryInformationJobObject(job, 9, out installed, size, IntPtr.Zero) || installed.Basic.Flags != limits.Basic.Flags || installed.ProcessMemory != limits.ProcessMemory) throw Failure("Worker memory enforcement unavailable");
   HashSet<uint> assigned = new HashSet<uint>(); HashSet<uint> family = new HashSet<uint>(); family.Add(root);
   for (int pass = 0; pass < 4; pass++) {
    Dictionary<uint,uint> parents = new Dictionary<uint,uint>(); IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) throw Failure("Worker process snapshot unavailable");
    try { Entry entry = new Entry(); entry.Size = (uint)Marshal.SizeOf(typeof(Entry)); if (Process32First(snapshot, ref entry)) do { parents[entry.Pid] = entry.Parent; } while (Process32Next(snapshot, ref entry)); }
    finally { CloseHandle(snapshot); }
    bool changed; do { changed = false; foreach (KeyValuePair<uint,uint> pair in parents) if (family.Contains(pair.Value) && family.Add(pair.Key)) changed = true; if (family.Count > 64) throw new IOException("Worker process limit"); } while (changed);
    foreach (uint pid in family) if (!assigned.Contains(pid)) {
     IntPtr process = OpenProcess(0x101, false, pid);
     if (process == IntPtr.Zero) { if (pid == root) throw Failure("Worker process unavailable"); continue; }
     try { if (!AssignProcessToJobObject(job, process)) throw Failure("Worker Job assignment unavailable"); assigned.Add(pid); } finally { CloseHandle(process); }
    }
   }
   Console.WriteLine("READY"); Console.Out.Flush(); Console.ReadLine();
  } finally { CloseHandle(job); }
 }
}
'@
try {
 if ($Mode -eq 'guard') { [ResponsiveNative]::Guard([uint32]$Target) }
 elseif ($Mode -eq 'config') { [ResponsiveNative]::Config($Target) }
 elseif ($Mode -eq 'snapshot') { ConvertTo-Json -Compress -Depth 3 -InputObject @([ResponsiveNative]::Snapshot($Target)) }
 else { throw 'Unsupported native operation' }
} catch { [Console]::Error.WriteLine($_.Exception.GetBaseException().Message); exit 1 }
`;

async function windowsBridge() {
  const temporary = localPath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temporary, 'responsive-native-'));
  const filename = path.join(directory, 'boundary.ps1');
  try { await fs.writeFile(filename, WINDOWS_BRIDGE); }
  catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
  const executable = path.join(localPath(process.env.SystemRoot || 'C:\\Windows'), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return { directory, executable, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', filename] };
}

async function windowsCommand(mode, target, timeout) {
  // Validate the supplied spelling before normalizing only its separators.
  // Native component/volume/reparse checks still apply to the resulting path.
  target = localPath(target).replace(/\//g, '\\');
  const bridge = await windowsBridge();
  try { return await execFile(bridge.executable, [...bridge.args, mode, target], { timeout: Math.max(1, timeout), maxBuffer: 24 * 1024 * 1024, windowsHide: true }); }
  catch (error) { throw new Error(String(error.stderr || error.message).trim().slice(0, 256)); }
  finally { await fs.rm(bridge.directory, { recursive: true, force: true }); }
}

async function windowsGuard(pid, timeout) {
  const bridge = await windowsBridge();
  let child, closed;
  try {
    child = childProcess.spawn(bridge.executable, [...bridge.args, 'guard', String(pid)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    closed = new Promise(resolve => child.once('close', resolve));
    child.stdin.on('error', () => {});
    await new Promise((resolve, reject) => {
      let output = '', diagnostic = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('Worker memory enforcement timeout')); }, Math.max(1, timeout));
      const fail = error => { clearTimeout(timer); reject(error); };
      child.once('error', fail);
      child.once('close', () => fail(new Error('Worker memory enforcement unavailable: ' + diagnostic.slice(0, 256))));
      child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(0, 256); });
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.length > 256) { child.kill(); fail(new Error('Worker native output budget')); }
        else if (output.includes('READY')) { clearTimeout(timer); resolve(); }
      });
    });
    let cleanup;
    return { close: () => cleanup ||= (async () => { child.stdin.end(); await closed; await fs.rm(bridge.directory, { recursive: true, force: true }); })() };
  } catch (error) { if (child) { child.kill(); await closed; } await fs.rm(bridge.directory, { recursive: true, force: true }); throw error; }
}

async function ownedBrowserServer(options, deadline) {
  const child = childProcess.fork(__filename, ['--browser-worker'], {
    execArgv: ['--max-old-space-size=128'], serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  let guard, endpoint, cleanup, browserPid;
  const stop = () => cleanup ||= (async () => {
    if (child.connected) child.send({ close: true }, () => {});
    // Allow Playwright to reap normally, with an owned-tree kill fallback when
    // launch/close is pending. Never leave a browser worker beyond the cutoff.
    const fallback = setTimeout(() => {
      if (guard) void guard.close();
      if (process.platform === 'linux' && browserPid) {
        try { process.kill(-browserPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
      }
      child.kill('SIGKILL');
    }, 2000);
    try { await closed; if (guard) await guard.close(); }
    finally { clearTimeout(fallback); }
  })();
  const timer = setTimeout(() => { void stop(); }, Math.max(1, deadline - Date.now()));
  try {
    if (process.platform === 'win32') guard = await windowsGuard(child.pid, Math.max(1, deadline - Date.now()));
    endpoint = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => reject(new Error('Browser worker unavailable or overall cutoff')));
      child.on('message', message => {
        if (Number.isInteger(message.pid) && message.pid > 0 && !browserPid) { browserPid = message.pid; return; }
        if (message.error) reject(new Error(message.error));
        else if (typeof message.endpoint === 'string' && message.endpoint.length < 256 && new URL(message.endpoint).hostname === '127.0.0.1') resolve(message.endpoint);
        else reject(new Error('Browser worker endpoint unavailable'));
      });
      if (Date.now() >= deadline) { child.kill('SIGKILL'); reject(new Error('Overall cutoff')); return; }
      child.send({ options }, error => { if (error) reject(error); });
    });
    return { wsEndpoint: () => endpoint, close: async () => { clearTimeout(timer); await stop(); } };
  } catch (error) { clearTimeout(timer); await stop(); throw error; }
}

function integer(value, name, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${name} (1..${maximum})`);
  return value;
}

function validate(config) {
  if (!config || typeof config.root !== 'string' || !config.root || /:\/\//.test(config.root)) {
    throw new Error('Supply a local static directory root, never a URL');
  }
  localPath(config.root);
  const minWidth = integer(config.minWidth, 'minWidth', 4096);
  const maxWidth = integer(config.maxWidth, 'maxWidth', 4096);
  if (maxWidth < minWidth) throw new Error('maxWidth precedes minWidth');
  if (!Array.isArray(config.pages) || !config.pages.length || config.pages.length > 64) throw new Error('Supply 1..64 relative HTML pages');
  const pages = config.pages.map(file => {
    if (typeof file !== 'string' || file.length > 256 || file.includes('\\') || file.includes('%') || file.includes('?') || file.includes('#') ||
        file.startsWith('/') || file.split('/').some(p => !p || p === '.' || p === '..') || !/\.html?$/i.test(file)) {
      throw new Error('Pages must be confined relative HTML paths');
    }
    return file;
  });
  if (new Set(pages).size !== pages.length) throw new Error('Duplicate pages');
  if (!Array.isArray(config.overlapPairs) || config.overlapPairs.length > 64) throw new Error('Supply an explicit overlapPairs array (at most 64)');
  const overlapPairs = config.overlapPairs.map(pair => {
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some(s => typeof s !== 'string' || !s.trim() || s.length > 256) || pair[0] === pair[1]) {
      throw new Error('Each overlap pair needs two distinct selectors');
    }
    return [...pair];
  });
  const limits = { ...DEFAULTS };
  for (const [key, value] of Object.entries(config.limits || {})) {
    if (!Object.hasOwn(CAPS, key)) throw new Error(`Unknown limit ${key}`);
    limits[key] = integer(value, key, CAPS[key]);
  }
  if (limits.maxSampleBytes < 512) throw new Error('Sample byte budget must allow a 512-byte control result');
  if (limits.maxDiagnosticBytes < 2) throw new Error('Diagnostic byte budget must allow an empty array');
  return { root: path.resolve(config.root), minWidth, maxWidth, pages, overlapPairs, limits };
}

function appendWidth(intervals, width) {
  const last = intervals.at(-1);
  if (last && last[1] + 1 === width) last[1] = width;
  else intervals.push([width, width]);
}

// Snapshot only static resource types. No directory listing, arbitrary file serving,
// symlinks, request-time reads, scripts, or writes to the submitted directory.
async function snapshot(root, deadline) {
  localPath(root);
  if (root === path.parse(root).root) throw new Error('Root must be a confined directory');
  if (process.platform === 'win32') {
    const entries = JSON.parse(await windowsCommand('snapshot', root, deadline - Date.now()));
    const files = new Map();
    let aggregatePixels = 0;
    for (const entry of entries) {
      const content = Buffer.from(entry.content, 'base64'), type = TYPES[path.extname(entry.file).toLowerCase()];
      aggregatePixels += inspectResource(content, type);
      if (aggregatePixels > SECURITY.aggregatePixels) throw new Error('Aggregate image pixel budget exceeded');
      files.set('/' + entry.file.split('/').map(encodeURIComponent).join('/'), { content, type });
    }
    return files;
  }
  const resolvedRoot = confinedPath(root, await fs.realpath(root));
  if (resolvedRoot !== root || !(await fs.lstat(root)).isDirectory() || root === path.parse(root).root) {
    throw new Error('Root must be a real confined directory, without symlink aliases');
  }
  const files = new Map();
  let count = 0, bytes = 0, aggregatePixels = 0;
  async function walk(directory, depth) {
    if (depth > 16) throw new Error('Static directory depth limit');
    if (confinedPath(root, await fs.realpath(directory)) !== directory) throw new Error('Static directory changed confinement');
    const entries = await fs.opendir(directory);
    for await (const entry of entries) {
      if (Date.now() >= deadline) throw new Error('Overall cutoff');
      if (++count > 256) throw new Error('Static directory file limit');
      if (entry.isSymbolicLink()) throw new Error('Static directory contains a symlink');
      const filename = path.join(directory, entry.name);
      confinedPath(root, filename);
      if (entry.isDirectory()) await walk(filename, depth + 1);
      else if (entry.isFile() && TYPES[path.extname(entry.name).toLowerCase()]) {
        const stat = await fs.lstat(filename);
        if (!stat.isFile() || confinedPath(root, await fs.realpath(filename)) !== filename) throw new Error('Static resource changed confinement');
        if (stat.size > 2 * 1024 * 1024 || (bytes += stat.size) > 16 * 1024 * 1024) throw new Error('Static resource byte limit');
        // A concurrently replaced FIFO must not wait for a writer at open. Check
        // the opened descriptor's type before reading, as well as its identity.
        const flags = require('node:fs').constants;
        const handle = await fs.open(filename, flags.O_RDONLY | flags.O_NOFOLLOW | flags.O_NONBLOCK);
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev ||
              confinedPath(root, await fs.realpath(filename)) !== filename) {
            throw new Error('Static resource is not a regular file or changed confinement');
          }
          const buffer = Buffer.alloc(stat.size + 1);
          let length = 0;
          while (length < buffer.length) {
            const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
            if (!bytesRead) break;
            length += bytesRead;
          }
          if (length !== stat.size) throw new Error('Static resource changed size');
          const content = buffer.subarray(0, length);
          const type = TYPES[path.extname(filename).toLowerCase()];
          aggregatePixels += inspectResource(content, type);
          if (aggregatePixels > SECURITY.aggregatePixels) throw new Error('Aggregate image pixel budget exceeded');
          files.set('/' + path.relative(root, filename).split(path.sep).map(encodeURIComponent).join('/'),
            { content, type });
        } finally { await handle.close(); }
      } else if (!entry.isFile()) throw new Error('Non-static directory entry');
    }
  }
  await walk(root, 0);
  return files;
}

function inspectResource(content, type) {
  if (type.startsWith('image/')) {
    if (type !== 'image/png') throw new Error('Unsupported image format: only bounded single-frame PNG is supported');
    return pngPixels(content);
  }
  if (type === 'text/html' || type === 'text/css') {
    const text = content.toString('utf8');
    if (/data\s*:/i.test(text) || /<\s*(svg|math)\b/i.test(text)) throw new Error('Unsupported inline image/vector content');
  }
  return 0;
}

// Filesystem promises have no general abort facility. Collect in an owned child
// so the deadline covers pending realpath/opendir/open/read/close and PNG
// preflight/IPC, rather than merely racing a promise and leaving work alive.
// The existing 256-entry/16-MiB snapshot ceilings also bound the IPC payload.
async function collectSnapshot(root, deadline) {
  localPath(root);
  if (Date.now() >= deadline) throw new Error('Overall cutoff during static snapshot collection');
  return new Promise((resolve, reject) => {
    let child, guard, startup, files, error, received = false, expired = false;
    const timer = setTimeout(() => {
      expired = true;
      if (child) child.kill('SIGKILL');
      if (guard) void guard.close();
    }, Math.max(1, deadline - Date.now()));
    try {
      child = childProcess.fork(__filename, ['--snapshot-worker'], {
        execArgv: ['--max-old-space-size=128'], serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc']
      });
    } catch (failure) { clearTimeout(timer); reject(failure); return; }
    const fail = failure => { error = failure; child.kill('SIGKILL'); };
    child.once('error', fail);
    child.on('message', message => {
      if (received) { fail(new Error('Unexpected static snapshot response')); return; }
      received = true;
      if (message?.error) error = new Error(message.error);
      else if (message?.files instanceof Map) files = message.files;
      else fail(new Error('Unavailable static snapshot response'));
    });
    // Wait for exit and IPC closure on success, failure and cancellation. No
    // snapshot process or open descriptors are retained after this returns.
    child.once('close', async code => {
      clearTimeout(timer);
      await startup;
      if (guard) await guard.close();
      if (expired || Date.now() >= deadline) reject(new Error('Overall cutoff during static snapshot collection'));
      else if (error) reject(error);
      else if (code !== 0 || !files) reject(new Error('Static snapshot worker unavailable'));
      else resolve(files);
    });
    startup = (async () => {
      if (process.platform === 'win32') guard = await windowsGuard(child.pid, Math.max(1, deadline - Date.now()));
      if (expired || child.exitCode !== null || child.signalCode !== null) { if (guard) await guard.close(); return; }
      child.send({ root, deadline }, failure => { if (failure) fail(failure); });
    })().catch(fail);
  });
}

// Runs in a script-disabled document. Geometry is CSS-pixel axis-aligned DOM
// rectangles, not a claim about painted pixels, occlusion, or dynamic app states.
async function measure({ pairs, maxNodes, maxBytes, identityChars, classCount }) {
  await document.fonts.ready;
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
  const elements = [];
  while (walker.nextNode()) {
    if (elements.length >= maxNodes) return { reason: 'Node limit' };
    elements.push(walker.currentNode);
  }
  if (elements.some(el => ['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED'].includes(el.tagName) ||
      (el.tagName === 'META' && el.httpEquiv.toLowerCase() === 'refresh'))) {
    return { reason: 'Unsupported active content' };
  }
  const rect = r => ({ x: r.x, y: r.y, width: r.width, height: r.height });
  let usedBytes = 512;
  const charge = value => {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (usedBytes + bytes > maxBytes) throw new Error('Sample byte budget exceeded');
    usedBytes += bytes;
  };
  const identities = [], identityIndexes = new WeakMap();
  const identity = el => {
    if (identityIndexes.has(el)) return identityIndexes.get(el);
    const id = el.id;
    const rawClasses = el.getAttribute('class') || '';
    // Do not enumerate a potentially huge DOMTokenList or transfer its strings.
    const classes = rawClasses.slice(0, identityChars * classCount).trim().split(/\s+/).filter(Boolean)
      .slice(0, classCount).map(token => token.slice(0, identityChars));
    const value = { tag: el.tagName.toLowerCase().slice(0, identityChars), id: id.slice(0, identityChars) || null, classes,
      truncated: id.length > identityChars || rawClasses.length > identityChars * classCount || classes.some(token => token.length === identityChars) };
    charge(value);
    const index = identities.length;
    identities.push(value);
    identityIndexes.set(el, index);
    return index;
  };
  const visible = el => {
    for (let ancestor = el; ancestor; ancestor = ancestor.parentElement) {
      const s = getComputedStyle(ancestor);
      if (s.display === 'none' || s.visibility !== 'visible' || Number(s.opacity) === 0 || s.contentVisibility === 'hidden') return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const viewportWidth = innerWidth;
  const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0);
  const overlaps = [];
  const inspectPair = selectors => {
    let matches;
    try { matches = selectors.map(s => [...document.querySelectorAll(s)]); }
    catch { return { selectors, evidence: 'unavailable', reason: 'Invalid selector' }; }
    if (matches.some(m => m.length !== 1)) return { selectors, evidence: 'unavailable', reason: 'Missing or ambiguous selector' };
    const [a, b] = matches.map(m => m[0]);
    if (a === b) return { selectors, evidence: 'unavailable', reason: 'Selectors identify the same element' };
    if (!visible(a) || !visible(b)) return { selectors, evidence: 'unavailable', reason: 'Invisible selector' };
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const x = Math.max(ra.left, rb.left), y = Math.max(ra.top, rb.top);
    const width = Math.min(ra.right, rb.right) - x, height = Math.min(ra.bottom, rb.bottom) - y;
    return { selectors, evidence: 'measured', elements: [identity(a), identity(b)], rectangles: [rect(ra), rect(rb)],
      intersection: width > 0 && height > 0 ? { x, y, width, height } : null };
  };
  try {
    for (const selectors of pairs) {
      const overlap = inspectPair(selectors);
      charge(overlap);
      overlaps.push(overlap);
    }
  } catch { return { reason: 'Sample byte budget exceeded' }; }
  return { evidence: 'measured', nodeCount: elements.length, identities,
    overflow: { evidence: 'measured', failed: scrollWidth > viewportWidth, viewportWidth, scrollWidth }, overlaps };
}

async function probe(input) {
  const config = validate(input), started = Date.now(), deadline = started + config.limits.overallTimeoutMs;
  const result = { schema: 'responsive-probe/v1', evidence: 'unavailable', complete: false,
    geometry: 'static CSS-pixel axis-aligned rectangles; scripts disabled',
    evidenceKinds: { measured: 'Observed at this integer width', approximate: 'Partial geometry; not a clean result',
      unavailable: 'No measurement', incomplete: 'One or more requested checks are unknown' },
    range: [config.minWidth, config.maxWidth], limits: config.limits, security: SECURITY,
    identityFormat: 'sample.identities holds bounded identities; overlap.elements holds indexes into that table',
    workerMemory: 'Hard per-process RLIMIT_DATA (Linux) or Job Object memory limit (Windows), before document loading',
    pages: [], blockedRequests: [], reasons: [] };
  const unknownPage = page => ({ page, samples: [],
    overflow: { failureIntervals: [], unknownIntervals: [[config.minWidth, config.maxWidth]] },
    overlaps: config.overlapPairs.map(selectors => ({ selectors, failureIntervals: [], unknownIntervals: [[config.minWidth, config.maxWidth]] })) });
  let reserve = Buffer.byteLength(JSON.stringify(result)) + 1024;
  for (const page of config.pages) {
    reserve += Buffer.byteLength(JSON.stringify(unknownPage(page))) + 1024;
    if (reserve + 512 > config.limits.maxResultBytes) throw new Error('Result byte budget too small for requested metadata');
  }
  let resultBytes = reserve, diagnosticBytes = 2, diagnosticEvents = 0, budgetSpent = false;
  const diagnosticKeys = new Set();
  const recordDiagnostic = entry => {
    if (budgetSpent) return false;
    if (++diagnosticEvents > 256) { budgetSpent = true; return false; }
    const bounded = Object.fromEntries(Object.entries(entry).map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 256) : value]));
    const encoded = JSON.stringify(bounded), bytes = Buffer.byteLength(encoded) + 1;
    if (diagnosticKeys.has(encoded)) return true;
    if (diagnosticBytes + bytes > config.limits.maxDiagnosticBytes || resultBytes + bytes > config.limits.maxResultBytes) {
      budgetSpent = true; return false;
    }
    diagnosticKeys.add(encoded);
    diagnosticBytes += bytes;
    resultBytes += bytes;
    result.blockedRequests.push(bounded);
    return true;
  };
  const storeSample = (page, sample) => {
    // Reserve summary space as well as sample space. No attacker-controlled
    // object/string enters result accumulation without this bounded charge.
    const bytes = Buffer.byteLength(JSON.stringify(sample)) * 3;
    if (resultBytes + bytes > config.limits.maxResultBytes) { budgetSpent = true; return; }
    resultBytes += bytes;
    page.samples.push(sample);
  };
  let server, browserServer, browser, timer, expired = false, attempted = 0;
  const remaining = () => Math.max(1, deadline - Date.now());
  try {
    if (!['linux', 'win32'].includes(process.platform)) throw new Error('Local filesystem/worker memory enforcement unavailable on this platform');
    const files = await collectSnapshot(config.root, deadline);
    if (Date.now() >= deadline) throw new Error('Overall cutoff');
    server = http.createServer((request, response) => {
      // Requests only receive immutable confined resources; never redirects/downloads.
      const resource = files.get(request.url);
      response.writeHead(request.method === 'GET' && resource ? 200 : 404, {
        'Content-Type': resource?.type || 'text/plain', 'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
      response.end(request.method === 'GET' && resource ? resource.content : 'Blocked');
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const { chromium } = loadPlaywright();
    browserServer = await ownedBrowserServer(browserLaunchOptions(remaining()), deadline);
    timer = setTimeout(() => { expired = true; void browserServer.close().catch(() => {}); }, remaining());
    browser = await chromium.connect({ wsEndpoint: browserServer.wsEndpoint(), timeout: remaining() });
    for (const [pageIndex, filename] of config.pages.entries()) {
      const pageResult = { page: filename, samples: [] };
      result.pages.push(pageResult);
      if (pageIndex >= config.limits.maxPages || expired || budgetSpent || Date.now() >= deadline) continue;
      const pathname = '/' + filename.split('/').map(encodeURIComponent).join('/');
      if (!files.has(pathname)) { result.reasons.push(`Missing static page: ${filename}`); continue; }
      for (let width = config.minWidth; width <= config.maxWidth; width++) {
        const sampleBudget = Math.min(config.limits.maxSampleBytes, Math.floor((config.limits.maxResultBytes - resultBytes) / 3));
        if (sampleBudget < 512) budgetSpent = true;
        if (attempted >= config.limits.maxWidths || expired || budgetSpent || Date.now() >= deadline) break;
        attempted++;
        let blocked = false;
        const diagnostic = entry => { blocked = true; return recordDiagnostic({ page: filename, width, ...entry }); };
        let context;
        try {
          context = await browser.newContext({ viewport: { width, height: 900 }, javaScriptEnabled: false,
            serviceWorkers: 'block', acceptDownloads: false });
          let navigationAllowed = true;
          await context.route('**/*', async route => {
            const request = route.request();
            const url = new URL(request.url());
            const main = request.isNavigationRequest();
            const resource = files.get(url.pathname);
            const allowed = url.origin === origin && !url.search && request.method() === 'GET' &&
              resource && (request.resourceType() !== 'image' || resource.type === 'image/png') && !request.redirectedFrom() &&
              (!main || (navigationAllowed && url.pathname === pathname));
            if (!allowed) {
              diagnostic({ url: request.url(), reason: main ? 'Navigation/redirect blocked' : 'Resource blocked' });
              await route.abort('blockedbyclient');
            } else {
              if (main) navigationAllowed = false;
              const file = files.get(url.pathname);
              await route.fulfill({ status: 200, headers: { 'Content-Type': file.type,
                'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' }, body: file.content });
            }
          });
          const page = await context.newPage();
          page.on('console', message => {
            if (/content security policy/i.test(message.text())) {
              if (!diagnostic({ reason: 'Resource blocked by content security policy', detail: message.text().slice(0, 256) })) {
                void context.close().catch(() => {});
              }
            }
          });
          page.on('download', download => { diagnostic({ reason: 'Download blocked' }); void download.cancel().catch(() => {}); });
          await page.goto(origin + pathname, { waitUntil: 'load', timeout: Math.min(config.limits.navigationTimeoutMs, remaining()) });
          const sample = await page.evaluate(measure, { pairs: config.overlapPairs, maxNodes: config.limits.maxNodes,
            maxBytes: sampleBudget, identityChars: SECURITY.identityChars, classCount: SECURITY.classCount });
          if (sample.reason?.includes('byte budget')) budgetSpent = true;
          if (sample.reason || blocked || page.url() !== origin + pathname) {
            storeSample(pageResult, { width, evidence: sample.reason ? 'unavailable' : 'approximate',
              reason: sample.reason || 'Blocked request or navigation; static layout incomplete',
              ...(sample.reason ? {} : { partialGeometry: sample }) });
          } else storeSample(pageResult, { width, ...sample });
        } catch (error) {
          storeSample(pageResult, { width, evidence: 'unavailable', reason: expired ? 'Overall cutoff' : error.message.split('\n')[0].slice(0, 256) });
        } finally {
          if (context) await context.close().catch(() => {});
          const last = pageResult.samples.at(-1);
          if (blocked && last?.width === width && last.evidence === 'measured') {
            last.evidence = 'approximate';
            last.reason = 'Blocked resource; static layout incomplete';
          }
        }
      }
    }
  } catch (error) { result.reasons.push(error.message.split('\n')[0].slice(0, 256)); }
  finally {
    clearTimeout(timer);
    if (browser) await browser.close().catch(() => {});
    if (browserServer) await browserServer.close().catch(() => {});
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
  let measured = 0, unknown = 0;
  // Fill *every* requested width, including skipped pages and startup failures.
  for (const filename of config.pages) {
    let page = result.pages.find(p => p.page === filename);
    if (!page) { page = { page: filename, samples: [] }; result.pages.push(page); }
    const samples = new Map(page.samples.map(s => [s.width, s]));
    const overflowFailures = [], overflowUnknown = [];
    const pairs = config.overlapPairs.map(selectors => ({ selectors, failureIntervals: [], unknownIntervals: [] }));
    for (let width = config.minWidth; width <= config.maxWidth; width++) {
      const sample = samples.get(width);
      const known = sample?.evidence === 'measured';
      if (known) { measured++; if (sample.overflow.failed) appendWidth(overflowFailures, width); }
      else { unknown++; appendWidth(overflowUnknown, width); }
      for (const [index, pair] of pairs.entries()) {
        const overlap = known && sample.overlaps[index];
        if (!overlap || overlap.evidence !== 'measured') { appendWidth(pair.unknownIntervals, width); unknown++; }
        else if (overlap.intersection) appendWidth(pair.failureIntervals, width);
      }
    }
    page.overflow = { failureIntervals: overflowFailures, unknownIntervals: overflowUnknown };
    page.overlaps = pairs;
  }
  result.complete = unknown === 0;
  if (attempted >= config.limits.maxWidths && !result.complete) result.reasons.push('Width budget exhausted');
  if (config.pages.length > config.limits.maxPages) result.reasons.push('Page limit');
  if (expired || Date.now() >= deadline) result.reasons.push('Overall cutoff');
  if (budgetSpent) result.reasons.push('Result/sample/diagnostic byte budget exhausted');
  result.evidence = result.complete ? 'measured' : measured ? 'incomplete' :
    result.pages.some(page => page.samples.some(sample => sample.evidence === 'approximate')) ? 'approximate' : 'unavailable';
  result.attemptedWidths = attempted;
  result.elapsedMs = Date.now() - started;
  // This final serialization is bounded by charged samples and reserved metadata.
  // A compact fail-closed fallback protects against future summary schema growth.
  if (Buffer.byteLength(JSON.stringify(result)) + 1 > config.limits.maxResultBytes) {
    result.pages = config.pages.map(unknownPage);
    result.blockedRequests = [];
    result.reasons = ['Result byte budget exhausted'];
    result.complete = false;
    result.evidence = 'incomplete';
  }
  return result;
}

module.exports = { probe, CAPS, SECURITY, localPath, confinedPath, readConfig, pngPixels, browserLaunchOptions };
if (require.main === module && process.argv[2] === '--browser-worker' && process.send) {
  let server, launching, closing = false;
  const close = async () => { closing = true; if (launching) await launching.catch(() => {}); if (server) await server.kill().catch(() => {}); process.exit(0); };
  process.on('disconnect', () => { void close(); });
  process.on('message', async message => {
    if (message.close) { void close(); return; }
    const spawn = childProcess.spawn;
    try {
      if (process.platform === 'linux') {
        // Only this disposable worker's spawn boundary is wrapped. Playwright's
        // executablePath remains verbatim; the browser inherits its hard cap
        // before startup, and shared application/test process APIs are untouched.
        childProcess.spawn = (file, args, options) => {
          if (!options.detached) throw new Error('Worker process group isolation unavailable');
          const child = spawn('/usr/bin/prlimit', [`--data=${SECURITY.workerDataBytes}:${SECURITY.workerDataBytes}`, '--', file, ...args], options);
          process.send({ pid: child.pid });
          return child;
        };
      }
      launching = loadPlaywright().chromium.launchServer(message.options);
      server = await launching;
      if (closing) { await close(); return; }
      process.send({ endpoint: server.wsEndpoint() });
    } catch (error) { process.send({ error: error.message.split('\n')[0].slice(0, 256) }, () => process.exit(1)); }
    finally { childProcess.spawn = spawn; }
  });
} else if (require.main === module && process.argv[2] === '--snapshot-worker' && process.send) {
  // Private IPC entry, never an input/config option. Kill on parent disconnect
  // as well, so an interrupted CLI does not strand collection work.
  process.on('disconnect', () => process.exit(1));
  process.once('message', async ({ root, deadline }) => {
    let response;
    try {
      if (!['linux', 'win32'].includes(process.platform) || !Number.isFinite(deadline) || deadline > Date.now() + CAPS.overallTimeoutMs) {
        throw new Error('Static snapshot worker unavailable');
      }
      response = { files: await snapshot(root, deadline) };
    } catch (error) { response = { error: error.message.slice(0, 256) }; }
    process.send(response, error => process.exit(error ? 1 : 0));
  });
} else if (require.main === module) {
  (async () => {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/responsive_probe.cjs config.json');
    const result = await probe(await readConfig(process.argv[2]));
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.complete ? 0 : 2;
  })().catch(error => { process.stderr.write(error.message.slice(0, 256) + '\n'); process.exitCode = 1; });
}
