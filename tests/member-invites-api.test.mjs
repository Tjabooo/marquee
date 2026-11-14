import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Members make invite links only after the owner allows it, a few at a time, and cancel only their own.
// The real invites.js runs with dummy Cloudflare settings: making and cancelling links never calls Cloudflare.
test('members the owner allows can make, list and cancel their own invite links', { timeout: 20000 }, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = await fs.mkdtemp(path.join(os.tmpdir(), 'lilin-member-invites-'));
  for (const name of await fs.readdir(root)) if (name.endsWith('.js') || name === 'package.json') await fs.copyFile(path.join(root, name), path.join(app, name));
  await fs.cp(path.join(root, 'public'), path.join(app, 'public'), { recursive: true });
  await fs.cp(path.join(root, 'src'), path.join(app, 'src'), { recursive: true });
  let port = 0;
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PORT: '0', ADMIN_EMAILS: 'owner@inv.test', CONVERT: 'off', SUBSYNC: 'off', CAST_APPLETV: 'off', NOTES_OCR: 'off', SERVER_IP: '127.0.0.1',
    CF_API_TOKEN: 'x', CF_ACCOUNT_ID: 'x', CF_ACCESS_LIST_ID: 'x', CF_API_BASE: 'http://127.0.0.1:9' };
  const child = spawn(process.execPath, ['server.js'], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const exited = new Promise((r) => child.once('exit', r));
  await new Promise((resolve, reject) => {
    let logs = ''; const timer = setTimeout(() => reject(Error('Startup timeout: ' + logs)), 8000);
    child.stdout.on('data', (c) => { logs += c; const ready = /Lilin is running: http:\/\/localhost:(\d+)/.exec(logs); if (ready) { port = Number(ready[1]); clearTimeout(timer); resolve(); } });
    child.stderr.on('data', (c) => { logs += c; });
    child.once('exit', () => { clearTimeout(timer); reject(Error(logs)); });
  });
  const request = async (route, body, email = 'owner@inv.test', status = 200) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { headers: { 'cf-access-authenticated-user-email': email, 'content-type': 'application/json' },
      method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
  };
  try {
    const member = (await request('/api/me', undefined, 'member@inv.test')).me;
    await request('/api/me', undefined, 'other@inv.test');
    assert.equal(member.canInvite, false, 'off until the owner allows it');
    await request('/api/invites', undefined, 'member@inv.test', 403);
    await request('/api/invites', { note: 'x' }, 'member@inv.test', 403);

    const owner = (await request('/api/me')).me;
    assert.equal(owner.canInvite, true);
    await request(`/api/admin/users/${owner.id}`, { canInvite: false }, undefined, 400);
    await request(`/api/admin/users/${member.id}`, { canInvite: true }, 'member@inv.test', 403);
    await request(`/api/admin/users/${member.id}`, { canInvite: true });
    assert.equal((await request('/api/me', undefined, 'member@inv.test')).me.canInvite, true);

    const made = [];
    for (let i = 0; i < 3; i++) made.push(await request('/api/invites', { note: `Friend ${i}` }, 'member@inv.test'));
    assert.match(made[0].url, /\/c\/i\/[A-Za-z0-9_-]{16}$/);
    await request('/api/invites', { note: 'one too many' }, 'member@inv.test', 400);
    const mine = await request('/api/invites', undefined, 'member@inv.test');
    assert.equal(mine.invites.length, 3); assert.equal(mine.max, 3);

    // The owner sees who made them; another member can't see or cancel them.
    const all = (await request('/api/access')).invites;
    assert.ok(made.every((m) => all.find((i) => i.id === m.id)?.byName === member.name));
    await request(`/api/admin/users/${(await request('/api/me', undefined, 'other@inv.test')).me.id}`, { canInvite: true });
    assert.equal((await request('/api/invites', undefined, 'other@inv.test')).invites.length, 0);
    await request(`/api/invites/${made[0].id}/revoke`, {}, 'other@inv.test', 404);
    await request('/api/access', undefined, 'member@inv.test', 403);

    await request(`/api/invites/${made[0].id}/revoke`, {}, 'member@inv.test');
    assert.equal((await request('/api/invites', undefined, 'member@inv.test')).invites.length, 2);
    await request('/api/invites', { note: 'room again' }, 'member@inv.test');

    // Switched off again: no more links.
    await request(`/api/admin/users/${member.id}`, { canInvite: false });
    await request('/api/invites', { note: 'x' }, 'member@inv.test', 403);
  } finally {
    child.kill();
    await exited;
    await fs.rm(app, { recursive: true, force: true }).catch(() => {});
  }
});
