import test from 'node:test';
import assert from 'node:assert/strict';
import { bitmapCues, retime, shiftAt, solve } from '../src/subsync.js';
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

// ---------- alignment ----------
// Irregular, reproducible dialogue: 0.8–4 s lines with 0.2–3 s gaps.
function dialogue(minutes, seed = 3) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const cues = [];
  for (let t = 5; t < minutes * 60;) { const d = 0.8 + rnd() * 3.2; cues.push({ start: t, end: t + d }); t += d + 0.2 + rnd() * 2.8; }
  return cues;
}
const track = (cues) => {
  const v = new Float32Array(Math.ceil((cues.at(-1).end + 30) * 100));
  for (const c of cues) for (let i = Math.floor(c.start * 100); i < c.end * 100; i++) v[i] = 1;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return { step: 0.01, values: v.map((x) => x - mean) };
};
const placed = (r, cues) => cues.map((c) => c.start * r.ratio + shiftAt(r.sections, c.start));

test('a plain offset is found as a single part', () => {
  const truth = dialogue(20);
  const r = solve(truth.map((c) => ({ start: c.start - 22.8, end: c.end - 22.8 })), track(truth));
  assert.equal(r.confident, true);
  assert.equal(r.sections.length, 1);
  assert.equal(r.ratio, 1);
  assert.ok(Math.abs(r.offset - 22.8) < 0.02, `offset ${r.offset}`);
});

test('subtitles for a differently cut release are fixed in parts', () => {
  const truth = dialogue(24);
  const a = truth[Math.floor(truth.length * 0.3)].start;
  const b = truth[Math.floor(truth.length * 0.7)].start;
  // Ad breaks: 30 s extra after 30 %, 12 s less after 70 %.
  const shift = (t) => 2 + (t >= a ? 30 : 0) + (t >= b ? -12 : 0);
  const cues = truth.map((c) => ({ start: c.start + shift(c.start), end: c.end + shift(c.start) }));
  const r = solve(cues, track(truth));
  assert.equal(r.confident, true);
  assert.equal(r.sections.length, 3);
  const errors = placed(r, cues).map((t, i) => Math.abs(t - truth[i].start));
  assert.ok(errors.filter((e) => e < 0.1).length / errors.length > 0.98);
});

test('frame-rate drift is a ratio, not a staircase of parts', () => {
  const truth = dialogue(40);
  const k = 24 / (24000 / 1001);
  const cues = truth.map((c) => ({ start: c.start * k + 1, end: c.end * k + 1 }));
  const r = solve(cues, track(truth));
  assert.equal(r.confident, true);
  assert.equal(r.sections.length, 1);
  assert.ok(Math.abs(r.ratio - 1 / k) < 1e-9);
});

test('an unrelated subtitle is not trusted', () => {
  const r = solve(dialogue(20, 11), track(dialogue(20, 5)));
  assert.equal(r.confident, false);
});

test('retime moves each line by the shift of its part', () => {
  const srt = '1\n00:00:10,000 --> 00:00:12,000\nA\n\n2\n00:01:00,000 --> 00:01:02,500\nB\n';
  const out = retime(srt, 1, 0, [{ from: 0, offset: 1.5 }, { from: 60, offset: -20 }]);
  assert.match(out, /00:00:11,500 --> 00:00:13,500\nA/);
  assert.match(out, /00:00:40,000 --> 00:00:42,500\nB/);
});
