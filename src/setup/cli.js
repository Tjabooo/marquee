// node setup.js [command] [options]: see HELP below. Safe to run again at any time: it keeps your
// existing .env (comments, unknown keys and values you set), only fills in what's missing or what
// you change, and asks before installing anything, using sudo or registering a service.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { APP_DIR, ENV_FILE } from '../env.js';
import { readEnvFile, writeEnvFile, updateEnvText, parseEnv, newSecret, redact } from './envfile.js';
import * as detect from './detect.js';
import { checkIntegrations, setQbitSavePath, checkQbit } from './integrations.js';
import { servicePlan, describeStep } from './services.js';
import { installCommand } from './packages.js';
import { backup, migrateData } from './data.js';
import * as clipper from './clipper.js';
import { checkConfig } from '../config-check.js';
import { dataDirProblem, STATE_FILES } from '../paths.js';

export const HELP = `Marquee setup

Usage:
  node setup.js                  Interactive setup (safe to re-run)
  node setup.js --yes            Unattended setup with defaults and detected values
  node setup.js --config FILE    Unattended setup from a JSON file of answers
  node setup.js doctor           Check an installation without changing it
  node setup.js backup [--to DIR]        Consistent copy of the database and state
  node setup.js migrate-data --to DIR    Move state to a new DATA_DIR (Marquee stopped)
  node setup.js service install|status|restart|uninstall [--scope user|system]
  node setup.js clipper          Game clips: set up CLIPS_DIR and install Clipper (the recorder)
                                 on this PC, or print the commands for your gaming PC

Options:
  --dry-run            Show what would change; write and run nothing
  --yes, -y            Accept defaults instead of asking
  --config FILE        Answers as JSON: .env keys plus "autostart", "install", "serviceScope", "qbitSavePath"
  --allow-install      Unattended: may install missing packages (with sudo on Linux)
  --allow-service      Unattended: may register the autostart service
  --allow-sudo         Unattended: may use sudo for system-level steps
  --allow-qbit-config  Unattended: may set qBittorrent's save path to MEDIA_DIR
  --offline            Skip network checks of integrations
  --scope user|system  systemd service scope (default: system on servers, user otherwise)
  --env FILE           Use this .env instead of the one in the Marquee folder

Clipper options (node setup.js clipper):
  --here               Install Clipper on this computer (downloads it from GitHub)
  --remote windows|linux   Print the commands for another PC instead
  --clips-dir DIR      Folder for clips (CLIPS_DIR); default: next to MEDIA_DIR
  --quality Q          compact, balanced, high, max, smooth, or bench:quality|smooth|balanced|small
                       (measure the gaming PC and pick for that goal)
  --share PATH         How the gaming PC reaches the folder (\\\\server\\Clips, or its mount point)
  --clipper-source DIR Install from this Clipper checkout instead of downloading it
`;

