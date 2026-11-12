// Scheduling priority for Lilin's own processes. Playback comes first: the server process runs a
// step above normal for the CPU, and on Windows at normal I/O and memory priority even when it was
// started as a scheduled task (Task Scheduler's default gives it low I/O priority, and its stream
// reads then lose to every download: measured on a busy hard drive, 4 MB reads took 3.9 s instead
// of 0.18 s and players stalled 15 times in two minutes). Background jobs (conversions, browser
// copies, timeline previews, credits, subtitle sync, clip and note copies, OCR) run below normal for
// the CPU. Their I/O priority stays normal by default: with streams reading in large pieces that was
// enough for smooth playback, and low I/O priority made a conversion 3-4x slower while anyone watched.
//
//   LILIN_PRIORITY      above_normal (default) | normal | high — the server process itself
//   BACKGROUND_PRIORITY   below_normal (default) | idle | normal — CPU priority of background jobs
//   BACKGROUND_IO         normal (default) | low | very_low — I/O + memory priority of background jobs (Windows)
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const P = os.constants.priority;
const CPU = { idle: P.PRIORITY_LOW, below_normal: P.PRIORITY_BELOW_NORMAL, normal: P.PRIORITY_NORMAL, above_normal: P.PRIORITY_ABOVE_NORMAL, high: P.PRIORITY_HIGH };
const pick = (value, fallback) => String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_') || fallback;
const IO = { very_low: 0, low: 1, normal: 2 };           // Windows IO_PRIORITY_HINT
const PAGE = { very_low: 1, low: 2, normal: 5 };         // Windows memory (page) priority, 5 = default

// The server process: raise it once at startup. Raising above normal needs no special rights on
// Windows; on Linux/macOS it usually does, so failures are quietly ignored there.
// On Windows its I/O and memory priority go back to normal too: a server started as a scheduled task
// inherits Task Scheduler's default (low I/O, low memory priority), and its stream reads then queue
// behind every other program's, downloads included.
export function raiseServer() {
  if (process.platform === 'win32') ioHelper()?.set(process.pid, IO.normal, PAGE.normal);
  const level = pick(process.env.LILIN_PRIORITY, 'above_normal');
  if (!(level in CPU) || level === 'normal') return null;
  try { os.setPriority(0, CPU[level]); return level; } catch { return null; }
}

// A background job: lower its CPU priority now and set its I/O + memory priority as soon as the
// helper has done it (a few milliseconds; the helper starts with the server).
export function background(child) {
  if (!child?.pid) return;
  const level = pick(process.env.BACKGROUND_PRIORITY, 'below_normal');
  if (level in CPU && level !== 'normal') { try { os.setPriority(child.pid, CPU[level]); } catch { /* exited or not allowed */ } }
  const io = pick(process.env.BACKGROUND_IO, 'normal');
  // Set even when normal, so a job never inherits a low I/O priority from how Lilin was started.
  if (process.platform === 'win32' && io in IO) ioHelper()?.set(child.pid, IO[io], PAGE[io]);
}

// ---- Windows: one small PowerShell process that sets I/O and page priority for process IDs ----
// (Node has no API for it; NtSetInformationProcess lowers either without admin rights.)
const HELPER = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class LilinPrio {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("ntdll.dll")] static extern int NtSetInformationProcess(IntPtr h, int cls, ref int info, int len);
  public static string Set(int pid, int io, int page) {
    IntPtr h = OpenProcess(0x0200 | 0x1000, false, pid); // PROCESS_SET_INFORMATION | QUERY_LIMITED
    if (h == IntPtr.Zero) return "err " + pid + " open " + Marshal.GetLastWin32Error();
    int a = NtSetInformationProcess(h, 33, ref io, 4);   // ProcessIoPriority
    int b = NtSetInformationProcess(h, 39, ref page, 4); // ProcessPagePriority
    CloseHandle(h);
    return (a == 0 && b == 0 ? "ok " : "err ") + pid + " " + a.ToString("X") + " " + b.ToString("X");
  }
}
'@
[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $p = $line.Trim() -split '\\s+'
  if ($p.Count -ge 3) { try { [Console]::Out.WriteLine([LilinPrio]::Set([int]$p[0], [int]$p[1], [int]$p[2])) } catch { [Console]::Out.WriteLine("err $($p[0]) $_") }; [Console]::Out.Flush() }
}`;

let helper = null;
let helperFailures = 0;
function ioHelper() {
  if (helper) return helper;
  if (helperFailures >= 3) return null; // PowerShell missing or blocked: CPU priority still applies
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let child;
  try {
    child = spawn(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(HELPER, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  } catch { helperFailures++; return null; }
  const pending = [];
  let ready = false, buf = '';
  child.stdout.setEncoding('utf8').on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line === 'ready') { ready = true; for (const l of pending.splice(0)) child.stdin.write(l); }
      else if (line.startsWith('err') && !/ open (87|5)$/.test(line)) helper.errors.push(line); // 87 = already exited
    }
  });
  child.on('error', () => {});
  child.on('close', () => { if (helper?.child === child) helper = null; helperFailures++; });
  child.stdin.on('error', () => {});
  child.unref();
  child.stdout.unref?.();
  child.stdin.unref?.();
  helper = {
    child, errors: [],
    set(pid, io, page) { const l = `${pid} ${io} ${page}\n`; if (ready) child.stdin.write(l); else pending.push(l); },
  };
  process.once('exit', () => { try { child.kill(); } catch { /* gone */ } });
  return helper;
}

// For `node setup.js doctor` and tests.
export const _helper = () => helper;
