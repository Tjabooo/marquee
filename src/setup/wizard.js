// `node setup.js wizard info|check|clipper`: a JSON bridge for graphical setup front ends (the
// Windows setup wizard in scripts/windows/setup-wizard.ps1). It only reads: everything that
// changes the installation still goes through the normal commands (`setup --config`, `user add`,
// `service install`, `clipper --config`), so the GUI and the terminal can never drift apart.
//
// Each command prints one JSON object on stdout. Secrets are never printed, only whether they're set;
// the one exception is `wizard oidc`, which exists to show the Access client secret to paste into
// Cloudflare (like `setup.js oidc`).
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { APP_DIR } from '../env.js';
import { readEnvFile, parseEnv, SECRET_KEYS } from './envfile.js';
import * as detect from './detect.js';
import { checkTmdb, checkQbit, checkOpenSubtitles } from './integrations.js';
import * as clipper from './clipper.js';
import { oidcConfigured, loginMethod, loginMethodLines } from './oidc.js';
import { openAuthStore } from '../auth.js';

export const WIZARD_ACTIONS = ['info', 'check', 'clipper', 'oidc'];

const portFree = (port) => new Promise((resolve) => {
  const srv = net.createServer().once('error', () => resolve(false)).once('listening', () => srv.close(() => resolve(true)));
  srv.listen(port, '0.0.0.0');
});

async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

function defaultMediaDir(platform = process.platform) {
  return platform === 'win32' ? path.join(os.homedir(), 'Videos', 'Lilin') : path.join(os.homedir(), 'Media');
}

// Current .env split into plain values and "is this secret set?" flags.
export function splitSecrets(values) {
  const plain = {}, secrets = {};
  for (const [k, v] of Object.entries(values)) {
    if (SECRET_KEYS.test(k)) secrets[k] = Boolean(v);
    else plain[k] = v;
  }
  return { values: plain, secrets };
}

// Which remote-access choice matches an existing .env.
export function remoteAccessOf(values) {
  if (values.CF_ACCESS_TEAM_DOMAIN || values.CF_ACCESS_AUD) return 'cloudflare';
  return values.PUBLIC_URL ? 'proxy' : 'none';
}

// The "Lilin" task counts only if it runs this installation (another copy may own the name).
export function taskRunsApp(xml, appDir) {
  const want = path.win32.join(appDir, 'start-lilin.cmd').toLowerCase();
  return String(xml || '').replace(/&quot;|"/g, '').toLowerCase().includes(want);
}

function windowsTaskInstalled() {
  if (process.platform !== 'win32') return null;
  const r = spawnSync('schtasks.exe', ['/query', '/tn', 'Lilin', '/xml'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return r.status === 0 && taskRunsApp(r.stdout, APP_DIR);
}

function clipperInstalledHere() {
  if (process.platform === 'win32') return fs.existsSync(path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'clipper', 'clipper.exe'));
  return Boolean(detect.which('clipper'));
}

export async function wizardInfo({ envFile }) {
  const text = readEnvFile(envFile);
  const all = parseEnv(text ?? '');
  const { values, secrets } = splitSecrets(all);
  const dataDir = all.DATA_DIR ? path.resolve(all.DATA_DIR) : APP_DIR;
  const port = Number(all.PORT || 8080);
  const running = await health(port);
  let logins = [];
  if (fs.existsSync(path.join(dataDir, '.lilin.db'))) {
    try { const store = openAuthStore(dataDir); logins = store.list().map((r) => r.email); store.close(); } catch { /* unreadable: treat as none */ }
  }
  const owner = String(all.ADMIN_EMAILS || '').split(',')[0].trim().toLowerCase();
  const ffmpeg = all.FFMPEG || detect.which('ffmpeg');
  const ffv = ffmpeg ? detect.run(ffmpeg, ['-hide_banner', '-version']) : null;
  const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
  const mediaDefault = all.MEDIA_DIR || defaultMediaDir();
  return {
    version: pkg.version,
    appDir: APP_DIR,
    envFile,
    envExists: text !== null,
    freshInstall: !fs.existsSync(path.join(dataDir, '.lilin.db')),
    platform: process.platform,
    os: detect.osInfo().name,
    hostname: os.hostname(),
    lan: detect.lanAddresses().map((a) => a.address),
    node: detect.nodeVersion(),
    values,
    secrets,
    defaults: {
      MEDIA_DIR: mediaDefault,
      DATA_DIR: all.DATA_DIR || '',
      CACHE_DIR: all.CACHE_DIR || '',
      CONTENT_FILTER: ['on', 'members', 'off'].includes(String(all.CONTENT_FILTER || '').trim().toLowerCase()) ? String(all.CONTENT_FILTER).trim().toLowerCase() : 'on',
      PORT: String(port),
      HOST: all.HOST || '0.0.0.0',
      HOME_NETWORK_ACCESS: all.HOME_NETWORK_ACCESS || 'shared',
      remoteAccess: remoteAccessOf(all),
      // Lilin as Access's login: on when it's set up, and suggested for new Cloudflare setups.
      accessSignIn: oidcConfigured(all) || !all.CF_ACCESS_TEAM_DOMAIN ? 'lilin' : 'access',
      CLIPS_DIR: all.CLIPS_DIR || clipper.defaultClipsDir({ MEDIA_DIR: mediaDefault }),
    },
    running: running ? { version: running.version || null } : null,
    portFree: running ? true : await portFree(port),
    ffmpeg: ffv?.ok ? { path: ffmpeg, version: /ffmpeg version (\S+)/.exec(ffv.out)?.[1] || 'unknown' } : null,
    winget: process.platform === 'win32' ? Boolean(detect.which('winget')) : false,
    logins,
    ownerHasLogin: Boolean(owner && logins.includes(owner)),
    autostart: windowsTaskInstalled(),
    clipper: {
      commit: clipper.CLIPPER_COMMIT,
      source: clipper.clipperSourceUrl(),
      installs: clipper.CLIPPER_INSTALLS,
      quality: clipper.QUALITY_CHOICES.map(([value, label]) => ({ value, label })),
      installedHere: clipperInstalledHere(),
    },
  };
}

// Tests the answers the GUI has so far. Keys missing from `answers` keep their .env value, so a
// blank "keep current" password still tests the saved one.
export async function wizardCheck({ envFile, answers }) {
  const env = { ...parseEnv(readEnvFile(envFile) ?? ''), ...Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, String(v ?? '')])) };
  const out = {};
  const port = Number(env.PORT || 8080);
  if (Number.isInteger(port) && port > 0 && port < 65536) {
    const running = await health(port);
    out.port = running ? { ok: true, detail: `Lilin ${running.version || ''} is running on this port`.replace('  ', ' ') }
      : (await portFree(port)) ? { ok: true, detail: 'free' } : { ok: false, detail: `port ${port} is used by another program` };
  } else out.port = { ok: false, detail: 'pick a number from 1 to 65535' };
  const pick = (r) => (r ? { ok: r.ok, detail: r.detail, savePath: r.savePath } : null);
  const only = Array.isArray(answers.only) ? answers.only : ['tmdb', 'qbit', 'opensubtitles'];
  const [tmdb, qbit, os_] = await Promise.all([
    only.includes('tmdb') ? checkTmdb(env).catch((e) => ({ ok: false, detail: e.message })) : null,
    only.includes('qbit') ? checkQbit(env).catch((e) => ({ ok: false, detail: e.message })) : null,
    only.includes('opensubtitles') ? checkOpenSubtitles(env).catch((e) => ({ ok: false, detail: e.message })) : null,
  ]);
  Object.assign(out, { tmdb: pick(tmdb), qbit: pick(qbit), opensubtitles: pick(os_) });
  return out;
}

