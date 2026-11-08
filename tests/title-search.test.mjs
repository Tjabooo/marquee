import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCatalogueSearch, needsExactCatalogueFallback, mergeCatalogueResults } from '../src/title-search.js';

test('catalogue search parses a trailing year without breaking year-shaped titles', () => {
  assert.deepEqual(parseCatalogueSearch('9'), { raw: '9', title: '9', year: null });
  assert.deepEqual(parseCatalogueSearch('9 2009'), { raw: '9 2009', title: '9', year: 2009 });
  assert.deepEqual(parseCatalogueSearch('9 (2009)'), { raw: '9 (2009)', title: '9', year: 2009 });
  assert.deepEqual(parseCatalogueSearch('1917'), { raw: '1917', title: '1917', year: null });
});

test('short titles and explicit years get an exact-search fallback', () => {
  assert.equal(needsExactCatalogueFallback('9'), true);
  assert.equal(needsExactCatalogueFallback('It'), true);
  assert.equal(needsExactCatalogueFallback('Up (2009)'), true);
  assert.equal(needsExactCatalogueFallback('Matrix'), false);
});

test('the film 9 is promoted above noisy multi-search matches', () => {
  const multi = [
    { id: 17654, media_type: 'movie', title: 'District 9', release_date: '2009-08-14' },
    { id: 75219, media_type: 'tv', name: '9-1-1', first_air_date: '2018-01-03' },
  ];
  const movies = [
    { id: 22947, title: '9', original_title: '9', release_date: '2009-08-19' },
    { id: 99999, title: '9', release_date: '2019-01-01' },
  ];

  const plain = mergeCatalogueResults('9', [multi, movies]);
  assert.equal(plain[0].id, 22947);
  assert.equal(plain[0].media_type, 'movie');

  const dated = mergeCatalogueResults('9 (2009)', [multi, movies]);
  assert.equal(dated[0].id, 22947);
  assert.notEqual(dated[1]?.id, 99999);
});
