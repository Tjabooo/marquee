import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const summary = (total, apps, extra = {}) => ({
  version: 1, total, generated: 1793800000, complete: false,
  apps: apps.map(([app, seconds, category = 'Development']) => ({ app, name: app[0].toUpperCase() + app.slice(1), category, seconds })),
  categories: [{ name: 'Development', seconds: total }],
  hourly: Array.from({ length: 24 }, (_, h) => ({ hour: h, seconds: h === 9 ? total : 0, categories: h === 9 ? { Development: total } : {} })),
  pickups: 3, pickups_hourly: Array.from({ length: 24 }, (_, h) => (h === 9 ? 3 : 0)), first_pickup: '09:05',
  after_pickup: [{ app: 'kitty', name: 'Kitty', count: 2 }],
  longest_session: { seconds: 1200, start: '09:05', end: '09:25', app: 'kitty', name: 'Kitty' }, sittings: 2,
  ...extra,
});

test('screentime daemons push daily summaries; the owner sees days, weeks and all devices combined', { timeout: 20000 }, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = await fs.mkdtemp(path.join(os.tmpdir(), 'marquee-screentime-'));
  for (const name of await fs.readdir(root)) if (name.endsWith('.js') || name === 'package.json') await fs.copyFile(path.join(root, name), path.join(app, name));
  await fs.cp(path.join(root, 'public'), path.join(app, 'public'), { recursive: true });
  await fs.cp(path.join(root, 'src'), path.join(app, 'src'), { recursive: true });
  let port = 0; // 0 = the server picks a free port and prints it (see the ready line below)
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PORT: String(port), ADMIN_EMAILS: 'owner@st.test', CONVERT: 'off', SUBSYNC: 'off', CAST_APPLETV: 'off', NOTES_OCR: 'off', SERVER_IP: '127.0.0.1',
    SCREENTIME_TOKEN: 'st-secret' };
  const child = spawn(process.execPath, ['server.js'], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const exited = new Promise((r) => child.once('exit', r));
  await new Promise((resolve, reject) => {
    let logs = ''; const timer = setTimeout(() => reject(Error('Startup timeout: ' + logs)), 8000);
    child.stdout.on('data', (c) => { logs += c; const ready = /Marquee is running: http:\/\/localhost:(\d+)/.exec(logs); if (ready) { port = Number(ready[1]); clearTimeout(timer); resolve(); } });
    child.stderr.on('data', (c) => { logs += c; });
  });
  const push = async (body, token = 'st-secret', status = 200) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/screentime`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const data = await r.json(); assert.equal(r.status, status, JSON.stringify(data)); return data;
  };
  const report = async (query, email = 'owner@st.test', status = 200) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/house/screentime?${query}`, { headers: email ? { 'cf-access-authenticated-user-email': email } : {} });
    const data = await r.json(); assert.equal(r.status, status, JSON.stringify(data)); return data;
  };
  try {
    const day = { device: 'desk', date: '2026-11-04', final: false, summary: summary(3600, [['kitty', 2400], ['firefox', 1200, 'Web']]) };
    await push(day, 'wrong', 403);
    await push(day, null, 403);
    await push({ ...day, date: '4 Nov' }, undefined, 400);
    await push({ ...day, device: '../etc' }, undefined, 400);
    await push({ ...day, summary: 'nope' }, undefined, 400);
    await push(day);
    await push({ ...day, date: '2026-11-03', summary: summary(7200, [['kitty', 7200]]) });
    await push({ ...day, date: '2026-10-28', summary: summary(1800, [['kitty', 1800]]) }); // last week
    await push({ device: 'laptop', date: '2026-11-04', summary: summary(1800, [['kitty', 600], ['discord', 1200, 'Social']], { first_pickup: '07:40' }) });
    // a queued copy that was generated earlier never replaces a newer one
    assert.equal((await push({ ...day, summary: summary(10, [['kitty', 10]], { generated: 1 }) })).kept, 'newer');

    await report('', 'someone@st.test', 403);
    const all = await report('today=2026-11-04');
    assert.deepEqual(all.devices.map((d) => d.name).sort(), ['desk', 'laptop']);
    assert.equal(all.device, 'all');
    assert.equal(all.day.total, 5400);
    assert.equal(all.day.apps[0].name, 'Kitty'); assert.equal(all.day.apps[0].seconds, 3000);
    assert.equal(all.day.firstPickup, '07:40');
    assert.equal(all.day.pickups, 6);
    assert.equal(all.day.hourly[9].seconds, 5400);

    const desk = await report('device=desk&today=2026-11-04');
    assert.equal(desk.day.total, 3600);
    assert.equal(desk.day.longest.seconds, 1200);
    assert.equal(desk.week.start, '2026-11-02');
    // Mon (no data, but tracking had started) + Tue 7200 + Wed 3600, over three days; the rest of the week hasn't happened
    assert.equal(desk.week.average, 3600);
    assert.deepEqual(desk.week.days.map((d) => d.total), [0, 7200, 3600, null, null, null, null]);
    // last week counts from the first day ever tracked (Wed 28 Oct): 1800 s over 5 days
    assert.equal(desk.week.lastAverage, 360);
    assert.equal(desk.week.change, 900);
    assert.equal(desk.week.pickups, 6);

    const old = await report('device=desk&date=2026-10-28');
    assert.equal(old.day.total, 1800);
    const html = await (await fetch(`http://127.0.0.1:${port}/app.js`)).text();
    assert.match(html, /function screenTimeView/);
  } finally {
    child.kill();
    await exited;
    await fs.rm(app, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
