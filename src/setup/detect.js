// Finds out what this machine has. Every probe is read-only, has a timeout and treats a missing
// tool as "not found" rather than an error. Hardware encoders are only reported as working after a
// real one-second test encode succeeds: a GPU being present proves nothing about ffmpeg using it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const MIN_NODE = [22, 16, 0];

export function run(cmd, args = [], { timeout = 8000, input } = {}) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, windowsHide: true, input, shell: false });
    if (r.error) return { ok: false, code: null, out: '', err: r.error.code || r.error.message };
    return { ok: r.status === 0, code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
  } catch (e) {
    return { ok: false, code: null, out: '', err: e.message };
  }
}

// Absolute path of a command on PATH, or null. Doesn't execute anything.
export function which(cmd, { env = process.env, platform = process.platform } = {}) {
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? cmd : null;
  const exts = platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const full = path.join(dir, platform === 'win32' && !path.extname(cmd) ? cmd + ext.toLowerCase() : cmd);
      try { if (fs.statSync(full).isFile()) return full; } catch { /* keep looking */ }
    }
  }
  return null;
}

export function nodeVersion(version = process.versions.node) {
  const parts = version.split('.').map(Number);
  const ok = parts[0] > MIN_NODE[0] || (parts[0] === MIN_NODE[0] && (parts[1] > MIN_NODE[1] || (parts[1] === MIN_NODE[1] && parts[2] >= MIN_NODE[2])));
  return { version, ok, minimum: MIN_NODE.join('.') };
}

// node:sqlite with FTS5 (Notes search). Node 22.13-22.15 have node:sqlite but without FTS5.
export async function sqliteSupport() {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try { db.exec('CREATE VIRTUAL TABLE t USING fts5(a)'); return { ok: true }; } catch (e) { return { ok: false, reason: `SQLite has no FTS5 (${e.message})` }; } finally { db.close(); }
  } catch (e) {
    return { ok: false, reason: `node:sqlite unavailable (${e.message})` };
  }
}

export function osInfo() {
  const info = { platform: process.platform, arch: process.arch, release: os.release(), name: process.platform, wsl: false, container: false };
  if (process.platform === 'linux') {
    try {
      const rel = Object.fromEntries(fs.readFileSync('/etc/os-release', 'utf8').split('\n')
        .map((l) => /^([A-Z_]+)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].replace(/^"|"$/g, '')]));
      info.name = rel.PRETTY_NAME || rel.NAME || 'Linux';
      info.id = rel.ID;
      info.idLike = (rel.ID_LIKE || '').split(/\s+/).filter(Boolean);
    } catch { info.name = 'Linux'; }
    info.wsl = /microsoft/i.test(os.release());
    info.container = fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
  } else if (process.platform === 'darwin') {
    const v = run('sw_vers', ['-productVersion']);
    info.name = `macOS ${v.ok ? v.out.trim() : ''}`.trim();
  } else if (process.platform === 'win32') {
    info.name = `Windows (${os.release()})`;
  }
  return info;
}

const MANAGERS = {
  win32: ['winget', 'choco'],
  darwin: ['brew'],
  linux: ['apt-get', 'dnf', 'pacman', 'zypper', 'apk', 'brew'],
};
export function packageManagers(platform = process.platform) {
  return (MANAGERS[platform] || []).filter((m) => which(m)).map((m) => (m === 'apt-get' ? 'apt' : m));
}

export function diskSpace(dir) {
  try {
    let d = path.resolve(dir);
    while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
    const s = fs.statfsSync(d);
    return { path: d, free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch (e) {
    return { path: dir, error: e.code || e.message };
  }
}

// LAN IPv4 addresses, skipping loopback, link-local, VPN tunnels and virtual adapters.
export function lanAddresses(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (/vEthernet|VirtualBox|VMware|WSL|Hyper-V|Tailscale|ZeroTier|Loopback|docker|br-|veth|virbr/i.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || /^169\.254\./.test(a.address)) continue;
      if (a.mac === '00:00:00:00:00:00' || a.netmask === '255.255.255.255') continue;
      out.push({ name, address: a.address });
    }
  }
  return out;
}

const ENCODER_TESTS = {
  // name: [ffmpeg encoder, extra input args, filter, label, used by Lilin]
  nvenc: { encoder: 'h264_nvenc', label: 'NVIDIA NVENC', used: true },
  qsv: { encoder: 'h264_qsv', pre: ['-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw'], vf: 'format=nv12,hwupload=extra_hw_frames=64', label: 'Intel Quick Sync' },
  vaapi: { encoder: 'h264_vaapi', pre: ['-vaapi_device', '/dev/dri/renderD128'], vf: 'format=nv12,hwupload', label: 'VAAPI (Intel/AMD on Linux)', platforms: ['linux'] },
  amf: { encoder: 'h264_amf', label: 'AMD AMF', platforms: ['win32'] },
  videotoolbox: { encoder: 'h264_videotoolbox', label: 'Apple VideoToolbox', platforms: ['darwin'] },
};

