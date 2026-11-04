import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('owners rename access-list accounts, including future visitors, without changing identity or permissions', { timeout: 20000 }, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = await fs.mkdtemp(path.join(os.tmpdir(), 'marquee-access-rename-'));
  for (const name of await fs.readdir(root)) if (name.endsWith('.js') || name === 'package.json') await fs.copyFile(path.join(root, name), path.join(app, name));
  await fs.cp(path.join(root, 'public'), path.join(app, 'public'), { recursive: true });
  // Only the remote access list is replaced. No real Cloudflare calls or accounts.
  await fs.writeFile(path.join(app, 'invites.js'), `
    export const initInvites = () => {};
    export const invitesConfigured = () => true;
    export const members = async () => ['owner@names.test', 'member@names.test', 'future@names.test'];
    export const listInvites = () => [];
  `);
  const reserve = net.createServer(); await new Promise((r) => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port; await new Promise((r) => reserve.close(r));
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PORT: String(port), ADMIN_EMAILS: 'owner@names.test', CONVERT: 'off', SUBSYNC: 'off', CAST_APPLETV: 'off', NOTES_OCR: 'off', SERVER_IP: '127.0.0.1' };
  let child, exited;
  const start = async () => {
    child = spawn(process.execPath, ['server.js'], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    exited = new Promise((r) => child.once('exit', r));
    await new Promise((resolve, reject) => {
      let logs = ''; const timer = setTimeout(() => reject(Error('Startup timeout: ' + logs)), 8000);
      child.stdout.on('data', (c) => { logs += c; if (logs.includes('Marquee is running')) { clearTimeout(timer); resolve(); } });
      child.stderr.on('data', (c) => { logs += c; });
      child.once('error', reject); child.once('exit', () => { clearTimeout(timer); reject(Error(logs)); });
    });
  };
  const request = async (route, body, email = 'owner@names.test', status = 200) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { headers: { ...(email ? { 'cf-access-authenticated-user-email': email } : {}), 'content-type': 'application/json' },
      method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
  };
  const rename = (name, previousName = 'member', email = 'member@names.test') => ({ email, name, previousName });
  try {
    await start();
    const before = (await request('/api/me', { theme: { preset: 'forest' } }, 'member@names.test')).me;
    await request(`/api/admin/users/${before.id}`, { canDownload: false, keep: true });
    for (const email of ['member@names.test', '']) await request('/api/access/rename', rename('Denied'), email, 403);
    for (const name of ['', ' ', 'x'.repeat(41), 'two\nlines', 123]) await request('/api/access/rename', rename(name), undefined, 400);
    await request('/api/access/rename', null, undefined, 400);
    await request('/api/access/rename', { email: 'member@names.test', name: 'Missing prior name' }, undefined, 400);
    await request('/api/access/rename', rename('Unknown', 'outsider', 'outsider@names.test'), undefined, 404);
    const renamed = (await request('/api/access/rename', rename('  Captain <Dad & Co>  '))).user;
    assert.equal(renamed.name, 'Captain <Dad & Co>'); assert.equal(renamed.id, before.id); assert.equal(renamed.email, before.email);
    assert.equal(renamed.canDownload, false); assert.equal(renamed.keep, true); assert.deepEqual(renamed.settings, before.settings);
    await request('/api/access/rename', rename('Stale name'), undefined, 409);
    assert.equal((await request('/api/access')).names['member@names.test'], renamed.name);
    assert.equal((await request('/api/activity')).people.find((p) => p.user === before.email).name, renamed.name);
    const future = (await request('/api/access/rename', rename('Future visitor', 'future', 'future@names.test'))).user;
    const users = (await request('/api/admin/users')).users;
    assert.equal(users.find((u) => u.id === future.id).lastSeen, null, 'Pre-naming does not mark a visit');
    assert.equal((await request('/api/me', undefined, 'future@names.test')).me.name, 'Future visitor');
    const owner = (await request('/api/access/rename', rename('Owner display name', 'owner', 'owner@names.test'))).user;
    assert.equal(owner.isOwner, true); assert.equal(owner.canDownload, true);
    child.kill(); await exited; await start();
    assert.equal((await request('/api/access')).names['member@names.test'], renamed.name, 'Name survives restart');
    assert.equal((await request('/api/me', undefined, 'member@names.test')).me.id, before.id);
  } finally {
    if (child?.exitCode === null) child.kill(); if (exited) await exited;
    await fs.rm(app, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
