// Versions: copies of one film or episode in different qualities are one title with a choice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { qualityOf, versionKey, versionInfo, collapseVersions, sameQuality, seasonKey } from '../src/versions.js';

const GB = 1024 ** 3;
const item = (id, file, extra = {}) => {
  const base = { id, file, size: 10 * GB, ...extra };
  return { ...base, ...versionInfo(base), versionKey: versionKey(base) };
};

test('quality and labels come from the file name', () => {
  assert.equal(qualityOf('Dune.2021.2160p.UHD.BluRay.x265.mkv'), '2160p');
  assert.equal(qualityOf('House, M.D. S03E01 (1080p x265 Joy).mp4'), '1080p');
  assert.equal(qualityOf('Old.Show.S01E01.DVDRip.XviD.avi'), 'SD');
  assert.equal(qualityOf('Home Movie.mp4'), null);
  assert.equal(item('a', 'Dune.2021.2160p.BluRay.x265.mkv', { size: 18.2 * GB }).versionLabel, '4K · BluRay · 18.2 GB');
  assert.equal(item('a', 'x.S01E01.1080p.WEB-DL.mkv').versionSignature, '1080p|web');
});

test('films group by TMDB id (else title and year), episodes by show, season and episode', () => {
  assert.equal(versionKey({ tmdbId: 438631, title: 'Dune' }), 'film:438631');
  assert.equal(versionKey({ tmdbId: 1, movieAmbiguous: true, title: 'Dune', year: 2021 }), 'film:dune:2021');
  assert.equal(versionKey({ show: 'tv-1408', title: 'House', season: 3, episode: 1 }), 'ep:tv-1408:3:1');
  assert.equal(seasonKey({ show: 'tv-1408', season: 3, episode: 1 }), 'season:tv-1408:3');
  assert.equal(versionKey({ title: 'House', season: 3, episode: null }), null, 'season extras stay apart');
});

test('versions collapse into one item, best first, others under versions', () => {
  const list = [
    item('a', 'Dune.2021.1080p.BluRay.x264.mkv', { tmdbId: 1, size: 9 * GB }),
    item('m', 'Arrival.2016.1080p.mkv', { tmdbId: 2 }),
    item('b', 'Dune.2021.2160p.WEB-DL.x265.mkv', { tmdbId: 1, size: 18 * GB }),
    item('e', 'Notes.mp4'),
  ];
  const out = collapseVersions(list);
  assert.equal(out.length, 3);
  const dune = out.find((i) => i.tmdbId === 1);
  assert.equal(dune.id, 'b'); assert.deepEqual(dune.versions.map((v) => v.id), ['b', 'a']);
  assert.equal(out.find((i) => i.id === 'm').versions, undefined, 'a single file has no versions list');
});

test('same resolution is the same version; unknown only matches unknown', () => {
  assert.ok(sameQuality('1080p', '1080p'));
  assert.ok(!sameQuality('1080p', '2160p'));
  assert.ok(sameQuality(null, undefined));
  assert.ok(!sameQuality(null, '1080p'));
});
