import test from 'node:test';
import { FROM_ENV_FILE } from '../src/env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/setup/cli.js';
import { updateEnvText, parseEnv, formatValue, writeEnvFile, redact } from '../src/setup/envfile.js';
import { servicePlan, systemdUnit, describeStep } from '../src/setup/services.js';
import { installCommand } from '../src/setup/packages.js';
import { nodeVersion, lanAddresses, which } from '../src/setup/detect.js';
import { dataDirProblem } from '../src/paths.js';
import { migrateData, backup } from '../src/setup/data.js';
import { checkConfig } from '../src/config-check.js';
import { checkQbit, checkTmdb, checkIntegrations } from '../src/setup/integrations.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const tmp = (t, name) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `lilin-${name}-`)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test('arguments: commands, consent flags and errors', () => {
  const a = parseArgs(['--yes', '--dry-run', '--allow-install', '--allow-sudo', '--offline']);
  assert.equal(a.command, 'setup'); assert.ok(a.yes && a.dryRun && a.offline);
  assert.deepEqual([...a.allow].sort(), ['install', 'sudo']);
  assert.equal(parseArgs(['--config', 'a.json']).yes, true, '--config implies unattended');
  assert.equal(parseArgs(['doctor']).command, 'doctor');
  assert.deepEqual([parseArgs(['service', 'status']).command, parseArgs(['service', 'status']).action], ['service', 'status']);
  assert.throws(() => parseArgs(['service', 'explode']), /install\|status/);
  assert.throws(() => parseArgs(['--bogus']), /Unknown option/);
  assert.throws(() => parseArgs(['--config']), /needs a value/);
  assert.throws(() => parseArgs(['--scope', 'world']), /user or system/);
});

test('.env edits keep comments, unknown keys, order and line endings', () => {
  const text = '# header\r\nPORT=8080\r\n# keep me\r\nCUSTOM_THING=yes # inline\r\nTMDB_TOKEN=\r\n';
  const out = updateEnvText(text, { TMDB_TOKEN: 'abc', MEDIA_DIR: 'C:\\My Media', PORT: '9000' });
  assert.equal(out, '# header\r\nPORT=9000\r\n# keep me\r\nCUSTOM_THING=yes # inline\r\nTMDB_TOKEN=abc\r\n\r\n# Added by setup.js\r\nMEDIA_DIR="C:\\My Media"\r\n');
  const parsed = parseEnv(out);
  assert.equal(parsed.MEDIA_DIR, 'C:\\My Media');
  assert.equal(parsed.CUSTOM_THING, 'yes');
  assert.equal(updateEnvText(out, {}), out, 'no changes, no edits');
  for (const v of ['plain', 'with space', 'hash#tag', "it's", 'say "hi"', '']) assert.equal(parseEnv(`K=${formatValue(v)}`).K, v);
  assert.throws(() => formatValue(`both ' and "`), /both/);
  assert.equal(redact('QBIT_PASS', 'secret'), '••••••');
  assert.equal(redact('PORT', '8080'), '8080');
});

test('.env is written atomically with a backup and owner-only permissions for new files', (t) => {
  const dir = tmp(t, 'envfile');
  const file = path.join(dir, '.env');
  writeEnvFile(file, 'A=1\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  writeEnvFile(file, 'A=2\n');
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), 'A=1\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'A=2\n');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.env', '.env.bak']);
});

// The test process has loaded this checkout's own .env (src/env.js) into process.env; on a machine where
// Lilin is installed those values would reach setup as if they were real environment variables.
const realEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !FROM_ENV_FILE.has(k)));
const runSetup = (args, env = {}) => spawnSync(process.execPath, ['setup.js', ...args], {
  cwd: root, encoding: 'utf8', timeout: 60000, env: { ...realEnv(), NO_COLOR: '1', ...env },
});

