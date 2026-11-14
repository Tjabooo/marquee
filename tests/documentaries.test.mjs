// Documentary categories and the parts of SVT Play and Knaben that read other people's data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, HOME_ROWS, HOME_ROWS_EN, swedishContent, createDocumentaries, discoverParams, mergeResults } from '../src/documentaries.js';
import { parseCategory, parseSearch, parseTitle, parseVideo, pickVariant, vttToSrt, validPath, pageData } from '../src/svtplay.js';
import { safeName, targetFile, parseProgress, expectedSize } from '../src/svt-queue.js';
import { parseKnaben, plainQuery } from '../src/torrents.js';

const page = (...states) => `<html><script>
  window.URQL_DATA = ${JSON.stringify(Object.fromEntries(states.map((s, i) => [String(i), { hasNext: false, data: JSON.stringify(s) }])))};
  window.OTHER = {"x":1};</script></html>`;
const teaser = (name, kind, path, extra = {}) => ({
  __typename: 'Teaser', heading: name, subHeading: 'Om mord', byline: '',
  images: { wide: { id: '55', changed: 17, description: 'Svensk dokumentär från 2024.' } },
  item: { __typename: kind, urls: { svtplay: path } }, ...extra,
});
const selection = (name, items, extra = {}) => ({ __typename: 'Selection', id: name, name, items, ...extra });

test('category ids are unique and the home rows exist', () => {
  const ids = CATEGORIES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.length >= 30);
  for (const id of HOME_ROWS) assert.ok(ids.includes(id), id);
  for (const c of CATEGORIES) assert.ok(c.svt || c.queries?.length, c.id);
});

test('every TMDB query is about documentaries, or is the Swedish true crime keyword', () => {
  for (const c of CATEGORIES) {
    for (const q of c.queries || []) {
      for (const type of ['movie', 'tv']) {
        const params = q[type];
        assert.ok(params, `${c.id} ${type}`);
        assert.ok(/\b99\b/.test(params.with_genres || '') || params.with_keywords === '33722', c.id);
      }
    }
  }
});

test('the parameters: sorting, votes, adult content and dates', () => {
  const crime = CATEGORIES.find((c) => c.id === 'true-crime');
  const params = discoverParams(crime, crime.queries[0], 'tv', 'newest', 3, '2026-11-08');
  assert.equal(params.sort_by, 'first_air_date.desc');
  assert.equal(params['first_air_date.lte'], '2026-11-08');
  assert.equal(params.page, '3');
  assert.equal(params.include_adult, 'false');
  assert.equal(params['vote_count.gte'], '3');
  const swedish = CATEGORIES.find((c) => c.id === 'swedish-true-crime');
  const lively = discoverParams(swedish, swedish.queries[0], 'movie', 'popular', 1, '2026-11-08');
  assert.equal(lively['vote_count.gte'], undefined, 'few Swedish titles have votes');
  assert.equal(lively.with_origin_country, 'SE');
});

test('merged answers list each title once, in order, without blank cards', () => {
  const t = (id, popularity, poster = 'p') => ({ type: 'tv', id, popularity, poster });
  const merged = mergeResults([[t(1, 5), t(2, 9)], [t(2, 9), t(3, 7), t(4, 99, null)]], 'popular');
  assert.deepEqual(merged.map((x) => x.id), [2, 3, 1]);
});

test('a category merges its queries and home loads only the first rows', async () => {
  const asked = [];
  const docs = createDocumentaries({
    tmdb: async (endpoint, params) => { asked.push([endpoint, params]); return { results: [{ id: asked.length }], total_pages: 2 }; },
    mapTitle: (x, type) => ({ type, id: `${x.id}`, title: 'T', poster: 'p', popularity: 1, backdrop: 'b', overview: 'o' }),
    svtCategory: async () => ({ items: [{ type: 'svt', path: '/a', kind: 'series', title: 'A', backdrop: 'b', overview: 'o' }, { type: 'svt', path: '/video/x/b', kind: 'film', title: 'B' }] }),
    svtOn: () => true,
    translate: (s) => s,
    language: () => 'sv',
  });
  const crime = await docs.category('true-crime', { type: 'movie' });
  assert.equal(crime.results.length, 2);
  assert.equal(crime.totalPages, 2);
  assert.equal(asked.length, 2);
  assert.equal(await docs.category('nope'), null);
  const films = await docs.category('svt-true-crime', { type: 'movie' });
  assert.deepEqual(films.results.map((t) => t.title), ['B']);
  assert.deepEqual((await docs.category('svt-true-crime', { page: 2 })).results, []);
  asked.length = 0;
  const home = await docs.home();
  assert.deepEqual(home.rows.map((r) => r.id), HOME_ROWS);
  assert.equal(home.more.length + home.rows.length, CATEGORIES.length);
  assert.equal(home.categories.length, CATEGORIES.length);
  assert.ok(home.featured.length > 0);
  assert.ok(asked.length <= 12, 'the other categories wait until they scroll into view');
});