export function parseArgs(argv) {
  const opts = { command: 'setup', action: null, yes: false, dryRun: false, config: null, allow: new Set(), offline: false, scope: null, to: null, help: false, envFile: null,
    where: null, clipsDir: null, quality: null, share: null, clipperSource: null };
  const rest = [...argv];
  const value = (flag) => { const v = rest.shift(); if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value`); return v; };
  const positional = [];
  while (rest.length) {
    const a = rest.shift();
    if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--config') opts.config = value(a);
    else if (a === '--offline') opts.offline = true;
    else if (a === '--scope') { opts.scope = value(a); if (!['user', 'system'].includes(opts.scope)) throw new Error('--scope must be user or system'); }
    else if (a === '--to') opts.to = value(a);
    else if (a === '--env') opts.envFile = value(a);
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--here') opts.where = 'here';
    else if (a === '--remote') { opts.where = value(a); if (!['windows', 'linux'].includes(opts.where)) throw new Error('--remote must be windows or linux'); }
    else if (a === '--clips-dir') opts.clipsDir = value(a);
    else if (a === '--quality') { opts.quality = value(a); clipper.parseQuality(opts.quality); }
    else if (a === '--share') opts.share = value(a);
    else if (a === '--clipper-source') opts.clipperSource = value(a);
    else if (/^--allow-(install|service|sudo|qbit-config)$/.test(a)) opts.allow.add(a.slice(8));
    else if (a.startsWith('-')) throw new Error(`Unknown option ${a}. Run node setup.js --help.`);
    else positional.push(a);
  }
  if (positional.length) {
    opts.command = positional[0];
    if (!['setup', 'doctor', 'backup', 'migrate-data', 'service', 'clipper'].includes(opts.command)) throw new Error(`Unknown command ${opts.command}. Run node setup.js --help.`);
    if (opts.command === 'service') {
      opts.action = positional[1];
      if (!['install', 'status', 'restart', 'uninstall'].includes(opts.action)) throw new Error('Use: node setup.js service install|status|restart|uninstall');
    }
  }
  if (opts.config) opts.yes = true;
  return opts;
}

// ---------- output ----------
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = paint('32'), yellow = paint('33'), red = paint('31'), dim = paint('2'), bold = paint('1');
const mark = { ok: green('✓'), warn: yellow('!'), error: red('✗'), info: dim('·') };
const gib = (b) => `${(b / 1024 ** 3).toFixed(1)} GB`;

// ---------- prompting ----------
class Prompter {
  constructor({ yes, answers = {} }) { this.yes = yes; this.answers = answers; this.rl = null; }
  open() {
    if (this.yes || this.rl) return;
    if (!process.stdin.isTTY) throw new Error('No terminal to ask questions in. Re-run with --yes or --config FILE.');
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  close() { this.rl?.close(); this.rl = null; }
  async text(key, question, dflt = '', { secret = false } = {}) {
    if (key && key in this.answers) return String(this.answers[key] ?? '');
    if (this.yes) return dflt;
    this.open();
    const shown = dflt ? (secret ? ' [keep current]' : ` [${dflt}]`) : '';
    const a = (await this.rl.question(`${question}${shown}: `)).trim();
    return a || dflt;
  }
  // Consent questions: --yes alone never says yes to these; only the matching --allow-* flag does.
  async confirm(question, { dflt = false, allow = null, allowed = new Set() } = {}) {
    if (this.yes) return Boolean(allow && allowed.has(allow));
    this.open();
    const a = (await this.rl.question(`${question} ${dflt ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
    return a ? a.startsWith('y') : dflt;
  }
  async choose(key, question, choices, dflt) {
    if (key && key in this.answers) return this.answers[key];
    if (this.yes) return dflt;
    this.open();
    console.log(question);
    choices.forEach(([v, label], i) => console.log(`  ${i + 1}) ${label}${v === dflt ? dim(' (default)') : ''}`));
    const a = (await this.rl.question('Choose a number: ')).trim();
    const i = Number(a) - 1;
    return choices[i]?.[0] ?? dflt;
  }
}

// ---------- step execution ----------
const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;

function execute(step, { dryRun }) {
  const sudo = step.privileged && process.platform !== 'win32' && !isRoot();
  console.log(`  ${dim('$')} ${describeStep(step, { sudo })}`);
  if (dryRun) return true;
  if (step.mkdir) fs.mkdirSync(step.mkdir, { recursive: true });
  if (step.write) {
    if (sudo) {
      const r = spawnSync('sudo', ['tee', step.write.path], { input: step.write.content, stdio: ['pipe', 'ignore', 'inherit'] });
      if (r.status !== 0) return false;
      if (step.write.mode) spawnSync('sudo', ['chmod', step.write.mode.toString(8), step.write.path], { stdio: 'inherit' });
    } else {
      fs.mkdirSync(path.dirname(step.write.path), { recursive: true });
      fs.writeFileSync(step.write.path, step.write.content, { mode: step.write.mode || 0o644 });
    }
    return true;
  }
  if (step.remove) {
    if (sudo) return spawnSync('sudo', ['rm', '-f', step.remove], { stdio: 'inherit' }).status === 0;
    fs.rmSync(step.remove, { force: true });
    return true;
  }
  const [cmd, ...args] = sudo ? ['sudo', ...step.cmd] : step.cmd;
  const r = spawnSync(cmd, args, { stdio: step.quiet ? 'ignore' : 'inherit', windowsHide: false });
  return r.status === 0 || Boolean(step.allowFail);
}

function runPlan(steps, opts) {
  for (const s of steps) {
    if (!execute(s, opts)) { console.log(`  ${mark.error} ${s.description} failed`); return false; }
  }
  return true;
}

// ---------- helpers ----------
function portFree(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const srv = net.createServer().once('error', () => resolve(false)).once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

function loadEnv(file) {
  const existing = readEnvFile(file);
  const template = readEnvFile(path.join(APP_DIR, '.env.example')) ?? '';
  return { existing, text: existing ?? template, values: parseEnv(existing ?? '') };
}

function defaultMediaDir() {
  return process.platform === 'win32' ? path.join(os.homedir(), 'Videos', 'Marquee') : path.join(os.homedir(), 'Media');
}

function serviceManager() { return detect.serviceManagers()[0] || null; }

// The scope of a systemd unit that's already installed wins, so status/restart/uninstall act on it.
// For a new install, a desktop session suggests a personal machine (user service); otherwise system.
function defaultScope(info) {
  if (fs.existsSync('/etc/systemd/system/marquee.service')) return 'system';
  if (fs.existsSync(path.join(os.homedir(), '.config', 'systemd', 'user', 'marquee.service'))) return 'user';
  return info.os.platform === 'linux' && process.env.XDG_SESSION_TYPE && !isRoot() ? 'user' : 'system';
}

// ---------- commands ----------
async function setup(opts) {
  const envFile = opts.envFile ? path.resolve(opts.envFile) : ENV_FILE;
  const answers = opts.config ? JSON.parse(fs.readFileSync(opts.config, 'utf8')) : {};
  const ask = new Prompter({ yes: opts.yes, answers });
  const done = [], skipped = [], manual = [];

  console.log(bold('\nMarquee setup') + dim(opts.dryRun ? '  (dry run: nothing will be written or run)' : ''));
  const info = await detect.detectAll(process.env, { encoders: false });
  if (!info.node.ok || !info.sqlite.ok) {
    throw new Error(`Marquee needs Node.js ${info.node.minimum} or later (this is ${info.node.version}${info.sqlite.ok ? '' : `; ${info.sqlite.reason}`}). Install the current LTS from nodejs.org or your package manager.`);
  }
  console.log(`${mark.ok} ${info.os.name} ${info.os.arch}${info.os.wsl ? ' (WSL)' : ''}${info.os.container ? ' (container)' : ''}, Node.js ${info.node.version}`);

  const { existing, text, values } = loadEnv(envFile);
  console.log(existing === null ? `${mark.info} No .env yet: starting from .env.example` : `${mark.ok} Found ${envFile}: existing settings are kept`);
  const cur = (k, d = '') => values[k] ?? d;
  const set = {};

  // Library and data
  const media = await ask.text('MEDIA_DIR', 'Folder with your films and shows (MEDIA_DIR)', cur('MEDIA_DIR') || defaultMediaDir());
  set.MEDIA_DIR = media;
  if (media && !fs.existsSync(media)) {
    if (opts.dryRun) console.log(`  would create ${media}`);
    else { try { fs.mkdirSync(media, { recursive: true }); done.push(`Created ${media}`); } catch (e) { manual.push(`Create ${media} (${e.code})`); } }
  }
  const freshInstall = !fs.existsSync(path.join(cur('DATA_DIR') || APP_DIR, '.marquee.db'));
  if (freshInstall && ('DATA_DIR' in answers || !opts.yes)) {
    set.DATA_DIR = await ask.text('DATA_DIR', 'Folder for Marquee\'s database and state (blank = the Marquee folder)', cur('DATA_DIR'));
  }

  // Network
  let port = Number(await ask.text('PORT', 'Port for the web app', cur('PORT', '8080')));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${port}`);
  const running = await health(port);
  if (!running && !(await portFree(port))) {
    console.log(`${mark.warn} Port ${port} is in use by another program.`);
    if (!opts.yes) port = Number(await ask.text(null, 'Pick another port', String(port + 1)));
    else manual.push(`Port ${port} is busy: set PORT in .env to a free port`);
  }
  set.PORT = String(port);
  set.HOST = await ask.choose('HOST', 'Who can open Marquee?', [
    ['0.0.0.0', 'Devices on my home network (recommended)'],
    ['127.0.0.1', 'Only this computer (a reverse proxy or tunnel on this machine publishes it)'],
  ], cur('HOST', '0.0.0.0'));

  // Integrations
  set.TMDB_TOKEN = await ask.text('TMDB_TOKEN', 'TMDB API Read Access Token for search and posters (themoviedb.org → Settings → API; blank = skip)', cur('TMDB_TOKEN'), { secret: true });
  const wantQbit = 'QBIT_URL' in answers ? Boolean(answers.QBIT_URL) : cur('QBIT_URL') ? true : opts.yes ? false : await ask.confirm('Use qBittorrent for downloads?', { dflt: false });
  if (wantQbit) {
    set.QBIT_URL = await ask.text('QBIT_URL', 'qBittorrent Web UI address', cur('QBIT_URL', 'http://localhost:8081'));
    set.QBIT_USER = await ask.text('QBIT_USER', 'qBittorrent user', cur('QBIT_USER', 'admin'));
    set.QBIT_PASS = await ask.text('QBIT_PASS', 'qBittorrent password', cur('QBIT_PASS'), { secret: true });
  } else if ('QBIT_URL' in answers || !cur('QBIT_URL')) { set.QBIT_URL = ''; skipped.push('Downloads: no qBittorrent configured'); }
  set.OPENSUBTITLES_API_KEY = await ask.text('OPENSUBTITLES_API_KEY', 'OpenSubtitles API key for subtitles (blank = skip)', cur('OPENSUBTITLES_API_KEY'), { secret: true });

  // Remote access
  const remote = await ask.choose('remoteAccess', 'Remote access (outside your home network)?', [
    ['none', 'None: home network only (recommended to start)'],
    ['tailscale', 'Tailscale: your own devices, anywhere'],
    ['cloudflare', 'Cloudflare Tunnel + Access: share with family and friends, with personal accounts'],
    ['proxy', 'My own reverse proxy with authentication (Caddy, nginx)'],
  ], cur('CF_ACCESS_TEAM_DOMAIN') || cur('ADMIN_EMAILS') ? 'cloudflare' : 'none');
  if (remote === 'cloudflare') {
    set.ADMIN_EMAILS = await ask.text('ADMIN_EMAILS', 'Owner email(s) as signed in through Cloudflare Access, comma-separated', cur('ADMIN_EMAILS'));
    set.CF_ACCESS_TEAM_DOMAIN = await ask.text('CF_ACCESS_TEAM_DOMAIN', 'Access team domain, e.g. myteam.cloudflareaccess.com (blank = trust cloudflared on this machine)', cur('CF_ACCESS_TEAM_DOMAIN'));
    if (set.CF_ACCESS_TEAM_DOMAIN) set.CF_ACCESS_AUD = await ask.text('CF_ACCESS_AUD', 'Access application AUD tag', cur('CF_ACCESS_AUD'), { secret: true });
    set.PUBLIC_URL = await ask.text('PUBLIC_URL', 'Public address, e.g. https://marquee.example.com', cur('PUBLIC_URL'));
    manual.push('Finish Cloudflare Tunnel + Access: docs/remote-access.md#cloudflare-tunnel-and-access');
  } else if (remote === 'tailscale') manual.push('Install Tailscale and open http://<this machine\'s tailnet name>:' + port + ' (docs/remote-access.md#tailscale)');
  else if (remote === 'proxy') manual.push('Put Marquee behind an authenticating proxy: docs/remote-access.md#reverse-proxy');

  // Secrets for the optional agents: generated once, never shown.
  for (const key of ['HOUSE_TOKEN', 'SCREENTIME_TOKEN']) {
    if (!cur(key)) { set[key] = newSecret(); done.push(`Generated ${key}`); }
  }
  for (const [k, v] of Object.entries(answers)) if (/^[A-Z][A-Z0-9_]*$/.test(k) && !(k in set)) set[k] = String(v ?? '');

  // Write .env: only keys whose value differs.
  const changes = Object.fromEntries(Object.entries(set).filter(([k, v]) => v !== undefined && (values[k] ?? '') !== v
    && !(existing === null && v === '' && !(k in parseEnv(text)))));
  const newText = updateEnvText(text, changes);
  if (Object.keys(changes).length || existing === null) {
    console.log(`\n${existing === null ? 'Creating' : 'Updating'} ${envFile}:`);
    for (const [k, v] of Object.entries(changes)) console.log(`  ${k}=${redact(k, v)}`);
    if (!opts.dryRun) { writeEnvFile(envFile, newText); done.push(existing === null ? 'Created .env' : `Updated .env (${Object.keys(changes).length} setting(s); previous copy in .env.bak)`); }
  } else console.log(`\n${mark.ok} .env already up to date`);
  const env = { ...parseEnv(newText) };

  // Tools
  console.log(bold('\nTools'));
  const ff = detect.ffmpegInfo(env);
  const installs = [];
  if (ff.version) console.log(`${mark.ok} ffmpeg ${ff.version}${ff.ffprobeOk ? '' : ', but no ffprobe'}`);
  else { console.log(`${mark.warn} ffmpeg not found: conversion, subtitle timing, previews and clip sharing stay off`); installs.push('ffmpeg'); }
  if (process.platform !== 'win32' && !detect.which(env.TESSERACT || 'tesseract')) installs.push('tesseract');
  const wanted = Array.isArray(answers.install) ? answers.install : installs;
  const manager = info.packageManagers[0];
  for (const pkg of wanted) {
    const plan = manager && installCommand(pkg, manager);
    if (!plan) { manual.push(`Install ${pkg} (no supported package manager found)`); continue; }
    console.log(`  To install ${pkg}:`);
    for (const c of plan.commands) console.log(`    ${c.join(' ')}`);
    if (plan.note) console.log(`    ${dim(plan.note)}`);
    const why = pkg === 'tesseract' ? 'Notes image search' : 'video conversion and previews';
    const ok = await ask.confirm(`Install ${pkg} now (for ${why})${plan.sudo ? ' using sudo' : ''}?`, { allow: 'install', allowed: opts.allow });
    if (!ok || (plan.sudo && opts.yes && !opts.allow.has('sudo'))) { skipped.push(`${pkg} not installed`); continue; }
    if (opts.dryRun) continue;
    const success = plan.commands.every((c) => spawnSync(c[0], c.slice(1), { stdio: 'inherit' }).status === 0);
    (success ? done : manual).push(success ? `Installed ${pkg}` : `Install ${pkg} manually (the command failed)`);
  }

  // Integrations
  let integrations = [];
  if (!opts.offline) {
    console.log(bold('\nIntegrations'));
    integrations = await checkIntegrations(env);
    for (const r of integrations) console.log(`${r.ok ? mark.ok : mark.warn} ${r.name}: ${r.detail}`);
    if (!integrations.length) console.log(`${mark.info} none configured`);
    const qbit = integrations.find((r) => r.name === 'qBittorrent' && r.ok);
    const target = env.MEDIA_DIR && path.resolve(env.MEDIA_DIR);
    if (qbit && target && answers.qbitSavePath !== false && path.resolve(qbit.savePath || '') !== target) {
      console.log(`  qBittorrent saves to ${qbit.savePath}; Marquee's library is ${target}.`);
      const ok = answers.qbitSavePath === true ? opts.allow.has('qbit-config') : await ask.confirm(`Change qBittorrent's default save path to ${target}?`, { allow: 'qbit-config', allowed: opts.allow });
      if (ok && !opts.dryRun) { const r = await setQbitSavePath(env, target); (r.ok ? done : manual).push(r.ok ? `qBittorrent ${r.detail}` : `Set qBittorrent's save path by hand (${r.detail})`); }
      else if (!ok) manual.push('Downloads land outside MEDIA_DIR until qBittorrent\'s save path points inside it');
    }
  }

  // Autostart
  console.log(bold('\nAutostart'));
  const mgr = serviceManager();
  let startup = 'not set up (start with: npm start)';
  if (info.os.container) { startup = 'managed by the container runtime'; console.log(`${mark.info} Running in a container: no service needed`); }
  else if (!mgr) { console.log(`${mark.warn} No supported service manager found`); manual.push('Start Marquee with your init system: see docs/install/'); }
  else {
    const scope = opts.scope || answers.serviceScope || defaultScope(info);
    const plan = servicePlan('install', { manager: mgr, appDir: APP_DIR, scope, mediaDir: env.MEDIA_DIR || null, dataDir: env.DATA_DIR || null });
    const wants = 'autostart' in answers ? Boolean(answers.autostart) : !opts.yes || opts.allow.has('service');
    const ok = wants && await ask.confirm(`Start Marquee automatically at boot (${mgr}${mgr === 'systemd' ? `, ${scope} service` : ''})?`, { dflt: true, allow: 'service', allowed: opts.allow });
    const needsSudo = plan.some((s) => s.privileged) && process.platform !== 'win32' && !isRoot();
    if (ok && needsSudo && opts.yes && !opts.allow.has('sudo')) {
      skipped.push('Autostart: needs --allow-sudo for a system service (or use --scope user)');
    } else if (ok) {
      console.log('  Steps:');
      if (runPlan(plan, { dryRun: opts.dryRun })) { done.push(`Autostart via ${mgr}`); startup = mgr; } else manual.push('Autostart failed: see the output above, then run node setup.js service install');
    } else { skipped.push('Autostart not set up (node setup.js service install)'); }
  }

  if (!env.CLIPS_DIR) skipped.push('Game clips: not set up (node setup.js clipper)');

  // Summary
  const lan = info.lan[0]?.address;
  console.log(bold('\nSummary'));
  for (const d of done) console.log(`${mark.ok} ${d}`);
  for (const s of skipped) console.log(`${mark.info} ${s}`);
  for (const r of integrations.filter((x) => !x.ok)) console.log(`${mark.warn} ${r.name}: ${r.detail}`);
  for (const w of checkConfig(env, { tools: false }).filter((c) => c.level !== 'info')) console.log(`${mark.warn} ${w.message}. ${w.fix}`);
  console.log(`\n  Open:     http://${env.HOST === '127.0.0.1' ? '127.0.0.1' : lan || 'localhost'}:${env.PORT || 8080}`);
  console.log(`  Startup:  ${startup}`);
  console.log(`  Check:    node setup.js doctor`);
  if (manual.length) { console.log(bold('\nStill to do')); for (const m of manual) console.log(`  - ${m}`); }
  if (opts.dryRun) console.log(dim('\nDry run: nothing was written or run.'));
  ask.close();
  return 0;
}

