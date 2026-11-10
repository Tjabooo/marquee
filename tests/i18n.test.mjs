import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import sv from '../public/i18n-sv.js';
import { T } from '../public/i18n.js';
import { translate, translateHtml, languageOf, inLanguage, currentLanguage, tr } from '../src/i18n.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const blanks = (s) => (s.match(/\{\d+\}/g) || []).sort().join();
const WEB = fs.readdirSync(new URL('../public/', import.meta.url)).filter((f) => f.endsWith('.js') && !['sw.js', 'i18n.js', 'i18n-sv.js'].includes(f));

// T('…') and T(`…`) with plain text as its first argument, without parsing the whole file.
const linesIn = (src, fn = 'T') => [...src.matchAll(new RegExp(`\\b${fn}\\('((?:[^'\\\\\\n]|\\\\.)*)'`, 'g'))]
  .map((m) => m[1].replace(/\\'/g, "'").replace(/\\n/g, '\n').replace(/\\\\/g, '\\'));

test('every line in the web app has Swedish, with the same blanks', () => {
  const missing = [];
  for (const f of WEB) for (const line of linesIn(read(`public/${f}`))) {
    if (!(line in sv)) missing.push(`${f}: ${line}`);
  }
  assert.deepEqual(missing, []);
  for (const [en, line] of Object.entries(sv)) assert.equal(blanks(line), blanks(en), en);
});

test('words given to plural() in the web app have Swedish', () => {
  const src = read('public/app.js');
  for (const m of src.matchAll(/\bplural\([^,()]*(?:\([^()]*\))?[^,()]*, '([^']+)'/g)) {
    assert.ok(m[1] in sv, m[1]);
    assert.ok(`${m[1]}s` in sv, `${m[1]}s`);
  }
});

test('the app defaults to English outside a browser and fills in blanks', () => {
  assert.equal(T('Season {0}', 2), 'Season 2');
  assert.equal(T('Not in the catalogue'), 'Not in the catalogue');
});

test('every line in the TV app has Swedish, with the same blanks', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(read('public/tv/sv.js'), sandbox);
  const strings = sandbox.window.MarqueeTvStrings;
  const lines = [...linesIn(read('public/tv/tv.js')), ...linesIn(read('public/tv/logic.js'))];
  assert.ok(lines.length > 80);
  for (const line of lines) assert.ok(line in strings, line);
  for (const [en, line] of Object.entries(strings)) assert.equal(blanks(line), blanks(en), en);
});

test('the TV app speaks Swedish when the shell loads sv.js, else English, and asks the server for the same', () => {
  const sandbox = { MarqueeTvStrings: { 'Season {0}': 'Säsong {0}' } };
  vm.runInNewContext(read('public/tv/logic.js'), sandbox);
  assert.equal(sandbox.MarqueeTvLogic.T('Season {0}', 3), 'Säsong 3');
  const english = {};
  vm.runInNewContext(read('public/tv/logic.js'), english);
  assert.equal(english.MarqueeTvLogic.T('Season {0}', 3), 'Season 3');
  assert.match(read('public/tv/tv.js'), /'X-Marquee-Lang': window\.MarqueeTvStrings \? 'sv' : 'en'/);
  assert.match(read('tv/tizen/shell.js'), /\/tv\/sv\.js/); // Samsung: always Swedish
  const android = read('tv/android/app/src/main/assets/shell.html');
  assert.match(android, /MARQUEE_SWEDISH \? \['sv\.js', 'logic\.js', 'tv\.js'\] : \['logic\.js', 'tv\.js'\]/); // Android: the TV's language
});

test('server messages: exact lines, lines with blanks, and unknown text', () => {
  assert.equal(translate('That isn’t in your library.', 'sv'), 'Den finns inte i ditt bibliotek.');
  assert.equal(translate('Waking magi', 'sv'), 'Väcker magi');
  assert.equal(translate('New episode of House', 'sv'), 'Nytt avsnitt av House');
  assert.equal(translate('qBittorrent responded with 502.', 'sv'), 'qBittorrent svarade med 502.');
  assert.equal(translate('Something nobody wrote down', 'sv'), 'Something nobody wrote down');
  assert.equal(translate('That isn’t in your library.', 'en'), 'That isn’t in your library.');
});

test('server catalogue keeps its blanks', () => {
  const catalogue = JSON.parse(read('src/i18n-sv.json'));
  for (const [en, line] of Object.entries(catalogue)) assert.equal(blanks(line), blanks(en), en);
});

test('every fixed HttpError message has Swedish', () => {
  const catalogue = JSON.parse(read('src/i18n-sv.json'));
  const missing = [];
  for (const m of read('src/server.js').matchAll(/new HttpError\(\d+, '((?:[^'\\]|\\.)*)'\)/g)) {
    if (!(m[1].replace(/\\'/g, "'") in catalogue)) missing.push(m[1]);
  }
  assert.deepEqual(missing, []);
});

test('the language of a request: app header, then cookie, then browser', () => {
  assert.equal(languageOf({ headers: { 'x-marquee-lang': 'sv', cookie: 'marquee_lang=en' } }), 'sv');
  assert.equal(languageOf({ headers: { cookie: 'a=1; marquee_lang=sv' } }), 'sv');
  assert.equal(languageOf({ headers: { 'accept-language': 'sv-SE,en;q=0.5' } }), 'sv');
  assert.equal(languageOf({ headers: { 'x-marquee-lang': 'xx', 'accept-language': 'en-GB' } }), 'en');
  assert.equal(languageOf({ headers: {} }), 'en');
});

test('a request keeps its language through async work, and pages translate their fixed text', async () => {
  await inLanguage('sv', async () => {
    await new Promise((r) => setTimeout(r, 1));
    assert.equal(currentLanguage(), 'sv');
    assert.equal(tr('Sign in'), 'Logga in');
    const html = translateHtml('<html lang="en"><button aria-label="Play (Space)">Sign in</button><p>Oliver</p></html>');
    assert.equal(html, '<html lang="sv"><button aria-label="Spela upp (mellanslag)">Logga in</button><p>Oliver</p></html>');
  });
  assert.equal(currentLanguage(), 'en');
});

test('What’s new has Swedish for every update and item', () => {
  const english = JSON.parse(read('whats-new.json'));
  const swedish = JSON.parse(read('whats-new.sv.json'));
  for (const entry of english) {
    const sv = swedish[entry.id];
    assert.ok(sv?.title, entry.id);
    for (const item of entry.items) assert.ok(sv.items[item.title]?.text, `${entry.id}: ${item.title}`);
  }
});
