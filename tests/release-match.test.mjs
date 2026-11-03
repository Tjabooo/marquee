import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesRelease } from '../release-match.js';

// Mirrors the server's release-name structure; independent from torrent provider/network.
function parseName(name) {
  const text = name.replace(/[._]+/g, ' ');
  const ep = /\bS(\d{1,2})\s?E(\d{1,3})\b/i.exec(text);
  const season = /\bS(\d{1,2})\b/i.exec(text);
  const quality = /\b(?:1080p|720p|2160p|WEBRip|BluRay|x264)\b/i.exec(text);
  const cut = Math.min(...[ep?.index, season?.index, quality?.index, text.length].filter((n) => n != null));
  return { title: text.slice(0, cut).trim(), season: ep ? Number(ep[1]) : season ? Number(season[1]) : null,
    episode: ep ? Number(ep[2]) : null };
}

test('House M.D. search excludes House of the Dragon and unrelated titles', () => {
  assert.equal(matchesRelease('House M.D.', 'House.of.the.Dragon.S01E01.1080p.WEBRip', parseName), false);
  assert.equal(matchesRelease('House M.D.', 'House.MD.S01E01.1080p.WEBRip', parseName), true);
  assert.equal(matchesRelease('House M.D.', 'House.M.D.S02E05.720p', parseName), true);
});

test('specific season and episode searches exclude other episodes', () => {
  assert.equal(matchesRelease('South Park S18', 'South.Park.S18.1080p.BluRay', parseName), true);
  assert.equal(matchesRelease('South Park S18', 'South.Park.Season.18.Complete.1080p', parseName), true);
  assert.equal(matchesRelease('South Park S18', 'South.Park.S17E04.1080p', parseName), false);
  assert.equal(matchesRelease('South Park S18E03', 'South.Park.S18E03.1080p', parseName), true);
  assert.equal(matchesRelease('South Park S18E03', 'South.Park.S18E04.1080p', parseName), false);
});
