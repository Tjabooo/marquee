// `node setup.js clipper`: the Clips tab's folder (CLIPS_DIR), plus Clipper, the replay-buffer
// recorder that fills it (https://github.com/Tjabooo/clipper). Clipper is installed on the PC you
// play on: this one (downloaded and installed for you), or another PC (the commands to paste
// there are printed with your share filled in). Pure helpers here; prompting lives in cli.js.
//
// Clipper is other code, so Lilin never installs "whatever is on main": it pins one reviewed
// commit and checks what it downloads against hashes recorded here. The source download must match
// CLIPPER_TREE_SHA256 (a hash over every file's path and contents), and the one-liners for another
// PC check the installer script's SHA-256 before running it; that script then fetches the same
// pinned commit. Clipper's programs (Rust) are built from that source when the PC has Rust, else
// they come from the pinned CLIPPER_RELEASE and are checked against CLIPPER_BINARY_SHA256 (Clipper's
// installers do that check when given clipperEnv()). What Clipper itself installs is listed in
// CLIPPER_INSTALLS and shown before asking. To move to a newer Clipper: review its changes, then
// update the commit, the three hashes, the release and its binary checksums.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLIPPER_REPO = 'Tjabooo/clipper';
export const CLIPPER_COMMIT = '73ec7d82bd5b4371d2ee9abf476b911f3920b140';
export const CLIPPER_TREE_SHA256 = 'afd0e3141b591cf7716527db5425f8b5c5a9e705ef05352a68455ae9972981e5';
export const CLIPPER_SCRIPT_SHA256 = {
  'install.ps1': '0dc87effee59aec112d06aaf32b22a420bceb9906cfd660745982ca38f079451',
  'install.sh': '61683be115bdba6cf06df0de930243be14987598cec55dc65e4a9fb4844977b1',
};
// The release Clipper's CI built from that source, and the checksums of its downloads.
export const CLIPPER_RELEASE = 'v0.2.1';
export const CLIPPER_BINARY_SHA256 = {
  linux: ['6232ad49a6742cbaadec016462f5046a9f6a66665977f4b4e1123079982ec037', '905a179f50a708dbe1d8d2929852408f7ac242d3dcf24128f43105f74a6e6793'], // clipper-x86_64-linux.tar.gz, clipper-aarch64-linux.tar.gz
  windows: '0b319e35cdd13cdab23bf340f2d3ba3e3f12857f689bebb2a43c87b8af421c3f', // clipper-bench-x86_64-windows.exe (only for -Bench)
};
// Environment for Clipper's installers: fetch exactly that release, refuse anything else.
export const clipperEnv = () => ({
  CLIPPER_RELEASE,
  CLIPPER_SHA256: CLIPPER_BINARY_SHA256.linux.join(','),
  CLIPPER_BENCH_SHA256: CLIPPER_BINARY_SHA256.windows,
});
export const CLIPPER_REF = CLIPPER_COMMIT;
const RAW = `https://raw.githubusercontent.com/${CLIPPER_REPO}/${CLIPPER_COMMIT}`;
export const clipperTarball = (ref = CLIPPER_REF) => `https://codeload.github.com/${CLIPPER_REPO}/tar.gz/${ref}`;
export const clipperSourceUrl = (ref = CLIPPER_REF) => `https://github.com/${CLIPPER_REPO}/tree/${ref}`;

// What Clipper's installer sets up, so nobody installs it blind.
export const CLIPPER_INSTALLS = {
  windows: [
    'OBS Studio, and the .NET 8 SDK to build Clipper (with winget, from the official winget repository)',
    'FFmpeg (winget) and clipper-bench.exe from Clipper\'s ' + CLIPPER_RELEASE + ' release (checksum checked) only if you pick a benchmark',
    'clipper.exe in %LOCALAPPDATA%\\clipper and a scheduled task that starts it when you sign in (your account, no admin rights)',
    'An OBS profile and scene collection for the replay buffer (your existing OBS setup is backed up)',
  ],
  linux: [
    'The clipper and clipper-bench programs in ~/.local/share/clipper and ~/.local/bin (built with cargo if you have Rust, else Clipper\'s ' + CLIPPER_RELEASE + ' release, checksum checked), plus systemd user units (no root)',
    'It needs gpu-screen-recorder, ffmpeg, mpv and libnotify from your package manager; it tells you which are missing instead of installing them',
  ],
};

// sha256 over "path\0sha256(contents)\n" for every file, sorted by path. Independent of how the
// download was compressed, so GitHub re-packing an archive doesn't break the check.
export function treeHash(dir) {
  const files = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) files.push(r);
      else throw new Error(`Unexpected ${e.isSymbolicLink() ? 'link' : 'entry'} in the download: ${r}`);
    }
  };
  walk(dir, '');
  const h = crypto.createHash('sha256');
  for (const f of files.sort()) h.update(`${f}\0${crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, ...f.split('/')))).digest('hex')}\n`);
  return h.digest('hex');
}

