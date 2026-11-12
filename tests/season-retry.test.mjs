// Episode-by-episode recovery inside the unified Download job (smart-download.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startSmartJob, smartJob } from '../src/smart-download.js';
import { episodesIn } from '../src/season.js';

const parseName = (name) => {
  const match = /^(.*?)\.S(\d{2})E(\d{2})/i.exec(name);
  return { title: match?.[1] || '', season: Number(match?.[2]), episode: Number(match?.[3]) };
};
const row = (ep) => ({ name: `House.S02E${String(ep).padStart(2, '0')}.1080p.WEB`, seeders: 12, quality: '1080p', magnet: `magnet:${ep}` });
const wait = async (id) => {
  for (let i = 0; i < 400 && smartJob(id).state === 'running'; i++) await new Promise((r) => setTimeout(r, 5));
  return smartJob(id);
};
const episodes = (list) => async () => ({ episodes: list.map((episode) => ({ episode, aired: true })) });
const tv = (title, season, extra = {}) => ({ type: 'tv', title, season, want: {}, ...extra });
const unavailable = (job) => job.unavailable.map((u) => u.episode);

test('episode search retries the broad category for episodes missing from TV', async () => {
  const searches = [], added = [];
  const id = startSmartJob(tv('House', 2, { episodes: [1, 5, 23] }), {
    parseName, seasonEpisodes: episodes([1, 5, 23]), haveEpisodes: async () => new Set(),
    searchTorrents: async (query, type) => {
      searches.push([query, type]);
      const ep = Number(/E(\d+)/.exec(query)?.[1]);
      return { results: type === 'all' && ep ? [row(ep)] : [] };
    },
    addDownload: async ({ link }) => added.push(link),
  });
  const result = await wait(id);
  assert.equal(result.state, 'done');
  assert.deepEqual(unavailable(result), []);
  assert.equal(added.length, 3);
  assert.equal(searches.filter(([, type]) => type === 'all').length, 3);
});

test('a rejected episode download is reported and does not stop later episodes', async () => {
  const added = [];
  const id = startSmartJob(tv('House', 3), {
    parseName, seasonEpisodes: episodes([1, 2]), haveEpisodes: async () => new Set(),
    searchTorrents: async (query) => {
      const ep = /E(\d+)/.exec(query)?.[1];
      return { results: ep ? [{ ...row(Number(ep)), name: query.replace(/ /g, '.') + '.1080p.WEB', magnet: `magnet:rejected-${ep}` }] : [] };
    },
    addDownload: async ({ link }) => { if (link === 'magnet:rejected-01') throw Error('Download rejected'); added.push(link); },
  });
  const result = await wait(id);
  assert.equal(result.state, 'done'); assert.equal(result.outcome, 'partial');
  assert.deepEqual(unavailable(result), [1]);
  assert.match(result.unavailable[0].reason, /rejected/);
  assert.deepEqual(added, ['magnet:rejected-02']);
  assert.match(result.message, /1 episode on the way · 1 not found yet \(E01\)/);
});

test('House aliases and alternate episode numbering are accepted without matching other House shows', async () => {
  const added = [], queries = [];
  const id = startSmartJob(tv('House', 2), {
    parseName: (name) => {
      const m = /^(.*?)\.(?:S\d{2}E\d{2}|\d+x\d+)/i.exec(name);
      return { title: m?.[1]?.replaceAll('.', ' ') || '' };
    },
    seasonEpisodes: episodes([1, 5, 23]), haveEpisodes: async () => new Set([5]),
    searchTorrents: async (query, type) => {
      queries.push([query, type]);
      if (query === 'House MD S02E01') return { results: [
        { ...row(1), name: 'House.of.the.Dragon.S02E01.1080p.WEB' },
        { ...row(1), name: 'House.MD.S02E01.1080p.WEB' },
      ] };
      if (query === 'House MD 2x23') return { results: [{ ...row(23), name: 'House.MD.2x23.1080p.WEB' }] };
      return { results: [] };
    },
    addDownload: async ({ name }) => added.push(name),
  });
  const result = await wait(id);
  assert.equal(result.state, 'done');
  assert.deepEqual(result.have, [5]);
  assert.deepEqual(unavailable(result), []);
  assert.equal(added.length, 2);
  assert.ok(added.every((name) => name.startsWith('House.MD.')));
  assert.ok(queries.every(([query]) => !/E05|2x05/.test(query)), 'already-present episodes are never searched');
});

