// TMDB leaves many seasons undated although their episodes have dates: those must not read as "Not released".
import test from 'node:test';
import assert from 'node:assert/strict';
import { seasonUpcoming } from '../src/shows.js';

const TODAY = '2026-11-08';
const upcoming = (details, n) => seasonUpcoming(details, details.seasons.find((s) => s.season_number === n), TODAY);
const season = (season_number, air_date = null, episode_count = 10) => ({ season_number, air_date, episode_count });

test('undated seasons up to the last aired one are out (One Piece)', () => {
  const d = {
    last_episode_to_air: { season_number: 23 },
    seasons: [season(0, '1999-12-15'), season(1, '1999-10-20'), season(2), season(17), season(18, '2016-07-13'), season(22), season(23)],
  };
  for (const n of [1, 2, 17, 18, 22, 23]) assert.equal(upcoming(d, n), false, `season ${n}`);
});

test('a later dated season counts when TMDB gives no last episode', () => {
  const d = { seasons: [season(1), season(2, '2020-01-01'), season(3)] };
  assert.equal(upcoming(d, 1), false);
  assert.equal(upcoming(d, 3), true);
});

test('seasons that really have not started stay upcoming', () => {
  const d = { last_episode_to_air: { season_number: 2 }, seasons: [season(1, '2020-01-01'), season(2, '2022-01-01'), season(3, '2027-03-01'), season(4)] };
  assert.equal(upcoming(d, 2), false);
  assert.equal(upcoming(d, 3), true, 'dated in the future');
  assert.equal(upcoming(d, 4), true, 'undated, past the last aired season');
});

test('a dated future season does not pull undated ones forward, and empty placeholders stay upcoming', () => {
  const d = { last_episode_to_air: { season_number: 1 }, seasons: [season(1, '2020-01-01'), season(2), season(3, '2027-03-01'), season(4, null, 0)] };
  assert.equal(upcoming(d, 2), true);
  d.last_episode_to_air.season_number = 4;
  assert.equal(upcoming(d, 4), true, 'no episodes listed');
});

test('a show TMDB knows nothing more about stays upcoming when undated', () => {
  assert.equal(seasonUpcoming({}, season(1), TODAY), true);
});
