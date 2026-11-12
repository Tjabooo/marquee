// Fake releases: a torrent named like the episode that holds a program. Spotted from its file list,
// it no longer holds up the season, is never picked again, and the Download runs again for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeRelease } from '../src/fake-release.js';
import { planEpisodeOrder } from '../src/episode-order.js';
import { parseTpb } from '../src/torrents.js';
import { parseName } from '../src/release-name.js';
import { startSmartJob, smartJob, fakeFound } from '../src/smart-download.js';

const MB = 1024 ** 2, GB = 1024 ** 3;

test('a program dressed as an episode is fake; a real video with extras is not', () => {
  assert.match(fakeRelease([{ name: 'South Park S29E01 South America 1080p WEB-DL x265 NTb.exe', size: 1053 * MB }]), /program/);
  assert.match(fakeRelease([{ name: 'Show.S01E01/Show.S01E01.wmv', size: 3 * MB }, { name: 'Show.S01E01/codec.exe', size: 2 * MB }]), /codec\.exe/, 'a "codec" lure');
  assert.match(fakeRelease([{ name: 'Show.S01E01/Sample/sample.mkv', size: 60 * MB }, { name: 'Show.S01E01/Show.S01E01.lnk', size: 1024 }]), /\.lnk/);
  assert.equal(fakeRelease([{ name: 'Show.S01E01.1080p.mkv', size: 900 * MB }]), null);
  assert.equal(fakeRelease([{ name: 'Film/Film.mkv', size: 8 * GB }, { name: 'Film/Extras/Menu.exe', size: 4 * MB }]), null, 'a real film with a stray program');
  assert.equal(fakeRelease([]), null, 'no metadata yet: not judged');
});

test('a torrent with nothing playable never holds up the season', () => {
  const ep = (hash, n, files, extra = {}) => ({ hash, name: `Show S01E0${n} 1080p WEB`, state: 'downloading', progress: 0, files, ...extra });
  const real = (n) => [{ index: 0, name: `Show.S01E0${n}.mkv`, progress: 0, priority: 1 }];
  // E01: the fake's lone .exe switched off by qBittorrent, so it "seeds" at 0 % forever
  const fake = ep('a', 1, [{ index: 0, name: 'Show S01E01 1080p WEB.exe', progress: 0, priority: 0 }], { state: 'stalledUP' });
  const plan = planEpisodeOrder({ season: 1, torrents: [fake, ep('b', 2, real(2), { state: 'stoppedDL' }), ep('c', 3, real(3), { state: 'stoppedDL' })] }, new Set(['b', 'c']));
  assert.deepEqual(plan.running, [{ hash: 'b', episode: 2 }]);
  assert.deepEqual(plan.start, ['b']);
  // no metadata yet (no files): still ordered by its name, as before
  const waiting = planEpisodeOrder({ season: 1, torrents: [ep('a', 1, [], { state: 'metaDL' }), ep('b', 2, real(2))] });
  assert.deepEqual(waiting.running.map((r) => r.episode), [1, 2]);
});

test('a removed fake is never picked again and its Download runs again for that episode', async () => {
  let n = 0;
  const rows = (list) => parseTpb(list.map(([name, seeders]) => ({
    info_hash: (0xfa000 + ++n).toString(16).padStart(40, '0'), name, seeders, leechers: 0, size: 1.1 * GB, category: '208', status: 'member',
  })), 'all');
  const e1 = rows([['South Park S29E01 South America 1080p WEB-DL x265 NTb', 268], ['South.Park.S29E01.1080p.WEB.H264-SuccessfulCrab', 90]]);
  const e2 = rows([['South.Park.S29E02.1080p.WEB.H264-FLUX', 400]]);
  const added = [];
  let queued = [];
  const deps = {
    parseName,
    seasonEpisodes: async () => ({ episodes: [1, 2].map((e) => ({ episode: e, aired: true })) }),
    haveEpisodes: async () => { const s = new Set(queued); s.queued = new Set(queued); return s; },
    searchTorrents: async (q) => ({ results: /S29E01/.test(q) ? e1 : /S29E02/.test(q) ? e2 : [] }),
    addDownload: async (d) => { added.push(d); return { existing: false }; },
  };
  const wait = async (id) => { for (let i = 0; i < 400 && smartJob(id).state === 'running'; i++) await new Promise((r) => setTimeout(r, 5)); return smartJob(id); };
  await wait(startSmartJob({ type: 'tv', title: 'South Park', season: 29, want: {} }, deps));
  assert.deepEqual(added.map((d) => d.name), ['South Park S29E01 South America 1080p WEB-DL x265 NTb', 'South.Park.S29E02.1080p.WEB.H264-FLUX']);
  queued = [2]; // E02 still on its way; the fake (E01) has just been removed
  const fakeHash = /btih:([a-z0-9]+)/i.exec(added[0].link)[1];
  const { retried } = fakeFound(fakeHash);
  assert.ok(retried, 'the Download ran again');
  const job = await wait(retried);
  assert.deepEqual(added.slice(2).map((d) => d.name), ['South.Park.S29E01.1080p.WEB.H264-SuccessfulCrab']);
  assert.equal(job.outcome, 'started');
  assert.equal(fakeFound('0'.repeat(40)), null, 'a torrent Lilin’s search didn’t add: nothing to run again');
});