async function doctor(opts) {
  const envFile = opts.envFile ? path.resolve(opts.envFile) : ENV_FILE;
  const fileEnv = parseEnv(readEnvFile(envFile) ?? '');
  const env = { ...fileEnv, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^[A-Z][A-Z0-9_]*$/.test(k))) };
  let errors = 0, warnings = 0;
  const report = (level, msg, fix) => {
    if (level === 'error') errors++; if (level === 'warn') warnings++;
    console.log(`${mark[level]} ${msg}${fix ? `\n    ${dim(fix)}` : ''}`);
  };
  console.log(bold('\nMarquee doctor') + dim(`  ${APP_DIR}`));

  console.log(bold('\nRuntime'));
  const info = await detect.detectAll(env);
  report(info.node.ok ? 'ok' : 'error', `Node.js ${info.node.version}${info.node.ok ? '' : ` (needs ${info.node.minimum} or later)`}`);
  report(info.sqlite.ok ? 'ok' : 'error', info.sqlite.ok ? 'node:sqlite with FTS5' : info.sqlite.reason, info.sqlite.ok ? null : 'Upgrade Node.js to the current LTS.');
  report('info', `${info.os.name} ${info.os.arch}${info.os.wsl ? ' (WSL)' : ''}${info.os.container ? ' (container)' : ''}`);
  for (const f of ['server.js', 'src/server.js', 'public/index.html', 'package.json']) if (!fs.existsSync(path.join(APP_DIR, f))) report('error', `Missing ${f}`, 'The installation is incomplete: reinstall or run the installer again.');

  console.log(bold('\nConfiguration'));
  report(fs.existsSync(envFile) ? 'ok' : 'warn', fs.existsSync(envFile) ? `.env at ${envFile}` : 'No .env file', fs.existsSync(envFile) ? null : 'Run node setup.js.');
  for (const c of checkConfig(env, { tools: false })) report(c.level, c.message, c.fix);

  console.log(bold('\nData'));
  const dataDir = env.DATA_DIR ? path.resolve(env.DATA_DIR) : APP_DIR;
  const problem = dataDirProblem(dataDir, APP_DIR);
  if (problem) report('error', problem);
  try { fs.accessSync(dataDir, fs.constants.W_OK); report('ok', `Data folder ${dataDir} is writable`); } catch (e) { report('error', `Data folder ${dataDir}: ${e.code}`, 'Create it and give the Marquee account write access.'); }
  const db = path.join(dataDir, '.marquee.db');
  if (fs.existsSync(db)) report('ok', `Database ${(fs.statSync(db).size / 1048576).toFixed(1)} MB, ${STATE_FILES.filter((f) => fs.existsSync(path.join(dataDir, f))).length} state files`);
  else report('info', 'No database yet (created on first start)');
  for (const [label, dir] of [['data', dataDir], ['media', env.MEDIA_DIR]]) {
    if (!dir) continue;
    const d = detect.diskSpace(dir);
    if (d.error) continue;
    report(d.free < 5 * 1024 ** 3 ? 'warn' : 'ok', `${gib(d.free)} free on the ${label} drive (${d.path})`, d.free < 5 * 1024 ** 3 ? 'Downloads and conversions need room; free some space.' : null);
  }

  console.log(bold('\nMedia tools'));
  const ff = info.ffmpeg;
  if (!ff.ffmpeg || ff.error) report('warn', ff.error || 'ffmpeg not found', 'Install ffmpeg (node setup.js) or set FFMPEG/FFPROBE.');
  else {
    report(ff.ffprobeOk ? 'ok' : 'warn', `ffmpeg ${ff.version}${ff.ffprobeOk ? ' and ffprobe' : ', ffprobe missing'}`);
    const nv = ff.encoders.nvenc;
    report('ok', `Encoder Marquee will use: ${nv?.works ? 'NVIDIA NVENC (h264_nvenc)' : ff.libx264 ? 'libx264 on the CPU' : 'none found (no libx264)'}`,
      nv && !nv.works ? `h264_nvenc is listed but a test encode failed: ${nv.error}` : null);
    const others = Object.values(ff.encoders).filter((e) => !e.used);
    for (const e of others) report('info', `${e.label}: ${e.works ? 'works in ffmpeg, not used by Marquee yet' : `listed but not working (${e.error})`}`);
  }
  if (info.gpus.length) report('info', `GPU: ${info.gpus.join('; ')}`);
  report(info.tesseract ? 'ok' : 'info', info.tesseract === 'windows-ocr' ? 'Notes OCR: Windows OCR' : info.tesseract ? `Notes OCR: Tesseract (${info.tesseract})` : 'Notes OCR off (install tesseract to search text in images)');
  if (String(env.CAST_APPLETV || 'on') !== 'off') report(info.pyatv.works ? 'ok' : 'info', info.pyatv.works ? `Apple TV: ${info.pyatv.atvscript}` : 'Apple TV casting off (pipx install pyatv)');
  if (process.platform !== 'win32') report('info', 'House → Sharing CPU/GPU history uses Windows performance counters and is off on this system');

  console.log(bold('\nServer'));
  const port = Number(env.PORT || 8080);
  const h = await health(port);
  if (h) report('ok', `Marquee ${h.version} is answering on port ${port}`);
  else if (await portFree(port)) report('warn', `Marquee isn't running on port ${port}`, 'Start it: npm start, or node setup.js service restart.');
  else if (await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false)) report('warn', `An older Marquee is running on port ${port}`, 'Restart it to run this version: node setup.js service restart.');
  else report('error', `Port ${port} is used by another program`, 'Stop it or change PORT in .env.');
  const mgr = serviceManager();
  if (mgr) {
    const plan = servicePlan('status', { manager: mgr, appDir: APP_DIR, scope: opts.scope || defaultScope(info) });
    const [cmd, ...args] = plan[0].cmd;
    const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    const installed = r.status === 0 || /active|running|Ready|Running/.test(r.stdout || '');
    report(installed ? 'ok' : 'info', installed ? `Autostart: ${mgr}` : `Autostart not set up (${mgr}); node setup.js service install`);
  }

  if (!opts.offline) {
    console.log(bold('\nIntegrations'));
    const results = await checkIntegrations(env);
    if (!results.length) report('info', 'None configured');
    for (const r of results) report(r.ok ? 'ok' : 'warn', `${r.name}: ${r.detail}`);
  }

  console.log(`\n${errors ? red(`${errors} problem(s)`) : green('No problems')}${warnings ? `, ${yellow(`${warnings} warning(s)`)}` : ''}`);
  return errors ? 1 : 0;
}

