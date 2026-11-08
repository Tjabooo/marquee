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
  assert.match(details, /showDownload\(t, \{ onAdded: \(\) => renderDetails\(t\) \}\)/);
  assert.doesNotMatch(app, /seasonStrip|bestDownload|getSeason\(|Get only missing episodes|Find another release|api\/torrents\/recommend|api\/downloads\/season/);
  assert.equal((app.match(/openTorrents\(/g) || []).length, 2, 'only the Find torrents sheet itself and its button');
});

test('a film downloads with one press; a show uses the minimal season panel', () => {
  assert.match(ui, /get\.addEventListener\('click', async \(\) => \{[\s\S]*?return start\(\);/);
  assert.match(ui, /runDownloadCommand\(body\(\)\)/);
  assert.match(ui, /api\('\/api\/downloads\/smart', jsonPost\(body\)\)/);
  for (const text of ['\'Season\'', '\'Quality\'', 'Marquee picks a good copy of the season and skips episodes you already have.',
    'Add Season', 'Advanced options', 'This season is ready to watch', 'The rest are on their way', 'Retry unavailable']) assert.ok(ui.includes(text), text);
  assert.match(ui, /\['balanced', T\('Balanced · 1080p'\)\]/);
  assert.match(ui, /'aria-expanded': String\(ps\.open\), 'aria-controls': panelId/);
  assert.match(ui, /if \(e\.detail === 0\) seasonSel\.focus\(\)/, 'keyboard opens straight onto Season');
});

test('a show someone else already has joins your library in one press, every season, in batches the API accepts', () => {
  assert.match(ui, /const extra = dub\.dubbing\(\) \? \[\] : serverOnlyEpisodes\(titleState\(t\)\);\s+if \(extra\.length\) return addEverything\(extra\);\s+ps\.open = !ps\.open;/, 'adds before any panel opens');
  assert.match(ui, /function serverOnlyEpisodes\(s, season = null\)/);
  assert.match(ui, /const ADD_BATCH = 400;/);
  assert.match(ui, /files\.slice\(i, i \+ ADD_BATCH\)/);
  assert.match(app, /await addIds\(files\);\s+await loadLibrary\(\);/, 'the no-download-rights offer uses the same batches');
  assert.match(ui, /addingAll \? T\('Adding…'\)/);
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
  assert.match(show, /showDownload\(\{ id: show\.tmdbId, title: show\.title, type: 'tv' \}, \{ season: open\?\.number \?\? null, onAdded: renderShow \}\)/);
  assert.match(show, /episodeDownload\(tvId, open\.number, number\)/);
});

test('Settings has one Downloads group: profile, size limit, audio language', () => {
  const settings = between('function renderSettings() {', 'function ownerSettings()');
  assert.match(settings, /saveMe\(\{ downloadProfile: v \}\)/);
  assert.match(settings, /saveMe\(\{ maxSize: Number\(v\) \}\)/);
  assert.match(settings, /saveMe\(\{ audioLang: v \}\)/);
  assert.doesNotMatch(settings, /Preferred quality/);
});

test('the Audio choice is for anime, sends dub, and Dubbed counts only dual-audio copies', () => {
  const ui = app;
  assert.match(ui, /\/api\/title\/\$\{t\.type\}\/\$\{t\.id\}\/dub/);
  assert.match(ui, /if \(!anime\) return;/, 'hidden unless the server says it is anime');
  assert.equal((ui.match(/\.\.\.\(dub\.anime \? \{ dub: dub\.dubbing\(\) \} : \{\}\)/g) || []).length, 2, 'films and seasons');
  assert.match(ui, /ready: full\.ready\.filter\(isDubbedCopy\), onServer: full\.onServer\.filter\(isDubbedCopy\)/);
  assert.match(ui, /b\.dub \? 'dub' : ''/, 'dubbed and subtitled requests are separate commands');
});

test('an anime others have here offers Add dubbed beside the one-press add', () => {
  assert.match(app, /dubBtn\.hidden = !\(addsAll && dub\.anime && !addingAll\)/, 'only when one press would add copies, anime only');
  assert.match(app, /dubBtn\.addEventListener\('click', \(\) => \{\s+dub\.choose\('dub'\);\s+ps\.open = true;/, 'opens the panel set to Dubbed');
  assert.match(app, /tv\.toggle, tv\.dubBtn\)/);
  assert.match(app, /tv\?\.toggle, tv\?\.dubBtn, deleteShow\)/);
});

test('Upgrade quality sits with the season and in the player, not in the add panel', () => {
  assert.doesNotMatch(between('function showDownload(', '// Upgrade quality: the season is here'), /Upgrade quality|upgrade: true/);
  assert.match(show, /seasonUpgrade\(tvId, open\.number\)/);
  const menu = between('function renderQualityMenu() {', '// Another version of what');
  assert.match(menu, /qualityBtn\.hidden = !stream && !vers && !upgrade/, 'the menu opens for the upgrade alone');
  assert.match(menu, /quality-upgrade/);
});

test('the Dubbed hint runs under the row, so it never stretches the field beside Audio', () => {
  assert.doesNotMatch(between('function audioChoice(', '// Films: Play when'), /T\('Audio'\)\), sel, hint\)/);
  assert.match(between('function showDownload(', '// Upgrade quality: the season is here'), /rangeRow, dub\.hint\)/);
  assert.match(css, /\.dl-fields > \.dl-audio-hint \{ grid-column: 1 \/ -1; \}/);
  assert.match(css, /\.dl-field \{ display: grid; align-content: start;/);
});
