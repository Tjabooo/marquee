// `node setup.js clipper`: the Clips tab's folder (CLIPS_DIR), plus Clipper, the replay-buffer
// recorder that fills it (https://github.com/Tjabooo/clipper). Clipper is installed on the PC you
// play on: this one (downloaded and installed for you), or another PC (the commands to paste
// there are printed with your share filled in). Pure helpers here; prompting lives in cli.js.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLIPPER_REPO = 'Tjabooo/clipper';
export const CLIPPER_REF = 'main';
const RAW = `https://raw.githubusercontent.com/${CLIPPER_REPO}/${CLIPPER_REF}`;
export const clipperTarball = (ref = CLIPPER_REF) => `https://codeload.github.com/${CLIPPER_REPO}/tar.gz/${ref}`;

// Same names as Clipper's presets and benchmark goals (bench/clipperbench.py there).
export const QUALITY_CHOICES = [
  ['balanced', 'balanced: 60 fps, quality-based bitrate (default)'],
  ['compact', 'compact: 1080p60 at ~20 Mbit/s, small files that stream well to phones'],
  ['high', 'high: 60 fps, 60 Mbit/s at 1440p, sharp in fast motion'],
  ['max', 'max: 60 fps, 120 Mbit/s at 1440p, visually lossless (~1.4 GB per clip)'],
  ['smooth', 'smooth: 120 fps, 90 Mbit/s at 1440p'],
  ['bench:quality', 'benchmark for quality: measure the PC, pick the lowest bitrate that looks lossless'],
  ['bench:smooth', 'benchmark for frame rate: the highest fps that still looks good'],
  ['bench:small', 'benchmark for size: small files that still look good'],
];
const PRESETS = new Set(['compact', 'balanced', 'high', 'max', 'smooth']);
const GOALS = new Set(['quality', 'smooth', 'balanced', 'small']);

// 'high' → { preset: 'high' }, 'bench:smooth' / 'bench' → { bench: 'smooth' / 'quality' }
export function parseQuality(q) {
  const v = String(q || 'balanced').trim().toLowerCase();
  if (PRESETS.has(v)) return { preset: v };
  const m = /^bench(?::(\w+))?$/.exec(v);
  if (m && GOALS.has(m[1] || 'quality')) return { bench: m[1] || 'quality' };
  throw new Error(`Unknown quality "${q}": use ${[...PRESETS].join(', ')}, or bench:quality|smooth|balanced|small`);
}

// Next to MEDIA_DIR (D:\Media → D:\Clips), else in the home folder. Never inside Clipper's own
// local folder (~/Videos/Clips), which it empties as clips move to the server.
export function defaultClipsDir(env = {}, home = os.homedir(), platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (env.MEDIA_DIR) return p.join(p.dirname(p.resolve(env.MEDIA_DIR)), 'Clips');
  return p.join(home, 'Marquee Clips');
}

