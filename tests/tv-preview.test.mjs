import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('TV Preview is a separate Tizen app and separate server frontend', () => {
  const stableConfig = read('tv/tizen/config.xml.in');
  const previewConfig = read('tv/tizen-preview/config.xml.in');
  const stableShell = read('tv/tizen/shell.js');
  const previewShell = read('tv/tizen-preview/shell.js');

  assert.match(stableConfig, /MrqTvApp01\.Marquee/);
  assert.match(previewConfig, /MrqTvPrv01\.MarqueePreview/);
  assert.doesNotMatch(previewConfig, /MrqTvApp01\.Marquee/);
  assert.match(stableShell, /\/tv\/tv\.js/);
  assert.doesNotMatch(stableShell, /tv-preview/);
  assert.match(previewShell, /\/tv-preview\/tv\.js/);
  assert.doesNotMatch(previewShell, /server \+ '\/tv\/tv\.js/);
});

test('TV Preview client parses as old-browser JavaScript and uses server-side Discover/download APIs', () => {
  const js = read('public/tv-preview/tv.js');
  const shell = read('tv/tizen-preview/shell.js');
  assert.doesNotThrow(() => new vm.Script(js));
  assert.doesNotThrow(() => new vm.Script(shell));
  assert.match(js, /\/api\/discover\/home\?type=/);
  assert.match(js, /\/api\/discover\/list\?key=/);
  assert.match(js, /\/api\/discover\/genre\?type=/);
  assert.match(js, /\/api\/search\?q=/);
  assert.match(js, /\/api\/downloads\/smart/);
  assert.match(js, /\/api\/tv\//);
  assert.doesNotMatch(js, /\?\./, 'Chrome 69 preview client must not use optional chaining');
  assert.doesNotMatch(js, /\?\?/, 'Chrome 69 preview client must not use nullish coalescing');
});

test('TV Preview keeps its render budget deliberately small', () => {
  const js = read('public/tv-preview/tv.js');
  // Rows and grids grow as you scroll, but stop at a cap, and posters load only near the screen.
  assert.match(js, /var ROW_MAX = 60\b/);
  assert.match(js, /GRID_MAX = 300\b/);
  assert.match(js, /function lazy\(src\)/);
  assert.doesNotMatch(js, /items\.forEach\(function \(it, j\) \{ it\.el\.classList\.toggle/, 'a key press must not restyle every card');
});

test('TV Preview logic: library genre rows and search keys', () => {
  const sandbox = {};
  vm.runInNewContext(read('public/tv-preview/logic.js'), sandbox);
  const L = sandbox.MarqueeTvLogic;
  const genres = [{ name: 'Action', movie: 28, tv: 10759 }, { name: 'Comedy', movie: 35, tv: 35 }, { name: 'Horror', movie: 27, tv: null }];
  const library = [
    { id: 'a', tmdbId: 1, genres: [28], addedAt: 1 },
    { id: 'a2', tmdbId: 1, genres: [28], addedAt: 5 },       // second copy of the same film: listed once
    { id: 'b', tmdbId: 2, genres: [28, 35], addedAt: 3 },
    { id: 'e1', show: 'tv-9', season: 1, episode: 1, addedAt: 2 },
  ];
  const shows = [{ id: 'tv-9', tmdbId: 9, genres: [10759] }, { id: 'tv-10', tmdbId: 10, genres: [35] }]; // tv-10: not in this library
  const rows = L.genreRows(library, shows, genres);
  assert.deepEqual(JSON.parse(JSON.stringify(rows.map((r) => [r.name, r.titles.map((t) => (t.show ? t.show.id : t.film.id))]))),
    [['Action', ['b', 'tv-9', 'a']], ['Comedy', ['b']]]);
  assert.equal(L.searchKey('Spider-Man: No Way Home'), 'spidermannowayhome');
  assert.equal(L.searchKey('Amélie'), 'amelie');
  assert.ok(L.searchKey('Spider-Man').includes(L.searchKey('spider man')));
});

test('TV reconnect keeps the current position and never plays from zero after a failed restore seek', () => {
  for (const path of ['public/tv/tv.js', 'public/tv-preview/tv.js']) {
    const js = read(path);
    assert.doesNotMatch(js, /av\.seekTo\(Math\.floor\(at \* 1000\), go, go\)/,
      path + ': a failed reconnect seek must not fall through to play from 0:00');
    assert.match(js, /var live = av\.getCurrentTime\(\) \/ 1000;/,
      path + ': reconnect should snapshot AVPlay\'s last live position before closing');
    assert.match(js, /s\.time = at;\s*save\(true\);\s*spinner\.textContent = 'Reconnecting…'/,
      path + ': reconnect should persist the snapshot before reopening the stream');
    assert.match(js, /av\.seekTo\(Math\.floor\(at \* 1000\), go, function \(e\) \{[\s\S]*if \(!reopen\(\)\) fail\('Couldn’t restore your playback position\./,
      path + ': a failed restore seek should retry/fail instead of starting over');
  }
});
