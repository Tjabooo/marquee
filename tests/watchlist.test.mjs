import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WatchlistStore, runRound, filmRelease, airedAfter, baselineFrom, retryDelay } from '../src/watchlist.js';
import { comingUp, newEpisodes, watchStatus, dayLabel } from '../public/watchlist.js';
import { topicFor } from '../src/live.js';

const HOUR = 3600e3, DAY = 24 * HOUR;
const at = (iso) => Date.parse(`${iso}T12:00:00Z`);
const tempStore = async () => new WatchlistStore(await fs.mkdtemp(path.join(os.tmpdir(), 'marquee-watchlist-')));
const meta = (title) => ({ title, year: 2026, poster: null, backdrop: null, overview: null, rating: null });

test('a film is expected at its earliest digital or disc release, else its first release date', () => {
  const details = { release_date: '2026-07-01', release_dates: { results: [
    { iso_3166_1: 'US', release_dates: [{ type: 3, release_date: '2026-07-01T00:00:00.000Z' }, { type: 4, release_date: '2026-09-10T00:00:00.000Z' }] },
    { iso_3166_1: 'SE', release_dates: [{ type: 5, release_date: '2026-09-02T00:00:00.000Z' }] }] } };
  assert.deepEqual(filmRelease(details), { date: '2026-09-02', kind: 'disc' });
  assert.deepEqual(filmRelease({ release_date: '2026-07-01' }), { date: '2026-07-01', kind: 'cinema' });
  assert.deepEqual(filmRelease({}), { date: null, kind: null });
});

test('following starts after the last aired episode and never counts specials', () => {
  assert.deepEqual(baselineFrom({ last_episode_to_air: { season_number: 2, episode_number: 4 } }), { season: 2, episode: 4 });
  assert.deepEqual(baselineFrom({ last_episode_to_air: { season_number: 0, episode_number: 3 } }), { season: 0, episode: 0 });
  assert.deepEqual(baselineFrom({}), { season: 0, episode: 0 });
  const eps = [
    { season: 2, episode: 4, airDate: '2026-11-01' }, { season: 2, episode: 5, airDate: '2026-11-05' },
    { season: 2, episode: 6, airDate: '2026-11-12' }, { season: 3, episode: 1, airDate: null }, { season: 0, episode: 9, airDate: '2026-11-02' }];
  assert.deepEqual(airedAfter(eps, { season: 2, episode: 4 }, '2026-11-05').map((e) => e.episode), [5]);
  assert.equal(retryDelay(1), HOUR);
  assert.equal(retryDelay(99), DAY);
});

test('a saved film waits for its release, then downloads once, retrying while nothing good is out', async () => {
  const store = await tempStore();
  const user = { id: 1, canDownload: true };
  store.set(1, 'movie', 10, meta('Late Film'), { saved: true, auto: true });
  store.set(1, 'movie', 11, meta('Just a reminder'), { saved: true });
  let now = at('2026-11-05');
  const downloads = [];
  let outcome = { state: 'done', outcome: 'none', message: 'No release clearly matches this title.' };
  const deps = {
    now: () => now, user: (id) => (id === 1 ? user : null), canAuto: (u) => u.canDownload,
    film: async (id) => (id === 10 ? { release_date: '2026-10-01', release_dates: { results: [{ release_dates: [{ type: 4, release_date: '2026-11-07' }] }] } } : { release_date: '2027-03-01' }),
    download: async (u, spec) => { downloads.push(spec); return outcome; },
  };
  await runRound(store, deps);
  let [late, reminder] = [store.list(1).find((i) => i.id === 10), store.list(1).find((i) => i.id === 11)];
  assert.equal(late.release, '2026-11-07');
  assert.equal(late.state, 'waiting');
  assert.equal(reminder.release, '2027-03-01');
  assert.equal(downloads.length, 0, 'nothing downloads before the release, and never without the switch');

  now = at('2026-11-08');
  await runRound(store, deps);
  late = store.list(1).find((i) => i.id === 10);
  assert.equal(downloads.length, 1);
  assert.equal(late.state, 'looking');
  assert.match(late.note, /No release/);
  await runRound(store, deps);
  assert.equal(downloads.length, 1, 'waits before trying again');

  now += 2 * HOUR;
  outcome = { state: 'done', outcome: 'started', message: 'Downloading.' };
  await runRound(store, deps);
  assert.equal(downloads.length, 2);
  assert.equal(store.list(1).find((i) => i.id === 10).state, 'got');
  now += 3 * DAY;
  await runRound(store, deps);
  assert.equal(downloads.length, 2, 'a film is downloaded only once');
});

