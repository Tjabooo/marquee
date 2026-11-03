import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const details = app.slice(app.indexOf('function renderDetails('), app.indexOf('// "Already on the server"'));
const strip = app.slice(app.indexOf('function seasonStrip('), app.indexOf('// Requests worth repeating'));
const recommendation = app.slice(app.indexOf('function bestDownload('), app.indexOf('// A whole season episode by episode'));

test('season chips on show details select the recommended season rather than manual torrent search', () => {
  assert.match(details, /seasonStrip\(t, \[\.\.\.files, \.\.\.onServer\], \(n\) => recommended\?\.selectSeason\?\.\(n\)\)/);
  assert.match(strip, /onSelect \? onSelect\(se\.number\) : openTorrents/);
});
test('recommended download exposes a season chooser and checks packs before the missing-only fallback', () => {
  assert.match(recommendation, /Recommended download season/);
  assert.match(recommendation, /box\.selectSeason =/);
  assert.match(recommendation, /const rec = await cachedFor\(`\/api\/torrents\/recommend\?/);
  assert.match(recommendation, /if \(rec\.pick\) return showPick\(rec, targetSeason, alreadyHere\)/);
  assert.match(recommendation, /Get only missing episodes/);
  assert.match(recommendation, /alreadyHere >= targetSeason\.episodes/);
});
