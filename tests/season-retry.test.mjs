import test from 'node:test';
import assert from 'node:assert/strict';
import { startSeasonJob, seasonJob, episodesIn } from '../season.js';

const parseName = (name) => {
  const match = /^(.*?)\.S(\d{2})E(\d{2})/i.exec(name);
  return { title: match?.[1] || '', season: Number(match?.[2]), episode: Number(match?.[3]) };
};
const row = (ep) => ({ name: `House.S02E${String(ep).padStart(2, '0')}.1080p.WEB`, seeders: 12, quality: '1080p', magnet: `magnet:${ep}` });
const wait = async (id) => {
  for (let i = 0; i < 200 && seasonJob(id).state === 'running'; i++) await new Promise((r) => setTimeout(r, 5));
  return seasonJob(id);
};

test('season batch retries broad search for episodes missing from TV category', async () => {
  const searches = [], added = [];
  const id = startSeasonJob({ title: 'House', season: 2 }, {
    parseName, seasonEpisodes: async () => ({ episodes: [1, 5, 23].map((episode) => ({ episode, aired: true })) }),
    haveEpisodes: async () => new Set(),
    searchTorrents: async (query, type) => {
      searches.push([query, type]);
      const ep = Number(/E(\d+)/.exec(query)[1]);
      return { results: type === 'all' ? [row(ep)] : [] };
    },
    addDownload: async ({ link }) => added.push(link),
  });
  const result = await wait(id);
  assert.equal(result.state, 'done');
  assert.deepEqual(result.missing, []);
  assert.equal(added.length, 3);
  assert.equal(searches.filter(([, type]) => type === 'all').length, 3);
});

test('a failed episode download is reported and does not stop subsequent episodes', async () => {
  const added = [];
  const id = startSeasonJob({ title: 'House', season: 3 }, {
    parseName, seasonEpisodes: async () => ({ episodes: [1, 2].map((episode) => ({ episode, aired: true })) }),
    haveEpisodes: async () => new Set(),
    searchTorrents: async (query) => ({ results: [{ ...row(Number(/E(\d+)/.exec(query)[1])), name: query.replace(/ /g, '.') + '.1080p.WEB' }] }),
    addDownload: async ({ link }) => { if (link === 'magnet:1') throw Error('Download rejected'); added.push(link); },
  });
  const result = await wait(id);
  assert.equal(result.state, 'done');
  assert.deepEqual(result.missing, [1]);
  assert.match(result.errors[0].message, /rejected/);
  assert.deepEqual(added, ['magnet:2']);
});

test('House aliases and alternate episode numbering are accepted without matching other House shows', async () => {
  const added = [], queries = [];
  const id = startSeasonJob({ title: 'House', season: 2 }, {
    parseName: (name) => {
      const m = /^(.*?)\.(?:S\d{2}E\d{2}|\d+x\d+)/i.exec(name);
      return { title: m?.[1]?.replaceAll('.', ' ') || '' };
    },
    seasonEpisodes: async () => ({ episodes: [1, 5, 23].map((episode) => ({ episode, aired: true })) }),
    haveEpisodes: async () => new Set([5]),
    searchTorrents: async (query, type) => {
      queries.push([query, type]);
      if (query === 'House MD S02E01') return { results: [
        { ...row(1), name: 'House.of.the.Dragon.S02E01.1080p.WEB' },
        { ...row(1), name: 'House.MD.S02E01.1080p.WEB' },
      ] };
      if (query === 'House MD 2x23') return { results: [
        { ...row(23), name: 'House.MD.2x23.1080p.WEB' },
      ] };
      return { results: [] };
    },
    addDownload: async ({ name }) => added.push(name),
  });
  const result = await wait(id);
  assert.equal(result.state, 'done');
  assert.deepEqual(result.have, [5]);
  assert.deepEqual(result.missing, []);
  assert.equal(added.length, 2);
  assert.ok(added.every((name) => name.startsWith('House.MD.')));
  assert.ok(queries.every(([query]) => !/E05|2x05/.test(query)), 'already-present episodes are never searched');
});

test('a partly present season skips existing and queued episodes before searching', async () => {
  const searched = [], added = [];
  const id = startSeasonJob({ title: 'Some Show', season: 4 }, {
    parseName,
    seasonEpisodes: async () => ({ episodes: [1, 2, 3, 4].map((episode) => ({ episode, aired: true })) }),
    haveEpisodes: async () => new Set([1, 3]),
    searchTorrents: async (query) => {
      searched.push(query);
      const ep = Number(/E(\d+)/.exec(query)?.[1] || /x(\d+)/.exec(query)?.[1]);
      return { results: [{ ...row(ep), name: `Some.Show.S04E${String(ep).padStart(2, '0')}.1080p.WEB` }] };
    },
    addDownload: async ({ name }) => added.push(name),
  });
  const result = await wait(id);
  assert.deepEqual(result.have, [1, 3]);
  assert.deepEqual(added.map((name) => Number(/E(\d+)/.exec(name)[1])), [2, 4]);
  assert.ok(searched.every((query) => !/E01|E03|4x01|4x03/.test(query)));
});

test('episode coverage distinguishes discrete releases, ranges and long-form numbering', () => {
  assert.deepEqual(episodesIn('Show.S01E01E03.1080p', 1), [1, 3]);
  assert.deepEqual(episodesIn('Show.S01E01E02E03.1080p', 1), [1, 2, 3]);
  assert.deepEqual(episodesIn('Show.S01E01-E03.1080p', 1), [1, 2, 3]);
  assert.deepEqual(episodesIn('Show.Season.1.Episode.5.1080p', 1), [5]);
  assert.deepEqual(episodesIn('Show.S02E01.1080p', 1), []);
});

test('an empty known season never falls back to guessing episodes', async () => {
  let searches = 0;
  const id = startSeasonJob({ title: 'Empty Known Season', season: 1 }, {
    parseName, seasonEpisodes: async () => ({ episodes: [] }),
    searchTorrents: async () => { searches++; return { results: [] }; }, haveEpisodes: async () => new Set(),
  });
  const result = await wait(id);
  assert.equal(result.state, 'done'); assert.equal(result.total, 0); assert.equal(searches, 0);
});

test('season job deduplication and status are scoped to their requester', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const deps = { parseName, seasonEpisodes: async () => { await gate; return { episodes: [] }; } };
  const first = startSeasonJob({ title: 'House', season: 9, requester: 10 }, deps);
  const duplicate = startSeasonJob({ title: 'House MD', season: 9, requester: 10 }, deps);
  const other = startSeasonJob({ title: 'House', season: 9, requester: 11 }, deps);
  assert.equal(first, duplicate); assert.notEqual(first, other);
  assert.equal(seasonJob(first, { userId: 11 }), null);
  assert.ok(seasonJob(first, { userId: 10 })); assert.ok(seasonJob(first, { userId: 1, owner: true }));
  assert.equal('requester' in seasonJob(first), false);
  release(); await Promise.all([wait(first), wait(other)]);
});

test('a season catalogue outage is retryable instead of guessing an unknown episode list', async () => {
  let searches = 0;
  const id = startSeasonJob({ title: 'Catalogue Outage', season: 1 }, {
    seasonEpisodes: async () => { throw Error('Catalogue unavailable'); },
    searchTorrents: async () => { searches++; return { results: [] }; },
  });
  const result = await wait(id);
  assert.equal(result.state, 'failed'); assert.match(result.error, /unavailable/); assert.equal(searches, 0);
});