test('English: international rows first, Swedish-language rows last, no SVT in the billboard', async () => {
  const docs = createDocumentaries({
    tmdb: async () => ({ results: [{ id: 1 }], total_pages: 1 }),
    mapTitle: (x, type) => ({ type, id: `${x.id}`, title: 'T', poster: 'p', popularity: 1, backdrop: 'b', overview: 'o' }),
    svtCategory: async () => ({ items: [{ type: 'svt', path: '/a', kind: 'series', title: 'A', backdrop: 'b', overview: 'o' }] }),
    svtOn: () => true, translate: (s) => s, language: () => 'en',
  });
  const home = await docs.home();
  assert.deepEqual(home.rows.map((r) => r.id), HOME_ROWS_EN);
  assert.ok(home.featured.length > 0 && home.featured.every((t) => t.type !== 'svt'));
  const order = [...home.rows.map((r) => r.id), ...home.more.map((c) => c.id)];
  const firstSwedish = order.findIndex((id) => swedishContent(CATEGORIES.find((c) => c.id === id)));
  assert.ok(order.slice(firstSwedish).every((id) => swedishContent(CATEGORIES.find((c) => c.id === id))));
  assert.equal(home.categories[0].group, 'True crime');
});

test('SVT off: only TMDB categories remain', async () => {
  const docs = createDocumentaries({
    tmdb: async () => ({ results: [] }), mapTitle: (x) => x, svtCategory: async () => { throw new Error('asked'); }, svtOn: () => false, translate: (s) => s,
  });
  const home = await docs.home();
  assert.ok(home.categories.every((c) => c.source === 'tmdb'));
  assert.equal(await docs.category('svt-true-crime'), null);
});

test('SVT category pages: whole titles only, once each', () => {
  const html = page({ mainCategories: {} }, { categoryPage: { heading: 'True crime', modules: [
    { showcaseSelection: selection('A', [teaser('<em>Hövdingen</em>', 'TvSeries', '/hovdingen'), teaser('Klipp', 'Clip', '/klipp/abc/x')]) },
    { defaultSelection: selection('B', [teaser('Hövdingen', 'TvSeries', '/hovdingen'), teaser('Sista tagningen', 'Single', '/video/ja4EQ42/sista-tagningen'),
      teaser('Recap', 'Episode', '/video/ePBaXYG/recap/764-internets')]) },
  ] } });
  const { items, title } = parseCategory(html);
  assert.equal(title, 'True crime');
  assert.deepEqual(items.map((t) => [t.title, t.kind]), [['Hövdingen', 'series'], ['Sista tagningen', 'film']]);
  assert.equal(items[0].year, 2024);
  assert.match(items[0].wide, /svtstatic\.se\/image\/custom\/640\/55\/17/);
});

test('unreadable SVT pages are nothing, not a crash', () => {
  assert.equal(parseCategory('<html>'), null);
  assert.deepEqual(pageData('window.URQL_DATA = {"a":'), []);
  assert.equal(parseTitle('<html>', '/x'), null);
  assert.equal(parseSearch(page({ searchPage: {} })).length, 0);
});

test('SVT search results', () => {
  const html = page({ searchPage: { flat: { hits: [{ teaser: teaser('<em>Mord</em> i Venedig', 'Single', '/video/8opXobr/mord-i-venedig') }, { categoryTeaser: {}, teaser: null }] } } });
  assert.deepEqual(parseSearch(html).map((t) => t.title), ['Mord i Venedig']);
});

const episode = (heading, videoSvtId, sub = 'Sön 26 jul • 18 min') => ({
  heading, subHeading: sub, description: 'Del 1', images: { wide: { id: '1', changed: 2 } },
  item: { __typename: 'Episode', videoSvtId, urls: { svtplay: `/video/${videoSvtId}/x/y` } },
});

