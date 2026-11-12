// CI smoke test: unattended setup into a temporary .env, start the server, check /api/health and
// a page, stop it with a signal and confirm it exits cleanly, then run doctor. Cross-platform.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('../../', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilin-smoke-'));
const envFile = path.join(dir, '.env');
const port = 18000 + Math.floor(Math.random() * 1000);
const answers = path.join(dir, 'answers.json');
fs.writeFileSync(answers, JSON.stringify({ MEDIA_DIR: path.join(dir, 'media'), DATA_DIR: path.join(dir, 'data'), PORT: String(port), autostart: false, install: [] }));
const env = { ...process.env, LILIN_ENV_FILE: envFile, NO_COLOR: '1' };
const fail = (msg) => { console.error(`SMOKE FAIL: ${msg}`); process.exit(1); };

const setup = spawnSync(process.execPath, ['setup.js', '--config', answers, '--env', envFile, '--offline'], { cwd: app, env, encoding: 'utf8' });
process.stdout.write(setup.stdout);
if (setup.status !== 0) fail(`setup exited ${setup.status}: ${setup.stderr}`);

const server = spawn(process.execPath, ['server.js'], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (c) => { log += c; });
server.stderr.on('data', (c) => { log += c; });
const exited = new Promise((r) => server.once('exit', (code, signal) => r({ code, signal })));

let health = null;
for (let i = 0; i < 40 && !health; i++) {
  await new Promise((r) => setTimeout(r, 500));
  try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) health = await r.json(); } catch { /* starting */ }
}
if (!health) { server.kill(); fail(`no /api/health answer\n${log}`); }
const version = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')).version;
if (health.version !== version) fail(`health reports ${health.version}, package.json ${version}`);
const page = await fetch(`http://127.0.0.1:${port}/`);
if (!page.ok || !(await page.text()).includes('<html')) fail('the web app did not load');
const me = await (await fetch(`http://127.0.0.1:${port}/api/me`, { headers: { 'cf-access-authenticated-user-email': 'owner@example.com' } })).json();
if (!me.me) fail('/api/me did not answer');
if (!fs.existsSync(path.join(dir, 'data', '.lilin.db'))) fail('the database was not created in DATA_DIR');

server.kill('SIGTERM');
const result = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 10000))]);
if (!result) { server.kill('SIGKILL'); fail('server did not stop within 10 s of SIGTERM'); }
// Windows has no signals: kill() terminates the process, so only the exit itself is checked there.
if (process.platform !== 'win32' && result.code !== 0) fail(`server exited with ${JSON.stringify(result)} after SIGTERM\n${log}`);

const doctor = spawnSync(process.execPath, ['setup.js', 'doctor', '--offline', '--env', envFile], { cwd: app, env, encoding: 'utf8' });
process.stdout.write(doctor.stdout);
if (doctor.status !== 0) fail(`doctor reported problems (exit ${doctor.status})`);
fs.rmSync(dir, { recursive: true, force: true });
console.log(`SMOKE OK: Lilin ${health.version} on ${process.platform}/${process.arch}, Node ${process.versions.node}`);
