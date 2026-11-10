import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('There is one TV app: the Tizen shell loads /tv under the Marquee package', () => {
  const config = read('tv/tizen/config.xml.in');
  const shell = read('tv/tizen/shell.js');
  assert.match(config, /MrqTvApp01\.Marquee/);
  assert.match(config, /<name>Marquee<\/name>/);
  assert.match(shell, /\/tv\/tv\.js/);
  assert.doesNotMatch(shell + config, /tv-preview|MrqTvPrv01/);
  assert.equal(fs.existsSync(new URL('../public/tv-preview', import.meta.url)), false);
  assert.equal(fs.existsSync(new URL('../tv/tizen-preview', import.meta.url)), false);
});

test('TV client parses as old-browser JavaScript and uses server-side Discover/download APIs', () => {
  const js = read('public/tv/tv.js');
  const shell = read('tv/tizen/shell.js');
  assert.doesNotThrow(() => new vm.Script(js));
  assert.doesNotThrow(() => new vm.Script(shell));
  assert.match(js, /\/api\/discover\/home\?type=/);
  assert.match(js, /\/api\/discover\/list\?key=/);
  assert.match(js, /\/api\/discover\/genre\?type=/);
  assert.match(js, /\/api\/search\?q=/);
  assert.match(js, /\/api\/downloads\/smart/);
  assert.match(js, /\/api\/tv\//);
  assert.doesNotMatch(js, /\?\./, 'Chrome 69 TV client must not use optional chaining');
  assert.doesNotMatch(js, /\?\?/, 'Chrome 69 TV client must not use nullish coalescing');
});

test('TV keeps its render budget deliberately small', () => {
  const js = read('public/tv/tv.js');
  // Rows and grids grow as you scroll, but stop at a cap, and posters load only near the screen.
  assert.match(js, /var ROW_MAX = 60\b/);
  assert.match(js, /GRID_MAX = 300\b/);
  assert.match(js, /function lazy\(src\)/);
  assert.doesNotMatch(js, /items\.forEach\(function \(it, j\) \{ it\.el\.classList\.toggle/, 'a key press must not restyle every card');
});

test('TV logic: library genre rows and search keys', () => {
  const sandbox = {};
  vm.runInNewContext(read('public/tv/logic.js'), sandbox);
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

test('the search keyboard has å ä ö only on a Swedish TV', () => {
  const js = read('public/tv/tv.js');
  const m = js.match(/var KEYBOARD = \(window\.MarqueeTvStrings \? ('[^']*')\s*: ('(?:[^'\\]|\\.)*')\)\.split/);
  assert.ok(m, 'KEYBOARD picks its layout by language');
  const [sv, en] = [m[1], m[2]].map((s) => vm.runInNewContext(s).split(''));
  assert.ok(sv.includes('å') && sv.includes('ö'));
  assert.deepEqual(en.filter((c) => /[åäö]/.test(c)), []);
  const rows = Number(js.match(/var KEY_ROWS = (\d+);/)[1]);
  for (const keys of [sv, en]) { assert.equal(keys.length, rows * 6); assert.equal(new Set(keys).size, keys.length); }
});

test('TV reconnect keeps the current position and never plays from zero after a failed restore seek', () => {
  for (const path of ['public/tv/tv.js', 'public/tv/tv.js']) {
    const js = read(path);
    assert.doesNotMatch(js, /av\.seekTo\(Math\.floor\(at \* 1000\), go, go\)/,
      path + ': a failed reconnect seek must not fall through to play from 0:00');
    assert.match(js, /var live = av\.getCurrentTime\(\) \/ 1000;/,
      path + ': reconnect should snapshot AVPlay\'s last live position before closing');
    assert.match(js, /s\.time = at;\s*save\(true\);\s*spinner\.textContent = T\('Reconnecting…'\)/,
      path + ': reconnect should persist the snapshot before reopening the stream');
    assert.match(js, /av\.seekTo\(Math\.floor\(at \* 1000\), go, function \(e\) \{[\s\S]*if \(!reopen\(\)\) fail\(T\('Couldn’t restore your playback position\./,
      path + ': a failed restore seek should retry/fail instead of starting over');
  }
});

test('Rust TV app: every line has Swedish, the shell starts it and falls back to the JavaScript app', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(read('public/tv/sv.js'), sandbox);
  const strings = sandbox.window.MarqueeTvStrings;
  const dir = new URL('../tv/rust/src/', import.meta.url);
  const src = fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.rs')).map((f) => fs.readFileSync(new URL(f, dir), 'utf8')).join('\n');
  const lines = [...src.matchAll(/(?<![A-Za-z_])t!\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  assert.ok(lines.length > 100);
  for (const line of lines) assert.ok(line in strings, line);
  const shell = read('tv/tizen/shell.js');
  assert.match(shell, /\/tv-rs\/host\.js/);
  assert.match(shell, /onFail/);
  assert.match(shell, /\/tv\/tv\.js/);
});

test('Rust TV host is old-browser JavaScript and the built app is in public/', () => {
  const host = read('public/tv-rs/host.js');
  assert.doesNotThrow(() => new vm.Script(host));
  assert.doesNotMatch(host, /\?\./, 'Chrome 69 must not see optional chaining');
  assert.doesNotMatch(host, /\?\?/, 'Chrome 69 must not see nullish coalescing');
  const wasm = fs.readFileSync(new URL('../public/tv-rs/marquee_tv.wasm', import.meta.url));
  assert.deepEqual([...wasm.subarray(0, 4)], [0, 0x61, 0x73, 0x6d]);
  // Every function Rust imports is one host.js provides.
  const mod = new WebAssembly.Module(wasm);
  for (const imp of WebAssembly.Module.imports(mod)) assert.match(host, new RegExp('\\b' + imp.name + ': '), imp.name);
});