test('SVT series with numbered episodes', () => {
  const html = page({ detailsPageByPath: {
    description: 'Mord.', images: { wide: { id: '9', changed: 1 } }, categories: [{ id: 'true-crime' }],
    moreDetails: {}, item: { __typename: 'TvSeries', name: 'Kriminalarkivet: Flickmorden' },
    modules: [
      { id: 'season-0-x', defaultSelection: { __typename: 'Selection', selectionType: 'season', name: 'Avsnitt', itemsAdult: [episode('2. Lekplatsmordet', 'b'), episode('1. Mordet i Vita bergen', 'a', '1 tim 5 min')] } },
      { id: 'clips', defaultSelection: { __typename: 'Selection', selectionType: 'clips', name: 'Klipp', itemsAdult: [episode('x', 'c')] } },
      { id: 'upcoming', defaultSelection: { __typename: 'Selection', selectionType: 'upcoming', name: 'Kommande', itemsAdult: [episode('y', 'd')] } },
    ] } });
  const t = parseTitle(html, '/kriminalarkivet-flickmorden');
  assert.equal(t.kind, 'series');
  assert.deepEqual(t.genres, [99, 80]);
  assert.equal(t.seasons.length, 1);
  assert.equal(t.seasons[0].number, 1);
  assert.deepEqual(t.seasons[0].episodes.map((e) => [e.number, e.name, e.videoId, e.minutes]), [[1, 'Mordet i Vita bergen', 'a', 65], [2, 'Lekplatsmordet', 'b', 18]]);
});

test('SVT dated seasons count from the oldest, so new ones never renumber old', () => {
  const html = page({ detailsPageByPath: { description: '', images: {}, categories: [], moreDetails: {}, item: { __typename: 'TvSeries', name: 'Uppdrag granskning' }, modules: [
    { id: 'p1', defaultSelection: { selectionType: 'productionPeriod', name: '2026', itemsAdult: [episode('Nyast', 'n'), episode('Äldre', 'm')] } },
    { id: 'p2', defaultSelection: { selectionType: 'productionPeriod', name: '2025', itemsAdult: [episode('Förra året', 'o')] } },
  ] } });
  const t = parseTitle(html, '/uppdrag-granskning');
  assert.deepEqual(t.seasons.map((s) => [s.number, s.name, s.dated]), [[1, '2025', true], [2, '2026', true]]);
  assert.deepEqual(t.seasons[1].episodes.map((e) => [e.number, e.name]), [[1, 'Äldre'], [2, 'Nyast']]);
});

test('SVT film page', () => {
  const html = page({ detailsPageByPath: { description: 'Gift.', images: { wide: { id: '1', changed: 2 } }, categories: [], moreDetails: { productionYear: 2026 },
    smartStart: { videoSvtId: '85dbqDZ' }, item: { __typename: 'Single', name: 'Giftmordet', duration: 4758, svtId: 'KrJXRnw' }, modules: [] } });
  const t = parseTitle(html, '/video/KrJXRnw/giftmordet');
  assert.deepEqual([t.kind, t.videoId, t.minutes, t.year], ['film', '85dbqDZ', 79, 2026]);
});

test('only SVT title addresses are fetched', () => {
  for (const ok of ['/hovdingen', '/video/KrJXRnw/det-ryska', '/video/ePBaXYG/recap/764-internets']) assert.ok(validPath(ok), ok);
  for (const bad of ['//evil.com', '/../secret', '/a?b=1', 'https://evil.com', '/video/x/../../y', '', '/kategori/a/b', null]) assert.ok(!validPath(bad), String(bad));
});

test('a video: H.264 first, Swedish subtitles, and protected ones refused', () => {
  const refs = [{ format: 'dash', url: 'https://x/d' }, { format: 'hls', url: 'https://x/h.m3u8' }, { format: 'hls-cmaf-avc', url: 'https://x/a.m3u8' }, { format: 'hls-cmaf-full', url: 'https://x/f.m3u8' }];
  const subs = [{ label: 'Svenska (allt tal)', type: 'caption-sdh', format: 'webvtt', url: 'https://x/all.vtt' }, { label: 'Svenska', type: 'subtitle', format: 'webvtt', url: 'https://x/sv.vtt' }];
  const v = parseVideo({ videoReferences: refs, subtitleReferences: subs, contentDuration: 100, rights: { drmCopyProtection: false } });
  assert.deepEqual([v.format, v.url, v.subtitleUrl, v.refused], ['hls-cmaf-avc', 'https://x/a.m3u8', 'https://x/sv.vtt', null]);
  assert.equal(parseVideo({ videoReferences: refs, subtitleReferences: subs.slice(0, 1) }).subtitleUrl, 'https://x/all.vtt');
  assert.match(parseVideo({ videoReferences: refs, rights: { drmCopyProtection: true } }).refused, /copy protects/);
  assert.match(parseVideo({ videoReferences: refs, live: true }).refused, /live/);
  assert.match(parseVideo({ videoReferences: [{ format: 'dash', url: 'https://x/d' }] }).refused, /no playable/);
});