test('unattended setup creates .env from answers, generates secrets once, and is idempotent', (t) => {
  const dir = tmp(t, 'setup');
  const envFile = path.join(dir, '.env');
  const media = path.join(dir, 'media');
  const answers = path.join(dir, 'answers.json');
  fs.writeFileSync(answers, JSON.stringify({ MEDIA_DIR: media, PORT: '18765', TMDB_TOKEN: 'tmdb-secret-value', autostart: false, install: [], CUSTOM_KEY: 'kept' }));

  const dry = runSetup(['--config', answers, '--env', envFile, '--offline', '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr + dry.stdout);
  assert.ok(!fs.existsSync(envFile), 'dry run writes nothing');
  assert.ok(!fs.existsSync(media), 'dry run creates nothing');

  const first = runSetup(['--config', answers, '--env', envFile, '--offline']);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  assert.ok(!first.stdout.includes('tmdb-secret-value'), 'secrets are never printed');
  const env = parseEnv(fs.readFileSync(envFile, 'utf8'));
  assert.equal(env.MEDIA_DIR, media); assert.equal(env.PORT, '18765'); assert.equal(env.CUSTOM_KEY, 'kept');
  assert.match(env.HOUSE_TOKEN, /^[a-f0-9]{48}$/); assert.match(env.SCREENTIME_TOKEN, /^[a-f0-9]{48}$/);
  assert.notEqual(env.HOUSE_TOKEN, env.SCREENTIME_TOKEN);
  assert.ok(fs.statSync(media).isDirectory());
  assert.ok(fs.readFileSync(envFile, 'utf8').includes('# ---- Server ----'), 'built from .env.example, comments included');

  // The user edits by hand, then re-runs setup: their edits and tokens survive.
  fs.appendFileSync(envFile, '# my note\nMY_OWN=1\n');
  const before = fs.readFileSync(envFile, 'utf8');
  const again = runSetup(['--config', answers, '--env', envFile, '--offline']);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.equal(fs.readFileSync(envFile, 'utf8'), before, 'second run changes nothing');
  assert.match(again.stdout, /already up to date/);
});

test('--yes never grants installs, sudo or services by itself', (t) => {
  const dir = tmp(t, 'consent');
  const answers = path.join(dir, 'a.json');
  fs.writeFileSync(answers, JSON.stringify({ MEDIA_DIR: path.join(dir, 'm'), PORT: '18766', install: ['ffmpeg'], autostart: true }));
  const r = runSetup(['--config', answers, '--env', path.join(dir, '.env'), '--offline', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /Installed ffmpeg|Autostart via/);
});

test('setup refuses an unsupported Node version with an actionable message', () => {
  assert.equal(nodeVersion('22.15.1').ok, false);
  assert.equal(nodeVersion('22.16.0').ok, true);
  assert.equal(nodeVersion('24.1.0').ok, true);
  assert.equal(nodeVersion('20.18.0').minimum, '22.16.0');
});

test('LAN detection skips loopback, link-local, VPN and container interfaces', () => {
  const lan = lanAddresses({
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.20', mac: 'aa:bb:cc:dd:ee:ff', netmask: '255.255.255.0' }],
    wg0: [{ family: 'IPv4', internal: false, address: '10.64.0.2', mac: '00:00:00:00:00:00', netmask: '255.255.255.255' }],
    docker0: [{ family: 'IPv4', internal: false, address: '172.17.0.1', mac: '02:42:00:00:00:00', netmask: '255.255.0.0' }],
    eth1: [{ family: 'IPv4', internal: false, address: '169.254.3.3', mac: 'aa:bb:cc:dd:ee:00', netmask: '255.255.0.0' }],
  });
  assert.deepEqual(lan.map((x) => x.address), ['192.168.1.20']);
  assert.equal(which('definitely-not-a-real-command-xyz'), null);
});

test('service plans: systemd waits for mounts, system scope needs root, user scope does not', () => {
  const unit = systemdUnit({ appDir: '/opt/lilin', node: '/usr/bin/node', user: 'lilin', mediaDir: '/mnt/nas/media' });
  assert.match(unit, /RequiresMountsFor=\/mnt\/nas\/media/);
  assert.match(unit, /After=network-online.target/);
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/opt\/lilin\/server.js/);
  assert.match(unit, /User=lilin/);
  assert.match(unit, /WantedBy=multi-user.target/);
  const sys = servicePlan('install', { manager: 'systemd', appDir: '/opt/lilin', node: '/usr/bin/node', scope: 'system', user: 'lilin' });
  assert.ok(sys.every((s) => s.privileged));
  assert.equal(sys[0].write.path, '/etc/systemd/system/lilin.service');
  const usr = servicePlan('install', { manager: 'systemd', appDir: '/opt/lilin', node: '/usr/bin/node', scope: 'user', user: 'me', home: '/home/me' });
  assert.equal(usr[0].write.path, '/home/me/.config/systemd/user/lilin.service');
  assert.match(usr[0].write.content, /WantedBy=default.target/);
  assert.ok(!usr.some((s) => s.privileged));
  assert.deepEqual(usr.at(-1).cmd, ['loginctl', 'enable-linger', 'me']);
  // Re-running writes the same file at the same path: no duplicate units.
  assert.deepEqual(servicePlan('install', { manager: 'systemd', appDir: '/opt/lilin', node: '/usr/bin/node', scope: 'user', user: 'me', home: '/home/me' }), usr);
  assert.equal(describeStep(sys[1], { sudo: true }), 'sudo systemctl daemon-reload');
  const mac = servicePlan('install', { manager: 'launchd', appDir: '/Users/me/lilin', node: '/opt/homebrew/bin/node', home: '/Users/me' });
  assert.match(mac[0].write.content, /<key>RunAtLoad<\/key><true\/>/);
  const win = servicePlan('install', { manager: 'task-scheduler', appDir: 'C:\\lilin' });
  assert.ok(win[0].cmd.at(-1).endsWith('install-service.ps1'));
  assert.ok(servicePlan('uninstall', { manager: 'openrc', appDir: '/opt/lilin', user: 'lilin' }).some((s) => s.remove === '/etc/init.d/lilin'));
  assert.throws(() => servicePlan('install', { manager: null, appDir: '/x' }), /No supported service manager/);
});

test('package commands use sudo only for Linux system package managers', () => {
  const apt = installCommand('ffmpeg', 'apt', { isRoot: false });
  assert.deepEqual(apt.commands, [['sudo', 'apt-get', 'update'], ['sudo', 'apt-get', 'install', '-y', 'ffmpeg']]);
  assert.equal(installCommand('ffmpeg', 'apt', { isRoot: true }).commands[1][0], 'apt-get');
  assert.equal(installCommand('ffmpeg', 'brew').sudo, false);
  assert.equal(installCommand('ffmpeg', 'winget').sudo, false);
  assert.match(installCommand('ffmpeg', 'dnf', { isRoot: false }).note, /RPM Fusion/);
  assert.equal(installCommand('tesseract', 'winget'), null, 'Windows has OCR built in');
});

test('DATA_DIR guard refuses to strand an existing database', (t) => {
  const app = tmp(t, 'app');
  const data = path.join(app, 'data');
  assert.equal(dataDirProblem(app, app), null);
  assert.equal(dataDirProblem(data, app), null, 'fresh install: nothing to strand');
  fs.writeFileSync(path.join(app, '.lilin.db'), '');
  assert.match(dataDirProblem(data, app), /migrate-data/);
});

test('migrate-data copies state, verifies it and sets the originals aside', async (t) => {
  const app = tmp(t, 'migrate');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(app, '.lilin.db'));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept')");
  fs.writeFileSync(path.join(app, '.lilin-shows.json'), '{"a":1}');
  fs.mkdirSync(path.join(app, '.lilin-notes-files')); fs.writeFileSync(path.join(app, '.lilin-notes-files', 'x.png'), 'png');
  const data = path.join(app, 'state');
  const dry = await migrateData({ from: app, to: data, dryRun: true, log: () => {} });
  assert.ok(dry.dryRun && !fs.existsSync(data));
  db.close(); // Lilin is stopped during a migration (and Windows can't move an open database)
  const r = await migrateData({ from: app, to: data, log: () => {} });
  const copy = new DatabaseSync(path.join(data, '.lilin.db'));
  assert.equal(copy.prepare('SELECT v FROM t').get().v, 'kept');
  copy.close();
  assert.equal(fs.readFileSync(path.join(data, '.lilin-shows.json'), 'utf8'), '{"a":1}');
  assert.ok(fs.existsSync(path.join(data, '.lilin-notes-files', 'x.png')));
  assert.ok(!fs.existsSync(path.join(app, '.lilin.db')));
  assert.ok(fs.existsSync(path.join(r.aside, '.lilin.db')), 'originals kept aside, not deleted');
  assert.equal(dataDirProblem(data, app), null);
  await assert.rejects(migrateData({ from: app, to: data, log: () => {} }), /already has a database/);
});

test('backup makes a consistent database copy plus state files', async (t) => {
  const dir = tmp(t, 'backup');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dir, '.lilin.db'));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t (v); INSERT INTO t VALUES (1)");
  fs.writeFileSync(path.join(dir, '.lilin-subs.json'), '[]');
  const r = await backup({ dataDir: dir, dest: path.join(dir, 'b') });
  db.close();
  assert.deepEqual(r.files.sort(), ['.lilin-subs.json', '.lilin.db']);
  const copy = new DatabaseSync(path.join(dir, 'b', '.lilin.db'));
  assert.equal(copy.prepare('SELECT count(*) n FROM t').get().n, 1);
  copy.close();
  await assert.rejects(backup({ dataDir: dir, dest: path.join(dir, 'b') }), /isn't empty/);
});