test('a followed show downloads newly aired episodes only, marks them new and gives up on old misses', async () => {
  const store = await tempStore();
  const user = { id: 7, canDownload: true };
  store.set(7, 'tv', 500, meta('Followed'), { follow: true, auto: true, baseline: { season: 1, episode: 2 } });
  let now = at('2026-11-05');
  const season1 = [1, 2, 3, 4, 5].map((n) => ({ episode_number: n, air_date: `2026-11-0${n}` }));
  const calls = [];
  let answer = (spec) => ({ state: 'done', outcome: 'partial', have: [3], queued: [], added: [{ episode: 4, episodes: [4] }], unavailable: [{ episode: 5, reason: 'Nothing found.' }] });
  const deps = {
    now: () => now, user: () => user, canAuto: () => true,
    show: async () => ({ last_episode_to_air: { season_number: 1, episode_number: 5 }, next_episode_to_air: { season_number: 1, episode_number: 6, name: 'Six', air_date: '2026-11-12' } }),
    season: async (id, n) => ({ episodes: n === 1 ? season1 : [] }),
    download: async (u, spec) => { calls.push(spec); return answer(spec); },
  };
  await runRound(store, deps);
  assert.deepEqual(calls, [{ type: 'tv', tmdbId: 500, season: 1, episodes: [3, 4, 5] }], 'nothing from before following');
  let item = store.list(7)[0];
  assert.deepEqual(item.nextEpisode, { season: 1, episode: 6, name: 'Six', airDate: '2026-11-12' });
  assert.deepEqual(item.newEpisodes, [{ season: 1, episode: 4 }], 'one you already had is not new');
  assert.deepEqual(item.waiting.map((e) => e.episode), [5]);
  assert.equal(item.state, 'looking');

  answer = () => ({ state: 'done', outcome: 'none', have: [], queued: [], added: [], unavailable: [{ episode: 5, reason: 'Nothing found.' }] });
  now += 2 * HOUR;
  await runRound(store, deps);
  assert.deepEqual(calls.at(-1).episodes, [5], 'only the missing one is looked for again');
  now = at('2026-11-21');
  await runRound(store, deps);
  item = store.list(7)[0];
  assert.deepEqual(item.missed.map((e) => e.episode), [5]);
  assert.equal(item.state, 'waiting');

  assert.equal(store.markSeen(7, 500), 1);
  assert.deepEqual(store.list(7)[0].newEpisodes, []);
  // Unfollowing forgets the episodes; a show neither saved nor followed leaves the list.
  assert.equal(store.set(7, 'tv', 500, null, { follow: false }), null);
  assert.deepEqual(store.list(7), []);
});

test('following without download rights only tracks what is coming', async () => {
  const store = await tempStore();
  store.set(2, 'tv', 9, meta('Watch only'), { follow: true, auto: true, baseline: { season: 1, episode: 0 } });
  let downloaded = false;
  await runRound(store, {
    now: () => at('2026-11-05'), user: () => ({ id: 2, canDownload: false }), canAuto: (u) => u.canDownload,
    show: async () => ({ last_episode_to_air: { season_number: 1, episode_number: 1 }, next_episode_to_air: null }),
    season: async () => ({ episodes: [{ episode_number: 1, air_date: '2026-11-01' }] }),
    download: async () => { downloaded = true; },
  });
  assert.equal(downloaded, false);
  assert.deepEqual(store.list(2)[0].waiting, []);
});

