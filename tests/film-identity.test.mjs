import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { initShows, filmInfo, identifyFilm, rememberFilmDownload, filmDownload } from '../src/shows.js';

const first = { id: 1283515, title: 'Verity', release_date: '2026-09-30', poster_path: '/a.jpg', overview: 'A novelist.' };
const second = { id: 1812260, title: 'Verity', release_date: '2026-10-31', poster_path: '/b.jpg', overview: 'A wish.' };

test('same-name, same-year films stay unresolved until a per-file choice; old guesses are refreshed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marquee-identity-'));
  await fs.writeFile(path.join(dir, '.marquee-shows.json'), JSON.stringify({ films: { 'verity|2026': { id: first.id, at: Date.now() } } }));
  initShows({ dataDir: dir });
  let lookups = 0;
  const tmdb = async () => { lookups++; return { results: [first, second] }; };
  const files = [{ id: 'a', mediaKey: 'films/a', title: 'Verity', year: 2026 }, { id: 'b', mediaKey: 'films/b', title: 'Verity', year: 2026 }];
  let result = await filmInfo(files, tmdb, { wait: 20 });
  assert.equal(lookups, 1, 'Concurrent searches are shared');
  assert.equal(result.get('a').tmdbId, null);
  assert.equal(result.get('a').movieAmbiguous, true);
  assert.deepEqual(result.get('a').filmCandidates.map((f) => f.id), [first.id, second.id]);
  identifyFilm(files[0].mediaKey, second);
  result = await filmInfo(files, tmdb, { wait: 20 });
  assert.equal(result.get('a').tmdbId, second.id);
  assert.equal(result.get('b').tmdbId, null, 'A choice never labels every same-name film');
  rememberFilmDownload('abcdef', first);
  assert.equal(filmDownload('ABCDEF').id, first.id);
  await new Promise((r) => setTimeout(r, 1100));
  initShows({ dataDir: dir });
  result = await filmInfo(files, null);
  assert.equal(result.get('a').tmdbId, second.id, 'Manual choice survives restart and offline use');
  assert.equal(result.get('b').movieAmbiguous, true);
  const wrongYear = await filmInfo([{ id: 'c', title: 'Verity', year: 2025 }], tmdb, { wait: 20 });
  assert.equal(wrongYear.has('c'), false, 'No automatic match to a different year');
});

test('Discover IDs are authoritative for both library badges and add-from-server matches', async () => {
  const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('const sameTitle ='), source.indexOf('const byEpisode ='));
  const match = vm.runInNewContext(code + '\nsameTitle', { norm: (s) => String(s || '').toLowerCase() });
  const title = { id: first.id, type: 'movie', title: 'Verity', year: 2026 };
  assert.equal(match(title)({ title: 'Verity', year: 2026, tmdbId: first.id }), true);
  assert.equal(match(title)({ title: 'Verity', year: 2026, tmdbId: second.id }), false);
  assert.equal(match(title)({ title: 'Verity', year: 2026 }), false, 'Unknown identity is not availability');
  assert.equal(match(title)({ title: 'Verity', tmdbId: first.id, movieAmbiguous: true }), false);
  assert.equal(match(title)({ title: 'Verity', season: 1, show: 'tv-1283515' }), false);
  assert.equal(match({ ...title, type: 'tv' })({ title: 'Verity', show: 'tv-1812260', season: 1 }), false);
});