test('config checks catch common mistakes without blocking', (t) => {
  const dir = tmp(t, 'cfg');
  const keys = (env) => checkConfig(env, { tools: false }).filter((c) => c.level !== 'info').map((c) => c.key);
  assert.deepEqual(keys({ MEDIA_DIR: dir }), []);
  assert.deepEqual(keys({ MEDIA_DIR: path.join(dir, 'missing'), PORT: '99999', QBIT_URL: 'localhost:8081', CF_ACCESS_TEAM_DOMAIN: 'x.cloudflareaccess.com', HOUSE_TOKEN: 'short' }).sort(),
    ['CF_ACCESS_AUD', 'HOUSE_TOKEN', 'MEDIA_DIR', 'PORT', 'QBIT_URL']);
});

test('integration checks only call the configured service and never log in twice', async () => {
  const calls = [];
  const fakeFetch = async (url, init = {}) => {
    calls.push([String(url), init.method || 'GET']);
    if (String(url).endsWith('/auth/login')) return new Response('Fails.', { status: 200 });
    return new Response('{}', { status: 200 });
  };
  const r = await checkQbit({ QBIT_URL: 'http://qbit.local:8081/', QBIT_USER: 'u', QBIT_PASS: 'wrong' }, fakeFetch);
  assert.equal(r.ok, false); assert.match(r.detail, /QBIT_USER and QBIT_PASS/);
  assert.deepEqual(calls, [['http://qbit.local:8081/api/v2/auth/login', 'POST']]);
  calls.length = 0;
  const tm = await checkTmdb({ TMDB_TOKEN: 'x' }, async (url) => { calls.push(String(url)); return new Response('', { status: 401 }); });
  assert.equal(tm.ok, false); assert.deepEqual(calls, ['https://api.themoviedb.org/3/configuration']);
  assert.deepEqual(await checkIntegrations({}, async () => assert.fail('nothing configured, nothing fetched')), []);
});

