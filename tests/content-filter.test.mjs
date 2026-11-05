import test from 'node:test';
import assert from 'node:assert/strict';
import { adultReason, firstAdult, torrentFileNames } from '../src/content-filter.js';
import { parse1337x, parseTpb } from '../src/torrents.js';

const ADULT = [
  'ZZSeries 18 10 02 Brazzers House 3 Episode 3  480p MP4-XXX',
  'Vixen.24.01.05.Jane.Doe.XXX.1080p.MP4-WRB',
  'Vixen 24 01 05 Jane Doe 2160p',
  'Reality Kings 2023 05 06 Someone',
  'RealityKings - Some Scene',
  'Some.Name.OnlyFans.SiteRip.2024',
  'SSIS-123 Uncensored Leaked',
  'FC2-PPV-1234567',
  'Hentai Collection Vol 2',
  'Playboy.21.03.04.Model.Name',
];
const ORDINARY = [
  'xXx.2002.1080p.BluRay.x264', 'xXx Return of Xander Cage 2017 1080p', 'Sex Education S01E01 1080p',
  'Masters of Sex S01E01', 'Vixen 1968 1080p BluRay', 'Private Practice S01 1080p', 'Saving Private Ryan 1998 2160p',
  'Deeper 2024 1080p', 'The Daily Show 2024 01 05 1080p', 'Show.Jul.2023.720p', 'Stars.2024.1080p', 'BBC Planet Earth III',
  'The Naked Gun 2025 1080p', 'Kink 2013 documentary', 'Hustlers 2019 1080p', 'Evil Angel 2009 DVDRip',
  'Babes in Toyland 1961', 'Penthouse North 2013', 'The Girl Next Door 2004 Unrated', 'Abp 2023',
];

test('adult release names are recognised', () => {
  for (const name of ADULT) assert.ok(adultReason(name), name);
});

test('ordinary films and shows pass, including ones with lookalike words', () => {
  for (const name of ORDINARY) assert.equal(adultReason(name), null, name);
});

test('firstAdult reports the name that matched', () => {
  assert.equal(firstAdult(['Example.Show.S01', 'pack/Brazzers.Scene.mp4'])?.name, 'pack/Brazzers.Scene.mp4');
  assert.equal(firstAdult(['Example.Show.S01', '', null]), null);
});

const bstr = (s) => { const b = Buffer.from(s); return Buffer.concat([Buffer.from(`${b.length}:`), b]); };
function torrent(name, paths) {
  const files = paths.map((p) => Buffer.concat([Buffer.from('d6:lengthi10e4:pathl'), ...p.split('/').map(bstr), Buffer.from('ee')]));
  return Buffer.concat([Buffer.from('d8:announce'), bstr('udp://x'), Buffer.from('4:infod5:filesl'), ...files,
    Buffer.from('e4:name'), bstr(name), Buffer.from('12:piece lengthi16384e6:pieces'), bstr('ÿ'.repeat(20)), Buffer.from('ee')]);
}

test('.torrent files are read for their name and file paths', () => {
  assert.deepEqual(torrentFileNames(torrent('Pack', ['a/One.mkv', 'Two.mkv'])), ['Pack', 'a/One.mkv', 'Two.mkv']);
  assert.ok(firstAdult(torrentFileNames(torrent('Clean name', ['Scene.XXX.1080p.mp4']))));
  assert.deepEqual(torrentFileNames(Buffer.from('not a torrent')), []);
  assert.deepEqual(torrentFileNames(Buffer.from('d4:infod4:name99999:xee')), []);
});

test('search parsers mark adult categories', () => {
  const row = (sub, name) => `<tr><td class="coll-1 name"><a href="/sub/${sub}/0/" class="icon"><i></i></a><a href="/torrent/1/${name}/">${name}</a></td><td class="coll-2 seeds">5</td></tr>`;
  const [film, adult] = parse1337x(`<table>${row(42, 'Film-2020')}${row(48, 'Clean-Looking-Name')}</table>`);
  assert.equal(film.adult, false);
  assert.equal(adult.adult, true);
  const tpb = parseTpb([
    { info_hash: 'a'.repeat(40), name: 'Film 2020', category: '207' },
    { info_hash: 'b'.repeat(40), name: 'Clip', category: '505' },
  ], 'all');
  assert.deepEqual(tpb.map((t) => t.name), ['Film 2020']);
});
