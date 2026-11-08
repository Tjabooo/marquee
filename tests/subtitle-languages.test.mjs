import test from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENSUBTITLES_API_KEY = 'test-key';
process.env.SUB_LANGS = 'en,sv,ka,tl';
const { languagesForTitle } = await import('../src/subtitles.js');

// A catalogue like the real one: common languages fill every page, the rare one sits far behind them.
function catalogue(rows) {
  const asked = [];
  globalThis.fetch = async (url) => {
    const languages = new URL(url).searchParams.get('languages').split(',');
    asked.push(languages);
    const data = rows.filter((language) => languages.includes(language)).slice(0, 50).map((language) => ({ attributes: { language } }));
    return new Response(JSON.stringify({ data, total_pages: 8 }), { status: 200 });
  };
  return asked;
}
const codes = (r) => r.languages.map((l) => l.code);

test('a rare language behind pages of common ones is still listed', async () => {
  const asked = catalogue([...Array(400).fill('en'), ...Array(400).fill('sv'), 'tl']);
  assert.deepEqual(codes(await languagesForTitle({ title: 'Long list', tmdbId: 1 })), ['en', 'sv', 'tl']);
  assert.deepEqual(asked.at(-1), ['ka'], 'the last round asks only for what is still missing, then stops');
  assert.equal(asked.length, 4);
});

test('a language nobody has made stays out of the list', async () => {
  const asked = catalogue(Array(10).fill('en'));
  assert.deepEqual(codes(await languagesForTitle({ title: 'English only', tmdbId: 2 })), ['en']);
  assert.equal(asked.length, 2, 'a round that finds nothing new ends the search');
});