test('clipper: quality names, install commands and share instructions', async () => {
  const c = await import('../src/setup/clipper.js');
  assert.deepEqual(c.parseQuality('max'), { preset: 'max' });
  assert.deepEqual(c.parseQuality('bench'), { bench: 'quality' });
  assert.deepEqual(c.parseQuality('bench:smooth'), { bench: 'smooth' });
  assert.throws(() => c.parseQuality('ultra'), /Unknown quality/);
  assert.throws(() => parseArgs(['clipper', '--quality', 'bench:fast']), /Unknown quality/);
  const a = parseArgs(['clipper', '--remote', 'linux', '--clips-dir', '/srv/clips', '--quality', 'high']);
  assert.deepEqual([a.command, a.where, a.clipsDir, a.quality], ['clipper', 'linux', '/srv/clips', 'high']);
  assert.throws(() => parseArgs(['clipper', '--remote', 'mac']), /windows or linux/);

  assert.equal(c.defaultClipsDir({ MEDIA_DIR: 'D:\\Media' }, 'C:\\Users\\me', 'win32'), 'D:\\Clips');
  assert.equal(c.defaultClipsDir({}, '/home/me', 'linux'), '/home/me/Lilin Clips');

  const win = c.remoteInstallCommand({ target: 'windows', share: "\\\\box\\Clips", lilinUrl: 'http://box:8080', quality: 'bench:smooth' });
  // Pinned commit, installer checksum checked before it runs, never `main` or a pipe into a shell.
  assert.ok(win.includes(`https://raw.githubusercontent.com/Tjabooo/clipper/${c.CLIPPER_COMMIT}/install.ps1 -OutFile $f`));
  assert.ok(win.includes(`(Get-FileHash $f -Algorithm SHA256).Hash -ne '${c.CLIPPER_SCRIPT_SHA256['install.ps1'].toUpperCase()}'`));
  assert.ok(win.includes(`$env:CLIPPER_RELEASE = '${c.CLIPPER_RELEASE}'; $env:CLIPPER_BENCH_SHA256 = '${c.CLIPPER_BINARY_SHA256.windows}';`));
  assert.match(win, new RegExp(`-Ref ${c.CLIPPER_COMMIT} -Share '\\\\\\\\box\\\\Clips' -LilinUrl 'http://box:8080' -Bench smooth$`));
  const lin = c.remoteInstallCommand({ target: 'linux', share: "/mnt/my clips", quality: 'max' });
  assert.equal(lin, `f=$(mktemp) && curl -fsSL https://raw.githubusercontent.com/Tjabooo/clipper/${c.CLIPPER_COMMIT}/install.sh -o "$f" `
    + `&& echo '${c.CLIPPER_SCRIPT_SHA256['install.sh']}  '"$f" | sha256sum -c --quiet - && CLIPPER_REF=${c.CLIPPER_COMMIT} CLIPPER_RELEASE=${c.CLIPPER_RELEASE} CLIPPER_SHA256=${c.CLIPPER_BINARY_SHA256.linux.join(',')} sh "$f" --lilin '/mnt/my clips' --quality max`);
  assert.deepEqual(c.clipperEnv(), { CLIPPER_RELEASE: c.CLIPPER_RELEASE, CLIPPER_SHA256: c.CLIPPER_BINARY_SHA256.linux.join(','), CLIPPER_BENCH_SHA256: c.CLIPPER_BINARY_SHA256.windows });
  for (const h of [...c.CLIPPER_BINARY_SHA256.linux, c.CLIPPER_BINARY_SHA256.windows]) assert.match(h, /^[0-9a-f]{64}$/);
  for (const cmd of [win, lin]) { assert.ok(!/\/main\//.test(cmd)); assert.ok(!/\| *(sh|iex)\b/.test(cmd)); }
  assert.match(c.CLIPPER_COMMIT, /^[0-9a-f]{40}$/);

  const sw = c.shareInstructions({ clipsDir: 'D:\\Clips', host: 'box', target: 'windows', platform: 'win32', user: 'me' });
  assert.equal(sw.share, '\\\\box\\Clips');
  assert.ok(sw.lines.some((l) => l.includes("New-SmbShare -Name Clips -Path 'D:\\Clips'")));
  const sl = c.shareInstructions({ clipsDir: '/srv/Lilin Clips', host: 'box', target: 'linux', platform: 'linux', user: 'me' });
  assert.equal(sl.share, '/mnt/clips');
  assert.ok(sl.lines.some((l) => l.startsWith('  //box/LilinClips  /mnt/clips  cifs')));

  assert.deepEqual(c.localInstallCommand({ src: '/s', clipsDir: '/srv/clips', quality: 'bench', yes: true, platform: 'linux' }),
    ['sh', '/s/linux/install.sh', '--lilin', '/srv/clips', '--quality', 'bench:quality', '--yes']);
  assert.deepEqual(c.localInstallCommand({ src: 'C:\\s', clipsDir: 'D:\\Clips', lilinUrl: 'http://x', quality: 'high', platform: 'win32' }).slice(5),
    ['C:\\s\\windows\\install.ps1', '-Share', 'D:\\Clips', '-LilinUrl', 'http://x', '-Quality', 'high']);
  assert.throws(() => c.localInstallCommand({ src: '/s', clipsDir: '/c', platform: 'darwin' }), /Linux and Windows/);
});

test('clipper setup sets CLIPS_DIR and prints the gaming PC commands (dry run writes nothing)', (t) => {
  const dir = tmp(t, 'clipper');
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'PORT=8099\nCLIPS_DIR=\n');
  const clips = path.join(dir, 'clips');
  const run = (...extra) => spawnSync(process.execPath, ['setup.js', 'clipper', '--yes', '--env', envFile, '--clips-dir', clips, '--remote', 'linux', '--quality', 'bench:smooth', ...extra], { cwd: root, encoding: 'utf8' });
  const dry = run('--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(!fs.existsSync(clips));
  assert.equal(parseEnv(fs.readFileSync(envFile, 'utf8')).CLIPS_DIR, '');
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(clips, 'Kept')));
  assert.equal(parseEnv(fs.readFileSync(envFile, 'utf8')).CLIPS_DIR, clips);
  assert.match(r.stdout, /sha256sum -c --quiet - && CLIPPER_REF=[0-9a-f]{40} CLIPPER_RELEASE=v[\d.]+ CLIPPER_SHA256=[0-9a-f,]+ sh "\$f" --lilin \/mnt\/clips --quality bench:smooth/);
  assert.match(r.stdout, /It sets up:/);
  assert.match(r.stdout, /cifs/);
  assert.match(r.stdout, /Restart Lilin/);
  assert.doesNotMatch(run().stdout, /Restart Lilin/, 'unchanged CLIPS_DIR needs no restart');
});