test('the page words: dates, Coming up, New badges and status lines', () => {
  const today = '2026-11-05';
  assert.equal(dayLabel('2026-11-05', today), 'Today');
  assert.equal(dayLabel('2026-11-06', today), 'Tomorrow');
  assert.equal(dayLabel('2026-11-12', today), 'Thu 12 Nov');
  assert.equal(dayLabel('2026-11-09', today), 'Monday 9 Nov');
  assert.equal(dayLabel('2027-01-20', today), '20 Jan 2027');
  const items = [
    { type: 'movie', id: 1, title: 'Film', saved: true, release: '2026-12-01', releaseKind: 'digital' },
    { type: 'movie', id: 2, title: 'Old film', saved: true, release: '2020-01-01', releaseKind: 'cinema' },
    { type: 'tv', id: 3, title: 'Show', follow: true, nextEpisode: { season: 2, episode: 5, name: 'Five', airDate: '2026-11-06' } },
    { type: 'tv', id: 4, title: 'Saved show', saved: true, follow: false, nextEpisode: { season: 1, episode: 1, airDate: '2026-11-07' } },
  ];
  assert.deepEqual(comingUp(items, today).map((c) => [c.item.id, c.when, c.what]), [[3, 'Tomorrow', 'S02E05 · Five'], [1, 'Tue 1 Dec', 'Out to stream']]);
  const show = { type: 'tv', follow: true, auto: true, newEpisodes: [{ season: 2, episode: 4 }, { season: 2, episode: 5 }], waiting: [{ season: 2, episode: 6 }], missed: [],
    nextEpisode: { season: 2, episode: 7, airDate: '2026-11-06' } };
  assert.equal(newEpisodes(show, [{ season: 2, episode: 4, done: true }, { season: 2, episode: 5, done: false }]), 1, 'only episodes ready to play');
  assert.equal(watchStatus(show, { today, autoDownload: true }), 'Next: S02E07 airs tomorrow. Looking for S02E06.');
  assert.equal(watchStatus(show, { today, autoDownload: false }), 'Next: S02E07 airs tomorrow.');
  assert.equal(watchStatus({ type: 'movie', saved: true, auto: true, state: 'waiting', release: '2026-12-01' }, { today, autoDownload: true }),
    'Downloads automatically once it’s out on Tue 1 Dec.');
  assert.equal(watchStatus({ type: 'movie', saved: true, auto: false, release: '2026-12-01', releaseKind: 'disc' }, { today }), 'Out on disc on Tue 1 Dec.');
  assert.equal(watchStatus({ type: 'movie', saved: true, auto: true, state: 'got' }, { today, autoDownload: true }), 'Downloaded when it came out.');
});

test('watchlist changes reach the person’s other pages', () => {
  assert.deepEqual(topicFor('/api/watchlist'), { topic: 'watchlist', audience: 'user' });
  assert.deepEqual(topicFor('/api/watchlist/seen'), { topic: 'watchlist', audience: 'user' });
});

test('watchlist API: list, validation, removal and a clear message without TMDB', { timeout: 20000 }, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = await fs.mkdtemp(path.join(os.tmpdir(), 'marquee-watchlist-api-'));
  for (const name of await fs.readdir(root)) if (name.endsWith('.js') || name.endsWith('.json')) await fs.copyFile(path.join(root, name), path.join(app, name));
  await fs.cp(path.join(root, 'public'), path.join(app, 'public'), { recursive: true });
  await fs.cp(path.join(root, 'src'), path.join(app, 'src'), { recursive: true });
  let port = 0; // 0 = the server picks a free port and prints it (see the ready line below)
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PORT: String(port), ADMIN_EMAILS: 'owner@wl.test', CONVERT: 'off', SUBSYNC: 'off', CAST_APPLETV: 'off', NOTES_OCR: 'off', SERVER_IP: '127.0.0.1' };
  const child = spawn(process.execPath, ['server.js'], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const exited = new Promise((r) => child.once('exit', r));
  await new Promise((resolve, reject) => {
    let logs = ''; const timer = setTimeout(() => reject(Error('Startup timeout: ' + logs)), 8000);
    child.stdout.on('data', (c) => { logs += c; const ready = /Marquee is running: http:\/\/localhost:(\d+)/.exec(logs); if (ready) { port = Number(ready[1]); clearTimeout(timer); resolve(); } });
    child.stderr.on('data', (c) => { logs += c; });
  });
  const call = async (method, p, body, status = 200) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'cf-access-authenticated-user-email': 'owner@wl.test', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const data = await r.json(); assert.equal(r.status, status, JSON.stringify(data)); return data;
  };
  try {
    assert.deepEqual((await call('GET', '/api/watchlist')).items, []);
    await call('POST', '/api/watchlist', { type: 'book', tmdbId: 1, saved: true }, 400);
    await call('POST', '/api/watchlist', { type: 'movie', tmdbId: -4, saved: true }, 400);
    const off = await call('POST', '/api/watchlist', { type: 'movie', tmdbId: 603, saved: true, auto: true }, 503);
    assert.match(off.error, /set up on the server/);
    assert.match((await call('POST', '/api/watchlist', { type: 'movie', tmdbId: 603, saved: true }, 503)).error, /TMDB/);
    assert.equal((await call('POST', '/api/watchlist', { type: 'tv', tmdbId: 603, saved: false, follow: false })).item, null);
    assert.equal((await call('POST', '/api/watchlist/seen', { tmdbId: 603 })).cleared, 0);
  } finally {
    child.kill();
    await exited;
  }
});