// What the Clipper page shows for the choices so far.
export function wizardClipper({ envFile, answers }) {
  const env = parseEnv(readEnvFile(envFile) ?? '');
  const clipsDir = path.resolve(answers.CLIPS_DIR || env.CLIPS_DIR || clipper.defaultClipsDir({ MEDIA_DIR: answers.MEDIA_DIR || env.MEDIA_DIR }));
  const where = ['here', 'windows', 'linux', 'none'].includes(answers.where) ? answers.where : 'here';
  const quality = answers.quality || 'balanced';
  clipper.parseQuality(quality);
  const lan = detect.lanAddresses()[0]?.address;
  const lilinUrl = env.PUBLIC_URL || `http://${lan || os.hostname()}:${answers.PORT || env.PORT || 8080}`;
  const out = { clipsDir, where, quality, lilinUrl, commit: clipper.CLIPPER_COMMIT, source: clipper.clipperSourceUrl() };
  if (where === 'here') out.installs = clipper.CLIPPER_INSTALLS[process.platform === 'win32' ? 'windows' : 'linux'];
  if (where === 'windows' || where === 'linux') {
    const share = clipper.shareInstructions({ clipsDir, host: os.hostname(), target: where });
    out.share = answers.share || share.share;
    out.shareName = clipper.shareName(clipsDir);
    out.shareLines = share.lines;
    out.installs = clipper.CLIPPER_INSTALLS[where];
    out.remoteCommand = clipper.remoteInstallCommand({ target: where, share: out.share, lilinUrl, quality });
  }
  return out;
}

// The login method to add in Cloudflare, read from the .env setup just wrote.
export function wizardOidc({ envFile }) {
  const env = parseEnv(readEnvFile(envFile) ?? '');
  const m = loginMethod(env);
  return { configured: oidcConfigured(env), ...m, lines: m.ready ? loginMethodLines(m) : [] };
}

export async function wizardCommand({ action, envFile, answers = {} }) {
  if (action === 'info') return wizardInfo({ envFile });
  if (action === 'check') return wizardCheck({ envFile, answers });
  if (action === 'clipper') return wizardClipper({ envFile, answers });
  if (action === 'oidc') return wizardOidc({ envFile });
  throw new Error(`Use: node setup.js wizard ${WIZARD_ACTIONS.join('|')}`);
}