// The line of ffmpeg's stderr that explains a failure, rather than its generic last words.
function firstError(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.replace(/^\[[^\]]+\]\s*/, '').trim()).filter(Boolean);
  return (lines.find((l) => /cannot|could not|error|fail|unsupported|no (device|capable)|not (found|available)/i.test(l)) || lines.at(-1) || 'failed').slice(0, 160);
}

export function ffmpegInfo(env = process.env) {
  const ffmpeg = env.FFMPEG || which('ffmpeg');
  const ffprobe = env.FFPROBE || which('ffprobe');
  const info = { ffmpeg, ffprobe, version: null, ffprobeOk: false, encoders: {} };
  if (!ffmpeg) return info;
  const v = run(ffmpeg, ['-hide_banner', '-version']);
  if (!v.ok) { info.error = `${ffmpeg} didn't run (${v.err.trim().split('\n').pop() || v.code})`; return info; }
  info.version = /ffmpeg version (\S+)/.exec(v.out)?.[1] || 'unknown';
  info.ffprobeOk = Boolean(ffprobe && run(ffprobe, ['-version']).ok);
  const list = run(ffmpeg, ['-hide_banner', '-encoders']).out;
  info.libx264 = /\blibx264\b/.test(list);
  for (const [key, t] of Object.entries(ENCODER_TESTS)) {
    if (t.platforms && !t.platforms.includes(process.platform)) continue;
    if (!new RegExp(`\\b${t.encoder}\\b`).test(list)) continue;
    const args = ['-hide_banner', '-v', 'error', ...(t.pre || []), '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=1',
      ...(t.vf ? ['-vf', t.vf] : []), '-c:v', t.encoder, '-f', 'null', '-'];
    const r = run(ffmpeg, args, { timeout: 15000 });
    info.encoders[key] = { label: t.label, used: Boolean(t.used), works: r.ok, error: r.ok ? null : firstError(r.err) };
  }
  return info;
}

export function gpus() {
  const found = [];
  if (process.platform === 'linux') {
    const vendors = { '0x10de': 'NVIDIA', '0x8086': 'Intel', '0x1002': 'AMD' };
    try {
      for (const card of fs.readdirSync('/sys/class/drm').filter((c) => /^card\d+$/.test(c))) {
        try { const v = fs.readFileSync(`/sys/class/drm/${card}/device/vendor`, 'utf8').trim(); if (vendors[v]) found.push(vendors[v]); } catch { /* not a PCI device */ }
      }
    } catch { /* no DRM: container or headless VM */ }
    if (fs.existsSync('/dev/dri/renderD128')) found.push('render node /dev/dri/renderD128');
  } else if (process.platform === 'win32') {
    const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_VideoController).Name']);
    if (r.ok) found.push(...r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  } else if (process.platform === 'darwin') {
    found.push(process.arch === 'arm64' ? 'Apple silicon GPU' : 'Mac GPU');
  }
  if (which('nvidia-smi')) {
    const r = run('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader']);
    if (r.ok) found.push(...r.out.trim().split('\n').map((l) => `${l.trim()} (nvidia-smi)`));
  }
  return [...new Set(found)];
}

export function pyatvInfo(env = process.env) {
  const atv = env.ATVSCRIPT || which('atvscript');
  // atvscript has no --version; --help exits 0 when the install (and its Python) works.
  if (atv) { const r = run(atv, ['--help']); return { atvscript: atv, works: r.ok && /atvscript/.test(r.out), version: null }; }
  const python = which('python3') || which('python');
  return { atvscript: null, works: false, python };
}

export function dockerInfo() {
  const docker = which('docker');
  if (!docker) return { docker: false };
  const v = run(docker, ['version', '--format', '{{.Server.Version}}']);
  const c = run(docker, ['compose', 'version', '--short']);
  return { docker: true, daemon: v.ok ? v.out.trim() : null, compose: c.ok ? c.out.trim() : null, error: v.ok ? null : v.err.trim().split('\n').pop() };
}

export function serviceManagers(platform = process.platform) {
  if (platform === 'win32') return ['task-scheduler'];
  if (platform === 'darwin') return ['launchd'];
  const out = [];
  if (fs.existsSync('/run/systemd/system')) out.push('systemd');
  if (which('openrc') || which('rc-service')) out.push('openrc');
  return out;
}

export async function detectAll(env = process.env, { encoders = true } = {}) {
  return {
    os: osInfo(),
    node: nodeVersion(),
    sqlite: await sqliteSupport(),
    packageManagers: packageManagers(),
    lan: lanAddresses(),
    ffmpeg: encoders ? ffmpegInfo(env) : { ffmpeg: env.FFMPEG || which('ffmpeg') },
    gpus: encoders ? gpus() : [],
    pyatv: pyatvInfo(env),
    tesseract: process.platform === 'win32' ? 'windows-ocr' : (env.TESSERACT || which('tesseract')),
    docker: dockerInfo(),
    services: serviceManagers(),
  };
}