test('a partly present season skips existing and queued episodes before searching', async () => {
  const searched = [], added = [];
  const have = new Set([1, 3]); have.queued = new Set([3]);
  const id = startSmartJob(tv('Some Show', 4), {
    parseName, seasonEpisodes: episodes([1, 2, 3, 4]), haveEpisodes: async () => have,
    searchTorrents: async (query) => {
      searched.push(query);
      const ep = Number(/E(\d+)/.exec(query)?.[1] || /x(\d+)/.exec(query)?.[1]);
      return { results: ep ? [{ ...row(ep), name: `Some.Show.S04E${String(ep).padStart(2, '0')}.1080p.WEB` }] : [] };
    },
    addDownload: async ({ name }) => added.push(name),
  });
  const result = await wait(id);
  assert.deepEqual(result.have, [1]); assert.deepEqual(result.queued, [3]);
  assert.deepEqual(added.map((name) => Number(/E(\d+)/.exec(name)[1])), [2, 4]);
  assert.ok(searched.every((query) => !/E01|E03|4x01|4x03/.test(query)));
  assert.ok(searched.every((query) => /E\d|x\d/.test(query)), 'two missing episodes are fetched one by one, without a pack');
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
  const id = startSmartJob(tv('Empty Known Season', 1), {
    parseName, seasonEpisodes: async () => ({ episodes: [] }),
    searchTorrents: async () => { searches++; return { results: [] }; }, haveEpisodes: async () => new Set(),
  });
  const result = await wait(id);
  assert.equal(result.state, 'done'); assert.equal(result.outcome, 'none'); assert.equal(searches, 0);
});

test('job deduplication and status are scoped to their requester', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const deps = { parseName, seasonEpisodes: async () => { await gate; return { episodes: [] }; } };
  const first = startSmartJob(tv('House', 9, { requester: 10 }), deps);
  const duplicate = startSmartJob(tv('House MD', 9, { requester: 10 }), deps);
  const other = startSmartJob(tv('House', 9, { requester: 11 }), deps);
  assert.equal(first, duplicate); assert.notEqual(first, other);
  assert.equal(smartJob(first, { userId: 11 }), null);
  assert.ok(smartJob(first, { userId: 10 })); assert.ok(smartJob(first, { userId: 1, owner: true }));
  assert.equal('requester' in smartJob(first), false);
  release(); await Promise.all([wait(first), wait(other)]);
});

test('a season catalogue outage is retryable instead of guessing an unknown episode list', async () => {
  let searches = 0;
  const id = startSmartJob(tv('Catalogue Outage', 1), {
    seasonEpisodes: async () => { throw Error('Catalogue unavailable'); },
    searchTorrents: async () => { searches++; return { results: [] }; },
  });
  const result = await wait(id);
  assert.equal(result.state, 'failed'); assert.match(result.error, /unavailable/); assert.equal(searches, 0);
});

test('a failed search is retried once, then reported without blocking other episodes', async () => {
  const calls = new Map(), added = [];
  const id = startSmartJob(tv('Flaky Show', 1, { episodes: [1, 2] }), {
    parseName, seasonEpisodes: episodes([1, 2]), haveEpisodes: async () => new Set(), sleep: async () => {},
    searchTorrents: async (query, type) => {
      const key = `${query}|${type}`; calls.set(key, (calls.get(key) || 0) + 1);
      if (query === 'Flaky Show S01E01' && type === 'tv' && calls.get(key) === 1) throw Error('timeout');
      if (query === 'Flaky Show S01E01') return { results: [{ ...row(1), name: 'Flaky.Show.S01E01.1080p.WEB' }] };
      return { results: [] };
    },
    addDownload: async ({ name }) => added.push(name),
  });
  const result = await wait(id);
  assert.deepEqual(added, ['Flaky.Show.S01E01.1080p.WEB']);
  assert.equal(calls.get('Flaky Show S01E01|tv'), 2, 'retried once');
  assert.deepEqual(unavailable(result), [2]);
  assert.equal(result.outcome, 'partial');
});
