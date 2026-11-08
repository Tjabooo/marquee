import test from 'node:test';
import assert from 'node:assert/strict';
import { exactFirst } from '../src/release-match.js';
import { parseName } from '../src/release-name.js';

test('the film "9" comes before busier releases from 2009 with a 9 in the name', () => {
  const list = ['District.9.2009.1080p.BluRay', 'Star.Trek.2009.1080p', '9.2009.720p.BluRay.x264', 'Show.S01E09.2009.720p', '9 (2009) 1080p BrRip x264'].map((name) => ({ name }));
  assert.deepEqual(exactFirst('9 2009', list, parseName).map((r) => r.name).slice(0, 3),
    ['9.2009.720p.BluRay.x264', '9 (2009) 1080p BrRip x264', 'District.9.2009.1080p.BluRay']);
});