// What a share of `dir` is called on the network: its folder name, made SMB-safe.
export const shareName = (dir) => ((String(dir).split(/[\\/]/).filter(Boolean).pop() || '').replace(/[^A-Za-z0-9_-]+/g, '') || 'Clips').slice(0, 40);

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const shQuote = (s) => (/^[\w./:@%+=-]+$/.test(String(s)) ? String(s) : `'${String(s).replace(/'/g, `'\\''`)}'`);

// The one-liner to run on the gaming PC.
export function remoteInstallCommand({ target, share, marqueeUrl, quality }) {
  const q = parseQuality(quality);
  if (target === 'windows') {
    const args = [`-Share ${psQuote(share)}`];
    if (marqueeUrl) args.push(`-MarqueeUrl ${psQuote(marqueeUrl)}`);
    args.push(q.bench ? `-Bench ${q.bench}` : `-Quality ${q.preset}`);
    return `& ([scriptblock]::Create((irm ${RAW}/install.ps1))) ${args.join(' ')}`;
  }
  const args = ['--marquee', shQuote(share), '--quality', q.bench ? `bench:${q.bench}` : q.preset];
  return `curl -fsSL ${RAW}/install.sh | sh -s -- ${args.join(' ')}`;
}

// How to share the folder from this (the Marquee) machine, and how the gaming PC reaches it.
export function shareInstructions({ clipsDir, host, target, platform = process.platform, mount = '/mnt/clips', user = os.userInfo().username }) {
  const name = shareName(clipsDir);
  const unc = `\\\\${host}\\${name}`;
  const lines = [];
  if (platform === 'win32') {
    lines.push('Share the folder (in an elevated PowerShell on this server, once):');
    lines.push(`  New-SmbShare -Name ${name} -Path ${psQuote(clipsDir)} -ChangeAccess ${psQuote(user)}`);
  } else if (platform === 'linux') {
    lines.push('Share the folder with Samba (once; add to /etc/samba/smb.conf, then `sudo smbpasswd -a ' + user + '` and restart smb):');
    lines.push(`  [${name}]`, `    path = ${clipsDir}`, `    valid users = ${user}`, '    read only = no');
    lines.push('  (or NFS: export the folder and mount it on the gaming PC)');
  } else {
    lines.push(`Share ${clipsDir} over SMB as "${name}" (System Settings → General → Sharing → File Sharing).`);
  }
  if (target === 'windows') {
    lines.push('On the gaming PC, save the share\'s login once (cmd or PowerShell):');
    lines.push(`  cmdkey /add:${host} /user:${host}\\${user} /pass`);
  } else if (target === 'linux') {
    lines.push('On the gaming PC, mount it (a line in /etc/fstab, then `sudo mkdir -p ' + mount + ' && sudo systemctl daemon-reload`):');
    lines.push(`  //${host}/${name}  ${mount}  cifs  credentials=/etc/clips.cred,uid=1000,gid=1000,noauto,x-systemd.automount,x-systemd.idle-timeout=10min,_netdev  0 0`);
    lines.push(`  (/etc/clips.cred: username=${user} and password=… lines, chmod 600)`);
  }
  return { share: target === 'windows' ? unc : mount, lines };
}

// Run Clipper's own installer from a checkout in `src`, pointed at CLIPS_DIR on this machine.
export function localInstallCommand({ src, clipsDir, marqueeUrl, quality, yes = false, platform = process.platform }) {
  const q = parseQuality(quality);
  if (platform === 'win32') {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.win32.join(src, 'windows', 'install.ps1'), '-Share', clipsDir];
    if (marqueeUrl) args.push('-MarqueeUrl', marqueeUrl);
    args.push(...(q.bench ? ['-Bench', q.bench] : ['-Quality', q.preset]));
    return ['powershell', ...args];
  }
  if (platform !== 'linux') throw new Error('Clipper records on Linux and Windows only.');
  const args = ['sh', path.posix.join(src, 'linux', 'install.sh'), '--marquee', clipsDir, '--quality', q.bench ? `bench:${q.bench}` : q.preset];
  if (yes) args.push('--yes');
  return args;
}

// Download Clipper's source (a GitHub tarball) into `dest`, replacing what's there.
export async function downloadClipper(dest, { fetchImpl = fetch, tar = 'tar', spawn, ref = CLIPPER_REF } = {}) {
  const res = await fetchImpl(clipperTarball(ref), { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Downloading Clipper failed: HTTP ${res.status}`);
  const tmp = `${dest}.download`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const file = path.join(tmp, 'clipper.tar.gz');
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  const out = path.join(tmp, 'src');
  fs.mkdirSync(out);
  const r = spawn(tar, ['-xzf', file, '-C', out, '--strip-components=1'], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('Unpacking Clipper failed (is tar installed?)');
  if (!fs.existsSync(path.join(out, 'bench', 'clipperbench.py'))) throw new Error('The download doesn\'t look like Clipper');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(out, dest);
  fs.rmSync(tmp, { recursive: true, force: true });
  return dest;
}

// Clipper writes Kept/<game>/ and Trimmed Clips/; make sure the folder exists and is writable.
export function prepareClipsDir(dir) {
  fs.mkdirSync(path.join(dir, 'Kept'), { recursive: true });
  const probe = path.join(dir, `.marquee-write-test-${process.pid}`);
  fs.writeFileSync(probe, 'ok');
  fs.rmSync(probe, { force: true });
}