test('the stream: best picture up to 1080p, main sound, not the audio-described one', () => {
  const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Syntolkning",LANGUAGE="sv",CHARACTERISTICS="public.accessibility.describes-video",URI="ad.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Svenska",LANGUAGE="sv",DEFAULT=YES,URI="main.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="Svenska",URI="sub.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="aud",CODECS="avc1.64001f"
v720.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=2560x1440,AUDIO="aud",CODECS="avc1.640032"
v1440.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aud",CODECS="avc1.640028"
v1080.m3u8
`;
  const picked = pickVariant(master, 'https://cdn.example/a/master.m3u8');
  assert.equal(picked.videoUrl, 'https://cdn.example/a/v1080.m3u8');
  assert.equal(picked.audioUrl, 'https://cdn.example/a/main.m3u8');
  assert.equal(picked.height, 1080);
  assert.equal(pickVariant('#EXTM3U', 'https://x/'), null);
  assert.equal(pickVariant('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360\nmuxed.m3u8', 'https://x/').audioUrl, null);
});

test('WebVTT becomes SRT', () => {
  const vtt = `WEBVTT\n\nNOTE skip me\n\n1\n00:01.000 --> 00:02.500 line:90%\n<c.white>Hej &amp; hå</c>\n\n01:00:03.000 --> 01:00:04.000\nTvå\nrader\n\n00:09.000 --> 00:10.000\n\n`;
  assert.equal(vttToSrt(vtt), '1\n00:00:01,000 --> 00:00:02,500\nHej & hå\n\n2\n01:00:03,000 --> 01:00:04,000\nTvå\nrader\n');
});

test('saved files use names the library understands, safe on every system', () => {
  assert.equal(safeName('Kriminalarkivet: Flickmorden'), 'Kriminalarkivet - Flickmorden');
  assert.equal(safeName('Var är Odin?'), 'Var är Odin');
  assert.equal(safeName('../..\\evil'), '.. .. evil');
  assert.equal(safeName('...'), 'SVT Play');
  assert.equal(targetFile({ title: 'Hövdingen', kind: 'series', season: 1, episode: 3 }).replace(/\\/g, '/'), 'TV/Hövdingen/Season 01/Hövdingen - S01E03.mp4');
  assert.equal(targetFile({ title: 'Giftmordet', kind: 'film', year: 2026 }).replace(/\\/g, '/'), 'Movies/Giftmordet (2026)/Giftmordet (2026).mp4');
  assert.equal(targetFile({ title: 'Giftmordet', kind: 'film' }).replace(/\\/g, '/'), 'Movies/Giftmordet/Giftmordet.mp4');
});

test('ffmpeg progress lines', () => {
  assert.deepEqual(parseProgress('total_size=2048\nout_time_us=5000000\nprogress=continue\n'), { seconds: 5, bytes: 2048, end: false });
  assert.deepEqual(parseProgress('out_time_us=N/A\nprogress=end\n'), { seconds: null, bytes: null, end: true });
});

test('Knaben: video only, and a broken row is skipped', () => {
  const hash = 'A'.repeat(40);
  const rows = parseKnaben({ hits: [
    { title: 'Svenska Fall S15E02 SWEDiSH 1080p WEB h264-INGRID', hash, category: 'TV / HD', seeders: 12, liveSeeders: 9, peers: 3, bytes: 1000, date: '2026-01-02T00:00:00+00:00', magnetUrl: `magnet:?xt=urn:btih:${hash}&dn=x` },
    { title: 'Doc 2020', hash: 'b'.repeat(40), category: 'Movies / HD', seeders: 4, bytes: 5, magnetUrl: null },
    { title: 'Prince - Planet Earth (2007) FLAC', hash: 'c'.repeat(40), category: 'Audio / Lossless', seeders: 100 },
    { title: 'A book', hash: 'd'.repeat(40), category: 'Books / EBooks', seeders: 9 },
    { title: 'No hash', hash: '', category: 'TV' },
    null,
  ] });
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].source, rows[0].seeders, rows[0].quality, rows[0].size], ['knaben', 12, '1080p', 1000]);
  assert.match(rows[0].magnet, /^magnet:/);
  assert.match(rows[1].magnet, /^magnet:\?xt=urn:btih:b{40}/);
  assert.deepEqual(parseKnaben({}), []);
});

test('Swedish letters also search in the spelling release names use', () => {
  assert.equal(plainQuery('Mordet på Olof Palme'), 'Mordet pa Olof Palme');
  assert.equal(plainQuery('Hövdingen ä'), 'Hovdingen a');
  assert.equal(plainQuery('GW:s mord'), 'GW:s mord');
});

test('a copy always has a size to weigh progress with, better once under way', () => {
  assert.equal(expectedSize({ minutes: 10 }), 300e6);
  assert.equal(expectedSize({ size: 5, bytes: 0, progress: 0 }), 5);
  assert.ok(expectedSize({}) > 0, 'jobs queued before sizes were estimated');
  assert.equal(expectedSize({ bytes: 100e6, progress: 0.25, minutes: 10, size: 9 }), 400e6);
});