// Same names as Clipper's presets and benchmark goals (src/quality.rs there).
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
  return p.join(home, 'Lilin Clips');
}

// What a share of `dir` is called on the network: its folder name, made SMB-safe.
export const shareName = (dir) => ((String(dir).split(/[\\/]/).filter(Boolean).pop() || '').replace(/[^A-Za-z0-9_-]+/g, '') || 'Clips').slice(0, 40);

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const shQuote = (s) => (/^[\w./:@%+=-]+$/.test(String(s)) ? String(s) : `'${String(s).replace(/'/g, `'\\''`)}'`);

// The command to run on the gaming PC: downloads the pinned installer, checks its SHA-256, runs it.
export function remoteInstallCommand({ target, share, lilinUrl, quality }) {
  const q = parseQuality(quality);
  if (target === 'windows') {
    const args = [`-Share ${psQuote(share)}`];
    if (lilinUrl) args.push(`-LilinUrl ${psQuote(lilinUrl)}`);
    args.push(q.bench ? `-Bench ${q.bench}` : `-Quality ${q.preset}`);
    return [`$f = "$env:TEMP\\clipper-install.ps1"; irm ${RAW}/install.ps1 -OutFile $f;`,
      `if ((Get-FileHash $f -Algorithm SHA256).Hash -ne '${CLIPPER_SCRIPT_SHA256['install.ps1'].toUpperCase()}') { throw 'Clipper installer checksum mismatch: not running it' };`,
      `$env:CLIPPER_RELEASE = '${CLIPPER_RELEASE}'; $env:CLIPPER_BENCH_SHA256 = '${CLIPPER_BINARY_SHA256.windows}';`,
      `powershell -NoProfile -ExecutionPolicy Bypass -File $f -Ref ${CLIPPER_COMMIT} ${args.join(' ')}`].join(' ');
  }
  const args = ['--lilin', shQuote(share), '--quality', q.bench ? `bench:${q.bench}` : q.preset];
  return [`f=$(mktemp) && curl -fsSL ${RAW}/install.sh -o "$f"`,
    `&& echo '${CLIPPER_SCRIPT_SHA256['install.sh']}  '"$f" | sha256sum -c --quiet -`,
    `&& CLIPPER_REF=${CLIPPER_COMMIT} CLIPPER_RELEASE=${CLIPPER_RELEASE} CLIPPER_SHA256=${CLIPPER_BINARY_SHA256.linux.join(',')} sh "$f" ${args.join(' ')}`].join(' ');
}

// How to share the folder from this (the Lilin) machine, and how the gaming PC reaches it.
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
export function localInstallCommand({ src, clipsDir, lilinUrl, quality, yes = false, platform = process.platform }) {
  const q = parseQuality(quality);
  if (platform === 'win32') {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.win32.join(src, 'windows', 'install.ps1'), '-Share', clipsDir];
    if (lilinUrl) args.push('-LilinUrl', lilinUrl);
    args.push(...(q.bench ? ['-Bench', q.bench] : ['-Quality', q.preset]));
    return ['powershell', ...args];
  }
  if (platform !== 'linux') throw new Error('Clipper records on Linux and Windows only.');
  const args = ['sh', path.posix.join(src, 'linux', 'install.sh'), '--lilin', clipsDir, '--quality', q.bench ? `bench:${q.bench}` : q.preset];
  if (yes) args.push('--yes');
  return args;
}

// Download Clipper's source (a GitHub tarball of the pinned commit) into `dest`, replacing what's
// there, after checking it against CLIPPER_TREE_SHA256. Another `ref` is only installed with
// `expectTree: null`, which cli.js allows for --clipper-ref after a warning.
export async function downloadClipper(dest, { fetchImpl = fetch, tar = 'tar', spawn, ref = CLIPPER_REF, expectTree = CLIPPER_TREE_SHA256 } = {}) {
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
  if (!['Cargo.toml', path.join('linux', 'install.sh')].every((f) => fs.existsSync(path.join(out, f)))) throw new Error('The download doesn\'t look like Clipper');
  if (expectTree) {
    const got = treeHash(out);
    if (got !== expectTree) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw new Error(`Clipper's download doesn't match the reviewed version (tree hash ${got.slice(0, 12)}…, expected ${expectTree.slice(0, 12)}…). Nothing was installed.`);
    }
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(out, dest);
  fs.rmSync(tmp, { recursive: true, force: true });
  return dest;
}

// Clipper writes Kept/<game>/ and Trimmed Clips/; make sure the folder exists and is writable.
export function prepareClipsDir(dir) {
  fs.mkdirSync(path.join(dir, 'Kept'), { recursive: true });
  const probe = path.join(dir, `.lilin-write-test-${process.pid}`);
  fs.writeFileSync(probe, 'ok');
  fs.rmSync(probe, { force: true });
}
