import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { handleWatchPage } from '../src/watch-page.js';

const TOKEN = 'abcdefghijklmnopqrstuvwx';
function render(path, rooms, artwork = () => null) {
  const res = { status: 0, headers: {}, body: '', writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { this.body = b || ''; } };
  const req = { method: 'GET', headers: { host: 'marquee.example', 'x-forwarded-proto': 'https' } };
  const handled = handleWatchPage(req, res, new URL(path, 'https://marquee.example'), { rooms, artwork });
  return { handled, ...res };
}

test('a watch link gets a Discord embed with the title, artwork and host, then forwards to the room', () => {
  const rooms = { preview: () => ({ media: { title: 'Severance <S2>', season: 2, episode: 3 }, host: 'Oliver', viewers: 2 }) };
  const page = render(`/c/w/${TOKEN}`, rooms, () => ({ image: 'https://image.tmdb.org/t/p/w780/b.jpg' }));
  assert.equal(page.handled, true);
  assert.equal(page.status, 200);
  assert.match(page.body, /<meta property="og:title" content="Watch Severance &lt;S2&gt; · S02 E03 together">/);
  assert.match(page.body, /og:image" content="https:\/\/image\.tmdb\.org\/t\/p\/w780\/b\.jpg"/);
  assert.match(page.body, /Oliver is hosting a Watch Together room on Marquee · 2 watching/);
  assert.match(page.body, /location\.replace\("\/\?watch=abcdefghijklmnopqrstuvwx"\)/);
  assert.equal(page.headers['Cache-Control'], 'no-store');
  assert.doesNotMatch(page.body, /<S2>/, 'Titles are escaped');
});

test('ended rooms say so, and other paths are left alone', () => {
  const ended = render(`/c/w/${TOKEN}`, { preview: () => { throw new Error('ended'); } });
  assert.equal(ended.status, 404);
  assert.match(ended.body, /This watch room has ended/);
  assert.match(ended.body, /og:image" content="[^"]*\/c\/marquee\.png"/);
  assert.equal(render('/c/w/short', {}).handled, false);
  assert.equal(render(`/c/${TOKEN.slice(0, 16)}`, {}).handled, false);
});

test('link artwork works for films (no still) and prefers the full-size episode still', () => {
  const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function watchArtwork('), source.indexOf('setInterval(() => watchRooms.cleanup()'));
  const shows = {
    knownFilm: () => ({ backdrop: 'https://image.tmdb.org/t/p/w780/film.jpg' }),
    knownShow: () => ({ backdrop: 'https://image.tmdb.org/t/p/w780/show.jpg' }),
    knownEpisode: () => ({ still: 'https://image.tmdb.org/t/p/w300/ep.jpg' }),
  };
  const context = vm.createContext({ shows });
  vm.runInContext(`${code}; this.watchArtwork = watchArtwork;`, context);
  assert.equal(context.watchArtwork({ title: 'Arrival', year: 2016, season: null, episode: null, mediaKey: 'films/arrival' }).image, 'https://image.tmdb.org/t/p/w780/film.jpg');
  assert.equal(context.watchArtwork({ title: 'House', season: 3, episode: 1 }).image, 'https://image.tmdb.org/t/p/original/ep.jpg');
  shows.knownEpisode = () => null;
  assert.equal(context.watchArtwork({ title: 'House', season: 3, episode: 1 }).image, 'https://image.tmdb.org/t/p/w780/show.jpg');
});
