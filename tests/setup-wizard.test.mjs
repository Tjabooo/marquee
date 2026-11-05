// The Windows setup wizard: its JSON bridge (`setup.js wizard ...`) and, on Windows, the window itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/setup/cli.js';
import { splitSecrets, remoteAccessOf, taskRunsApp } from '../src/setup/wizard.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const tmp = (t, name) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `marquee-${name}-`)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const wizard = (args) => {
  const r = spawnSync(process.execPath, ['setup.js', 'wizard', ...args], { cwd: root, encoding: 'utf8', timeout: 60000, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  assert.equal(r.status, 0, r.stderr);
  return { json: JSON.parse(r.stdout.trim().split('\n').pop()), stdout: r.stdout };
};
const answers = (dir, obj) => { const f = path.join(dir, `answers-${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify(obj)); return f; };

test('wizard and gui commands parse; unknown wizard actions are refused', () => {
  const a = parseArgs(['wizard', 'info']);
  assert.deepEqual([a.command, a.action], ['wizard', 'info']);
  assert.equal(parseArgs(['wizard', 'check', '--config', 'x.json']).config, 'x.json');
  assert.equal(parseArgs(['gui']).command, 'gui');
  assert.throws(() => parseArgs(['wizard', 'write']), /info\|check\|clipper/);
});

test('secrets are reported as set or not, never by value', () => {
  assert.deepEqual(splitSecrets({ PORT: '8080', TMDB_TOKEN: 'abc', QBIT_PASS: '', CF_ACCESS_AUD: 'x' }),
    { values: { PORT: '8080' }, secrets: { TMDB_TOKEN: true, QBIT_PASS: false, CF_ACCESS_AUD: true } });
  assert.equal(remoteAccessOf({}), 'none');
  assert.equal(remoteAccessOf({ CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com' }), 'cloudflare');
  assert.equal(remoteAccessOf({ PUBLIC_URL: 'https://films.example.com' }), 'proxy');
});

test('the Marquee task only counts when it runs this installation', () => {
  const xml = '<Exec><Command>cmd.exe</Command><Arguments>/c "C:\\marquee\\start-marquee.cmd"</Arguments></Exec>';
  assert.equal(taskRunsApp(xml, 'C:\\marquee'), true);
  assert.equal(taskRunsApp(xml.replace(/"/g, '&quot;'), 'C:\\Marquee'), true);
  assert.equal(taskRunsApp(xml, 'D:\\Apps\\marquee'), false);
  assert.equal(taskRunsApp('', 'C:\\marquee'), false);
});

test('wizard info reads .env without printing secrets', (t) => {
  const dir = tmp(t, 'wizard-info');
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'MEDIA_DIR=/srv/films\nPORT=8091\nTMDB_TOKEN=super-secret-token\nADMIN_EMAILS=Owner@Example.com\n');
  const { json, stdout } = wizard(['info', '--env', envFile]);
  assert.equal(stdout.includes('super-secret-token'), false);
  assert.equal(json.secrets.TMDB_TOKEN, true);
  assert.equal('TMDB_TOKEN' in json.values, false);
  assert.equal(json.defaults.MEDIA_DIR, '/srv/films');
  assert.equal(json.defaults.PORT, '8091');
  assert.equal(json.defaults.remoteAccess, 'none');
  assert.ok(json.defaults.CLIPS_DIR.endsWith('Clips'));
  assert.equal(json.node.ok, true);
  assert.ok(json.clipper.quality.some((q) => q.value === 'balanced'));
  assert.ok(Array.isArray(json.clipper.installs.windows));
});

test('wizard check reports a busy port; wizard clipper builds the gaming-PC command', async (t) => {
  const dir = tmp(t, 'wizard-check');
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'MEDIA_DIR=/srv/films\n');
  const srv = net.createServer().listen(0, '0.0.0.0');
  await new Promise((r) => srv.once('listening', r));
  t.after(() => srv.close());
  const port = srv.address().port;
  const busy = wizard(['check', '--env', envFile, '--config', answers(dir, { PORT: port, only: [] })]).json;
  assert.equal(busy.port.ok, false);
  assert.match(busy.port.detail, /used by another program/);
  assert.equal(busy.tmdb, null);

  const plan = wizard(['clipper', '--env', envFile, '--config', answers(dir, { where: 'windows', quality: 'high', share: '\\\\server\\Clips' })]).json;
  assert.equal(plan.where, 'windows');
  assert.match(plan.remoteCommand, /-Quality high/);
  assert.match(plan.remoteCommand, /\\\\server\\Clips/);
  assert.ok(plan.installs.length);
  const none = wizard(['clipper', '--env', envFile, '--config', answers(dir, { where: 'none' })]).json;
  assert.equal(none.remoteCommand, undefined);
  assert.equal(path.basename(none.clipsDir), 'Clips');
});

test('Windows: the setup wizard window builds and every named part exists', { skip: process.platform !== 'win32' }, () => {
  const script = path.join(root, 'scripts', 'windows', 'setup-wizard.ps1');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, '-SelfTest'], { encoding: 'utf8', timeout: 120000, windowsHide: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Self-test passed/);
});

test('the wizard script stays ASCII (Windows PowerShell 5.1 reads BOM-less files as ANSI)', () => {
  for (const f of ['setup-wizard.ps1', 'build-setup-exe.ps1', 'install-service.ps1']) {
    const text = fs.readFileSync(path.join(root, 'scripts', 'windows', f), 'utf8');
    const bad = [...text].findIndex((ch) => ch.charCodeAt(0) > 127);
    assert.equal(bad, -1, `${f} has a non-ASCII character at offset ${bad}`);
  }
});