test('Lilin as Access sign-in: callback from the team, secret kept, login method values', async () => {
  const { teamHost, accessCallback, oidcValues, loginMethod, loginMethodLines } = await import('../src/setup/oidc.js');
  assert.equal(teamHost('https://MyTeam.cloudflareaccess.com/'), 'myteam.cloudflareaccess.com');
  assert.equal(teamHost('myteam'), 'myteam.cloudflareaccess.com');
  assert.equal(accessCallback('myteam.cloudflareaccess.com'), 'https://myteam.cloudflareaccess.com/cdn-cgi/access/callback');
  assert.equal(accessCallback(''), '');
  const fresh = oidcValues({}, 'myteam.cloudflareaccess.com');
  assert.equal(fresh.OIDC_CLIENT_ID, 'cloudflare');
  assert.ok(fresh.OIDC_CLIENT_SECRET.length >= 32);
  assert.equal(fresh.OIDC_REDIRECT_URIS, 'https://myteam.cloudflareaccess.com/cdn-cgi/access/callback');
  const kept = oidcValues({ ...fresh, OIDC_REDIRECT_URIS: 'https://other.example/cb' }, 'myteam.cloudflareaccess.com');
  assert.equal(kept.OIDC_CLIENT_SECRET, fresh.OIDC_CLIENT_SECRET, 'an existing secret survives a re-run');
  assert.equal(kept.OIDC_REDIRECT_URIS, 'https://other.example/cb,https://myteam.cloudflareaccess.com/cdn-cgi/access/callback');
  assert.notEqual(oidcValues({ OIDC_CLIENT_SECRET: 'short' }, 'x').OIDC_CLIENT_SECRET, 'short', 'too-short secrets are replaced');
  const m = loginMethod({ ...fresh, PUBLIC_URL: 'https://lilin.example.com/' });
  assert.ok(m.ready);
  assert.equal(m.authUrl, 'https://lilin.example.com/c/oidc/authorize');
  assert.equal(m.certUrl, 'https://lilin.example.com/c/oidc/jwks');
  assert.ok(loginMethodLines(m).some((l) => l.includes(fresh.OIDC_CLIENT_SECRET)));
  assert.deepEqual(loginMethod({ ...fresh }).missing, ['PUBLIC_URL']);
});

