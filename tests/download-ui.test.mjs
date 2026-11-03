// The simplified Download experience: one command, no release lists or quality rails by default.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const css = await fs.readFile(new URL('../public/style.css', import.meta.url), 'utf8');
const between = (a, b) => app.slice(app.indexOf(a), app.indexOf(b, app.indexOf(a)));
const details = between('function renderDetails(', '// "Already on the server"');
const ui = between('// ---------- Download: you choose what', '// ---------- casting: device picker');
const show = between('function renderShow() {', '// ---------- Downloads ----------');

test('title sheets offer Play / Download, never a release list, quality rail or second search', () => {
  assert.match(details, /filmActions\(t\)/);
  assert.match(details, /showDownload\(t\)/);
  assert.doesNotMatch(app, /seasonStrip|bestDownload|getSeason\(|Get only missing episodes|Find another release|api\/torrents\/recommend|api\/downloads\/season/);
  assert.equal((app.match(/openTorrents\(/g) || []).length, 2, 'only the Find torrents sheet itself and its button');
});

test('a film downloads with one press; a show uses the minimal season panel', () => {
  assert.match(ui, /get\.addEventListener\('click', start\)/);
  assert.match(ui, /runDownloadCommand\(body\(\)\)/);
  assert.match(ui, /api\('\/api\/downloads\/smart', jsonPost\(body\)\)/);
  for (const text of ['\'Season\'', '\'Quality\'', 'Smart selection chooses a suitable season download and skips episodes you already have.',
    'Download Season', 'Advanced options', 'This season is ready to watch', 'Remaining episodes are downloading', 'Retry unavailable']) assert.ok(ui.includes(text), text);
  assert.match(ui, /\['balanced', 'Balanced · 1080p'\]/);
  assert.match(ui, /'aria-expanded': String\(ps\.open\), 'aria-controls': panelId/);
  assert.match(ui, /if \(e\.detail === 0\) seasonSel\.focus\(\)/, 'keyboard opens straight onto Season');
});

test('manual releases and an exact resolution only appear inside Advanced options', () => {
  const adv = between('function advancedOptions(', '// Films: Play when');
  assert.match(adv, /h\('details', \{ class: 'advanced' \}/);
  assert.match(adv, /torrentBrowser\(browse\(\)\)/);
  assert.match(adv, /Exact quality/);
});

test('Library shows state and progress only; details carry speed and ETA', () => {
  const card = between('function makeUnifiedCard(', 'function openUnifiedTitle(');
  assert.doesNotMatch(card, /transfer-stats|fmtEta|entry\.speed/);
  assert.doesNotMatch(css, /\.transfer-stats/);
  assert.match(css, /\.library-transfer \{ min-height: 42px;/);
  assert.match(show, /showDownload\(\{ id: show\.tmdbId, title: show\.title, type: 'tv' \}, \{ season: open\?\.number \?\? null \}\)/);
  assert.match(show, /episodeDownload\(tvId, open\.number, number\)/);
});

test('Settings has one Downloads group: profile, size limit, audio language', () => {
  const settings = between('function renderSettings() {', 'function ownerSettings()');
  assert.match(settings, /saveMe\(\{ downloadProfile: v \}\)/);
  assert.match(settings, /saveMe\(\{ maxSize: Number\(v\) \}\)/);
  assert.match(settings, /saveMe\(\{ audioLang: v \}\)/);
  assert.doesNotMatch(settings, /Preferred quality/);
});
