import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { pickBest } from '../recommend.js';
import { parseTpb } from '../torrents.js';

// The server's own release-name parser, taken from server.js so the test can't drift from it.
const server = await fs.readFile(new URL('../server.js', import.meta.url), 'utf8');
const parseName = vm.runInNewContext(server.slice(server.indexOf('const EPISODE_PATTERNS'), server.indexOf('// A file\'s name info')) + '\nparseName');

const GB = 1024 ** 3;
let n = 0;
// Search results as torrents.js makes them, from apibay-shaped rows.
const results = (rows) => parseTpb(rows.map(([name, seeders, size = 2 * GB, status = 'member']) => ({
  info_hash: (++n).toString(16).padStart(40, '0'), name, seeders, leechers: 0, size, category: '207', status,
})), 'all');
const pick = (rows, want) => pickBest(results(rows), want, parseName).pick?.name ?? null;
const film = { type: 'movie', title: 'The Matrix', year: 1999 };

test('a film never gets a 720p download while a 1080p or 4K one exists', () => {
  assert.equal(pick([
    ['The.Matrix.1999.720p.BluRay.x264', 2000],
    ['The.Matrix.1999.1080p.BluRay.x264', 40],
    ['The.Matrix.1999.2160p.UHD.BluRay.x265', 300, 18 * GB],
  ], film), 'The.Matrix.1999.1080p.BluRay.x264', '1080p comes first');
  assert.equal(pick([
    ['The.Matrix.1999.720p.BluRay.x264', 2000],
    ['The.Matrix.1999.2160p.UHD.BluRay.x265', 300, 18 * GB],
  ], film), 'The.Matrix.1999.2160p.UHD.BluRay.x265', '4K when there is no 1080p');
  assert.equal(pick([
    ['The.Matrix.1999.720p.BluRay.x264', 2000],
    ['The.Matrix.1999.1080p.WEB-DL', 3],
  ], film), 'The.Matrix.1999.1080p.WEB-DL', 'A thin 1080p still beats a busy 720p');
  assert.equal(pick([
    ['The.Matrix.1999.720p.BluRay.x264', 2000],
    ['The.Matrix.1999.1080p.WEB-DL', 1],
  ], film), 'The.Matrix.1999.720p.BluRay.x264', 'One seeder is as good as none, so 720p it is');
  const low = pickBest(results([['The.Matrix.1999.720p.BluRay.x264', 20]]), film, parseName);
  assert.match(low.why, /Nothing in 1080p or 4K/);
});

test('4K first when Settings prefers it; healthy torrents before thin ones', () => {
  const rows = [['The.Matrix.1999.1080p.BluRay.x264', 400], ['The.Matrix.1999.2160p.UHD.BluRay.x265', 60, 20 * GB]];
  assert.equal(pick(rows, { ...film, prefer: '2160p' }), 'The.Matrix.1999.2160p.UHD.BluRay.x265');
  assert.equal(pick([
    ['The.Matrix.1999.1080p.WEB-DL', 3],
    ['The.Matrix.1999.2160p.UHD.BluRay.x265', 60, 20 * GB],
  ], film), 'The.Matrix.1999.2160p.UHD.BluRay.x265', 'A 3-seeder 1080p loses to a healthy 4K');
});

test('wrong films, cams, remuxes, burned-in subtitles and fakes are passed over', () => {
  assert.equal(pick([
    ['The.Matrix.Reloaded.2003.1080p.BluRay', 5000],
    ['The.Matrix.Resurrections.2021.1080p', 5000],
    ['The.Matrix.1999.HDCAM.1080p', 5000],
    ['The.Matrix.1999.1080p.BluRay.REMUX.AVC', 900, 30 * GB],
    ['The.Matrix.1999.1080p.HC.WEBRip', 900],
    ['The.Matrix.1999.1080p.BluRay.mkv', 900, 0.1 * GB],
    ['The.Matrix.1999.1080p.BluRay.x264', 150],
  ], film), 'The.Matrix.1999.1080p.BluRay.x264');
  assert.equal(pick([['The.Matrix.Reloaded.2003.1080p.BluRay', 5000]], film), null);
  assert.equal(pick([['The.Matrix.1987.1080p', 5000]], film), null, 'Same name, another year');
});

test('a show gets a pack of exactly the season asked for', () => {
  const show = { type: 'tv', title: 'Severance', season: 2 };
  assert.equal(pick([
    ['Severance.S02E03.1080p.WEB.h264', 5000],
    ['Severance.S01-S02.1080p.WEB', 5000],
    ['Severance.S01.1080p.WEB', 5000],
    ['Severance.S02.720p.WEB', 900],
    ['Severance.S02.1080p.ATVP.WEB-DL.DDP5.1.H.264', 120],
  ], show), 'Severance.S02.1080p.ATVP.WEB-DL.DDP5.1.H.264');
  assert.equal(pick([['Severance Season 2 Complete 1080p', 30]], show), 'Severance Season 2 Complete 1080p');
  assert.equal(pick([['Severance.S02E01.1080p', 300]], show), null, 'Episodes only: no pack to recommend');
  const office = { type: 'tv', title: 'The Office', season: 3 };
  assert.equal(pick([['The.Office.US.S03.1080p.BluRay.x265', 378], ['The.Office.Ladies.S03.1080p', 900]], office),
    'The.Office.US.S03.1080p.BluRay.x265', 'A country tag is fine; another show is not');
  assert.equal(pick([['The.Office.US.S03.1080p.BluRay.x265', 378], ['The.Office.S03.1080p.WEB', 40]], office),
    'The.Office.S03.1080p.WEB', 'The plain name wins over a country-tagged one');
});