test('unattended Cloudflare setup with Lilin sign-in writes OIDC_*, the cache folder and the content filter', (t) => {
  const dir = tmp(t, 'oidc');
  const envFile = path.join(dir, '.env');
  const answers = path.join(dir, 'a.json');
  const base = { MEDIA_DIR: path.join(dir, 'm'), DATA_DIR: path.join(dir, 'data'), CACHE_DIR: path.join(dir, 'cache'), PORT: '18767', autostart: false, install: [],
    remoteAccess: 'cloudflare', ADMIN_EMAILS: 'owner@example.com', CF_ACCESS_TEAM_DOMAIN: 'myteam.cloudflareaccess.com', CF_ACCESS_AUD: 'aud-tag',
    PUBLIC_URL: 'https://lilin.example.com', accessSignIn: 'lilin', CONTENT_FILTER: 'members' };
  fs.writeFileSync(answers, JSON.stringify(base));
  const r = runSetup(['--config', answers, '--env', envFile, '--offline']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const env = parseEnv(fs.readFileSync(envFile, 'utf8'));
  assert.equal(env.OIDC_CLIENT_ID, 'cloudflare');
  assert.equal(env.OIDC_REDIRECT_URIS, 'https://myteam.cloudflareaccess.com/cdn-cgi/access/callback');
  assert.ok(env.OIDC_CLIENT_SECRET.length >= 32);
  assert.ok(!r.stdout.includes(env.OIDC_CLIENT_SECRET), 'setup never prints the secret');
  assert.match(r.stdout, /node setup\.js oidc shows what to enter/);
  assert.equal(env.CACHE_DIR, base.CACHE_DIR);
  assert.ok(fs.statSync(base.DATA_DIR).isDirectory() && fs.statSync(base.CACHE_DIR).isDirectory(), 'new data and cache folders are created');
  assert.equal(env.CONTENT_FILTER, 'members');

  const shown = runSetup(['oidc', '--env', envFile]);
  assert.equal(shown.status, 0, shown.stderr + shown.stdout);
  assert.ok(shown.stdout.includes(env.OIDC_CLIENT_SECRET) && shown.stdout.includes('https://lilin.example.com/c/oidc/token'));

  // Re-run: the secret stays (Cloudflare already has it). Switching to Access's own logins clears it.
  const again = runSetup(['--config', answers, '--env', envFile, '--offline']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(parseEnv(fs.readFileSync(envFile, 'utf8')).OIDC_CLIENT_SECRET, env.OIDC_CLIENT_SECRET);
  fs.writeFileSync(answers, JSON.stringify({ ...base, accessSignIn: 'access' }));
  const off = runSetup(['--config', answers, '--env', envFile, '--offline']);
  assert.equal(off.status, 0, off.stderr);
  const after = parseEnv(fs.readFileSync(envFile, 'utf8'));
  assert.equal(after.OIDC_CLIENT_ID + after.OIDC_CLIENT_SECRET + after.OIDC_REDIRECT_URIS, '');
  assert.equal(runSetup(['oidc', '--env', envFile]).status, 1);
});

test('config checks: half-set OIDC, short secret, missing PUBLIC_URL, unknown content filter', () => {
  const keys = (env) => checkConfig(env, { tools: false }).map((c) => c.key);
  const full = { OIDC_CLIENT_ID: 'cloudflare', OIDC_CLIENT_SECRET: 'x'.repeat(32), OIDC_REDIRECT_URIS: 'https://t.cloudflareaccess.com/cdn-cgi/access/callback', PUBLIC_URL: 'https://m.example.com' };
  assert.ok(!keys(full).some((k) => /OIDC|PUBLIC_URL/.test(k)));
  assert.ok(keys({ OIDC_CLIENT_ID: 'cloudflare' }).includes('OIDC_CLIENT_ID'));
  assert.ok(keys({ ...full, OIDC_CLIENT_SECRET: 'short' }).includes('OIDC_CLIENT_SECRET'));
  assert.ok(keys({ ...full, PUBLIC_URL: '' }).includes('PUBLIC_URL'));
  assert.ok(keys({ CONTENT_FILTER: 'strict' }).includes('CONTENT_FILTER'));
});