async function service(opts) {
  const mgr = serviceManager();
  const info = { os: detect.osInfo() };
  const fileEnv = parseEnv(readEnvFile(opts.envFile ? path.resolve(opts.envFile) : ENV_FILE) ?? '');
  const steps = servicePlan(opts.action, { manager: mgr, appDir: APP_DIR, scope: opts.scope || defaultScope(info), mediaDir: fileEnv.MEDIA_DIR || null, dataDir: fileEnv.DATA_DIR || null });
  console.log(`${opts.action} (${mgr}):`);
  if (steps.some((s) => s.privileged) && !opts.dryRun && !opts.yes && process.stdin.isTTY) {
    const ask = new Prompter({ yes: false });
    const ok = await ask.confirm(`These steps need ${process.platform === 'win32' ? 'an elevated PowerShell' : 'root (sudo)'}. Continue?`, { dflt: true });
    ask.close();
    if (!ok) return 1;
  } else if (steps.some((s) => s.privileged) && opts.yes && !opts.allow.has('sudo') && process.platform !== 'win32' && !isRoot()) {
    throw new Error('These steps need sudo: add --allow-sudo, or use --scope user.');
  }
  return runPlan(steps, { dryRun: opts.dryRun }) ? 0 : 1;
}

async function clipperSetup(opts) {
  const envFile = opts.envFile ? path.resolve(opts.envFile) : ENV_FILE;
  const answers = opts.config ? JSON.parse(fs.readFileSync(opts.config, 'utf8')) : {};
  const ask = new Prompter({ yes: opts.yes, answers });
  const { existing, text, values } = loadEnv(envFile);
  const env = { ...values };
  console.log(bold('\nGame clips') + dim(opts.dryRun ? '  (dry run: nothing will be written or run)' : ''));
  console.log(dim('Clipper keeps the last 90 s of your screen in memory; a hotkey saves it, and kept clips land in'));
  console.log(dim('Marquee\'s Clips tab. https://github.com/' + clipper.CLIPPER_REPO));

  // 1. The folder
  const clipsDir = path.resolve(opts.clipsDir || await ask.text('CLIPS_DIR', 'Folder for game clips (CLIPS_DIR)', values.CLIPS_DIR || clipper.defaultClipsDir(env)));
  if (opts.dryRun) console.log(`  would create ${clipsDir}${path.sep}Kept`);
  else clipper.prepareClipsDir(clipsDir);
  console.log(`${mark.ok} Clips folder: ${clipsDir}`);
  let restartNeeded = false;
  if ((values.CLIPS_DIR ? path.resolve(values.CLIPS_DIR) : '') !== clipsDir) {
    if (!opts.dryRun) writeEnvFile(envFile, updateEnvText(text, { CLIPS_DIR: clipsDir }));
    console.log(`${mark.ok} ${opts.dryRun ? 'Would set' : existing === null ? 'Created' : 'Updated'} ${envFile}: CLIPS_DIR=${clipsDir}`);
    restartNeeded = true;
  }

  // 2. Where the games run, and how good the clips should be
  const desktop = process.platform === 'win32' || (process.platform === 'linux' && Boolean(process.env.XDG_SESSION_TYPE || process.env.WAYLAND_DISPLAY || process.env.DISPLAY));
  const where = opts.where || await ask.choose('where', 'Where do you play?', [
    ['here', 'On this computer: download and install Clipper here'],
    ['windows', 'On another Windows PC: show the commands to run there'],
    ['linux', 'On another Linux PC: show the commands to run there'],
    ['none', 'Nowhere yet: just the folder'],
  ], desktop && process.platform !== 'darwin' ? 'here' : 'windows');
  const quality = opts.quality || (where === 'none' ? 'balanced' : await ask.choose('quality', 'Clip quality?', clipper.QUALITY_CHOICES, 'balanced'));
  const q = clipper.parseQuality(quality);
  const lan = detect.lanAddresses()[0]?.address;
  const marqueeUrl = values.PUBLIC_URL || `http://${lan || os.hostname()}:${values.PORT || 8080}`;

  let status = 0;
  if (where === 'here') {
    if (!['linux', 'win32'].includes(process.platform)) throw new Error('Clipper records on Linux and Windows. Use --remote windows|linux for your gaming PC.');
    const src = opts.clipperSource ? path.resolve(opts.clipperSource)
      : process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'clipper', 'src')
        : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'clipper', 'src');
    if (process.platform === 'linux' && clipsDir === path.join(os.homedir(), 'Videos', 'Clips')) {
      throw new Error(`${clipsDir} is Clipper's own working folder (it empties it as clips move on). Pick another CLIPS_DIR.`);
    }
    const cmd = clipper.localInstallCommand({ src, clipsDir, marqueeUrl, quality, yes: opts.yes });
    console.log(`\n  ${opts.clipperSource ? `From ${src}` : `Download ${clipper.clipperTarball()} → ${src}`}, then:`);
    console.log(`  ${dim('$')} ${cmd.join(' ')}`);
    if (q.bench) console.log(dim(`  The benchmark records 8 s of you playing: have a game running when it counts down.`));
    const ok = opts.dryRun || await ask.confirm('Install Clipper on this computer now?', { dflt: true, allow: 'install', allowed: opts.allow });
    if (!ok) { console.log(`${mark.info} Skipped. Run the command above when you're ready.`); }
    else if (!opts.dryRun) {
      if (!opts.clipperSource) await clipper.downloadClipper(src, { spawn: spawnSync });
      const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
      if (r.status === 0) console.log(`${mark.ok} Clipper is installed; kept clips go to ${clipsDir}`);
      else { console.log(`${mark.error} Clipper's installer failed (see above)`); status = 1; }
    }
  } else if (where === 'windows' || where === 'linux') {
    const host = os.hostname();
    const share = clipper.shareInstructions({ clipsDir, host, target: where });
    const reach = opts.share || await ask.text('share', where === 'windows' ? 'How the gaming PC reaches the folder' : 'Where the gaming PC mounts the folder', share.share);
    console.log(bold('\nOn this server'));
    for (const l of share.lines) console.log(`  ${l}`);
    console.log(bold(`\nOn the gaming PC (${where === 'windows' ? 'PowerShell' : 'a terminal'})`));
    console.log(`  ${clipper.remoteInstallCommand({ target: where, share: reach, marqueeUrl, quality })}`);
    if (q.bench) console.log(dim('  Start a game before running it: the benchmark records 8 s of you playing.'));
  }
  if (restartNeeded) console.log(`\n${mark.warn} Restart Marquee to show the Clips tab: node setup.js service restart`);
  console.log(dim('\nThe Clips tab is for the owner (ADMIN_EMAILS); see docs/integrations.md#clips-and-discord-share-links.'));
  ask.close();
  return status;
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  if (opts.help) { console.log(HELP); return 0; }
  try {
    if (opts.command === 'doctor') return await doctor(opts);
    if (opts.command === 'service') return await service(opts);
    if (opts.command === 'clipper') return await clipperSetup(opts);
    if (opts.command === 'backup' || opts.command === 'migrate-data') {
      const env = { ...parseEnv(readEnvFile(opts.envFile ? path.resolve(opts.envFile) : ENV_FILE) ?? ''), ...process.env };
      const dataDir = env.DATA_DIR ? path.resolve(env.DATA_DIR) : APP_DIR;
      if (opts.command === 'backup') {
        const r = await backup({ dataDir, dest: opts.to && path.resolve(opts.to), notesDir: env.NOTES_FILES_DIR || null, log: (m) => console.log(`  ${m}`) });
        console.log(`${mark.ok} Backup in ${r.dest}: ${r.files.join(', ') || 'nothing to back up'}`);
        console.log(dim('  .env is not included because it holds passwords; copy it separately to somewhere safe.'));
        return 0;
      }
      const to = opts.to ? path.resolve(opts.to) : env.DATA_DIR && path.resolve(env.DATA_DIR);
      if (!to) throw new Error('Say where to: node setup.js migrate-data --to /path/to/data');
      if (await health(Number(env.PORT || 8080))) throw new Error('Marquee is running. Stop it first, then run migrate-data again.');
      await migrateData({ from: APP_DIR, to, dryRun: opts.dryRun });
      if (!opts.dryRun && path.resolve(env.DATA_DIR || APP_DIR) !== to) {
        const file = opts.envFile ? path.resolve(opts.envFile) : ENV_FILE;
        writeEnvFile(file, updateEnvText(readEnvFile(file) ?? '', { DATA_DIR: to }));
        console.log(`${mark.ok} Set DATA_DIR=${to} in ${file}`);
      }
      return 0;
    }
    return await setup(opts);
  } catch (e) {
    console.error(`\n${mark.error} ${e.message}`);
    return 1;
  }
}
