import test from 'node:test';
import assert from 'node:assert/strict';
import { bitmapCues } from '../src/subsync.js';
import { selectSubtitle } from '../src/subtitles.js';

test('bitmap subtitle pictures have usable display times even with indefinite duration', () => {
  const cues = bitmapCues([
    { pts_time: '1', start_display_time: 0, end_display_time: 4294967295, num_rects: 1 },
    { pts_time: '2', num_rects: 0 },
    { pts_time: '3', start_display_time: 100, end_display_time: 1400, num_rects: 1 },
  ], 0.1);
  assert.deepEqual(cues, [{ start: 0.9, end: 1.9 }, { start: 3, end: 4.300000000000001 }]);
  assert.deepEqual(bitmapCues([{ pts_time: '1', num_rects: 1, end_display_time: 4294967295 }]), [], 'Unclosed pictures must not last forever');
  assert.deepEqual(bitmapCues([{ pts_time: 'invalid', num_rects: 1 }]), []);
});

const upload = (id, release, extra = {}) => ({ attributes: { language: 'en', release, files: [{ file_id: id, file_name: release + '.srt' }], ...extra } });
const info = { season: 18, episode: 9 };
const file = 'South.Park.S18E09.1080p.BluRay.x265.RCVR.mp4';
test('release matching prefers BluRay to a popular TV cut and rejects a wrong episode', () => {
  const result = selectSubtitle([
    upload(1, 'South.Park.S18E09.HDTV', { download_count: 1000000 }),
    upload(2, 'South.Park.S18E09.BluRay.x265.RCVR'),
    upload(3, 'South.Park.S18E08.BluRay.x265.RCVR', { moviehash_match: true }),
    upload(4, 'South.Park.S18E09.BluRay', { feature_details: { season_number: 18, episode_number: 8 } }),
  ], file, info, 'en');
  assert.equal(result.entry.file_id, 2);
});
test('exact hash wins and season uploads choose the matching subtitle file', () => {
  const result = selectSubtitle([
    upload(1, 'South.Park.S18E09.BluRay'),
    upload(2, 'South.Park.Season.18', { moviehash_match: true, files: [
      { file_id: 20, file_name: 'South.Park.S18E08.srt' }, { file_id: 21, file_name: 'South.Park.S18E09.srt' },
    ] }),
  ], file, info, 'en');
  assert.equal(result.entry.file_id, 21);
  assert.equal(selectSubtitle([upload(1, 'South.Park.S18E08')], file, info, 'en'), null);
  assert.equal(selectSubtitle([upload(1, 'South.Park.S18E09', { language: 'sv' })], file, info, 'en'), null);
});

test('subtitle search uses the selected movie ID rather than an ambiguous title', async () => {
  const savedKey = process.env.OPENSUBTITLES_API_KEY;
  const savedFetch = globalThis.fetch;
  process.env.OPENSUBTITLES_API_KEY = 'test';
  const requested = [];
  globalThis.fetch = async (url) => { requested.push(new URL(url)); return { ok: true, status: 200, json: async () => ({ data: [], total_pages: 1 }) }; };
  try {
    const isolated = await import('../src/subtitles.js?identity-test');
    await isolated.languagesForTitle({ title: 'Verity', year: 2026, tmdbId: 1812260 });
    assert.equal(requested[0].searchParams.get('tmdb_id'), '1812260');
    assert.equal(requested[0].searchParams.has('query'), false);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey == null) delete process.env.OPENSUBTITLES_API_KEY; else process.env.OPENSUBTITLES_API_KEY = savedKey;
  }
});
