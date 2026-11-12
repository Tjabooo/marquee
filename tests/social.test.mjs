import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as accounts from '../src/accounts.js';
import * as social from '../src/social.js';
import { WatchRooms } from '../src/watch.js';
import { topicFor } from '../src/live.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilin-social-'));
  accounts.initAccounts({ dataDir: dir, adminEmails: [], mediaDir: null });
  const make = (email, name) => accounts.updateMe(accounts.userFor({ headers: { 'cf-access-authenticated-user-email': email } }), { name });
  const anna = make('anna@example.test', 'Anna'), ben = make('ben@example.test', 'Ben'), cleo = make('cleo@example.test', 'Cleo');
  const nameOf = (id) => accounts.userById(id)?.name || 'Someone';
  return { dir, anna, ben, cleo, nameOf };
}

test('thumbs: people see who liked a title, dislikes stay private, clearing removes it', () => {
  const { anna, ben, cleo, nameOf } = setup();
  social.rate(anna.id, 'movie:603', 1, 'The Matrix');
  social.rate(ben.id, 'movie:603', 1, 'The Matrix');
  social.rate(cleo.id, 'movie:603', -1, 'The Matrix');
  const forCleo = social.ratingFor(cleo.id, 'movie:603', nameOf);
  assert.equal(forCleo.mine, -1);
  assert.deepEqual(forCleo.likedBy.toSorted(), ['Anna', 'Ben']);
  assert.equal(forCleo.likes, 2);
  const forAnna = social.ratingFor(anna.id, 'movie:603', nameOf);
  assert.deepEqual(forAnna.likedBy, ['Ben'], 'your own like is shown as yours, not in the list');
  social.rate(anna.id, 'movie:603', 0);
  assert.equal(social.ratingFor(anna.id, 'movie:603', nameOf).mine, 0);
  assert.deepEqual(social.ratingsFor(ben.id, ['movie:603', 'tv:1', 'junk']), { 'movie:603': { mine: 1, likes: 1 } });
  assert.throws(() => social.rate(anna.id, 'movie:abc', 1), { status: 400 });
  assert.throws(() => social.rate(anna.id, 'tv:1', 5), { status: 400 });
  assert.equal(topicFor('/api/social/rate').topic, 'social');
});

test('watch log credits real playback, capped by elapsed time, and survives finishing a video', () => {
  const { anna, ben, nameOf } = setup();
  const t0 = new Date('2026-03-02T20:00:00').getTime();
  const about = { titleKey: 'tv:1399', title: 'Game of Thrones', season: 1, episode: 1 };
  assert.equal(social.logWatch(anna.id, { ref: 'm:got/s01e01', about, watched: 10, now: t0 }), 10);
  // A save that claims far more than the time that passed is cut down to ~2x speed.
  assert.ok(social.logWatch(anna.id, { ref: 'm:got/s01e01', about, watched: 600, now: t0 + 15000 }) < 40);
  social.logWatch(anna.id, { ref: 'm:got/s01e01', about, watched: 15, finished: true, now: t0 + 30000 });
  accounts.saveProgress(anna.id, 'm:got/s01e01', null, 3600); // finished: the progress row goes away
  // Next day, together with Ben in a room.
  let now = t0 + 86400000;
  for (let i = 0; i < 8; i++, now += 60000) {
    social.logWatch(anna.id, { ref: 'm:got/s01e02', about: { ...about, episode: 2 }, watched: 60, companions: [ben.id], now });
    social.logWatch(ben.id, { ref: 'm:got/s01e02', about: { ...about, episode: 2 }, watched: 60, companions: [anna.id], now });
  }
  social.logWatch(anna.id, { ref: 'm:films/arrival', about: { titleKey: 'movie:329865', title: 'Arrival' }, watched: 30, now: t0 + 3 * 86400000 });
  assert.equal(social.logWatch(anna.id, { ref: 'bad', about, watched: 5 }), 0);
  assert.equal(social.logWatch(anna.id, { ref: 'm:x', about: {}, watched: 5 }), 0, 'needs a title');

  const w = social.wrapped(anna.id, 2026, nameOf);
  assert.equal(w.empty, undefined);
  assert.ok(w.seconds > 500 && w.seconds < 600, `seconds ${w.seconds}`);
  assert.equal(w.top[0].title, 'Game of Thrones');
  assert.equal(w.top[0].episodes, 2);
  assert.equal(w.topShow.title, 'Game of Thrones');
  assert.equal(w.episodes, 2);
  assert.equal(w.films, 1);
  assert.equal(w.first.title, 'Game of Thrones');
  assert.equal(w.streak.days, 2);
  assert.equal(w.activeDays, 3);
  assert.equal(w.busiestMonth, 'March');
  assert.equal(w.busiestDay.day, '2026-03-03');
  assert.deepEqual(w.company.map((c) => c.name), ['Ben']);
  assert.equal(w.together, 450); // the first save of a session counts at most 30 s
  assert.equal(w.people, 2);
  assert.equal(w.rank, 1);
  assert.deepEqual(w.years, [2026]);
  assert.equal(social.wrapped(anna.id, 2025, nameOf).empty, true);
  assert.throws(() => social.wrapped(anna.id, 'x', nameOf), { status: 400 });
});

test('Popular on Lilin ranks by likes, viewers and hours, filters by type and drops disliked titles', () => {
  const { anna, ben, cleo } = setup();
  const now = Date.now();
  social.rate(anna.id, 'movie:1', 1); social.rate(ben.id, 'movie:1', 1);
  social.rate(anna.id, 'tv:2', 1);
  social.rate(anna.id, 'movie:3', -1); social.rate(ben.id, 'movie:3', -1);
  for (const u of [anna, ben, cleo]) {
    for (let i = 0; i < 10; i++) social.logWatch(u.id, { ref: 'm:show/e1', about: { titleKey: 'tv:2', title: 'Show' }, watched: 60, now: now + i * 60000 });
  }
  social.logWatch(cleo.id, { ref: 'm:film/peek', about: { titleKey: 'movie:4', title: 'Peek' }, watched: 30, now });
  const list = social.popular({ now: now + 3600000 });
  assert.deepEqual(list.map((p) => p.key), ['tv:2', 'movie:1']);
  assert.equal(list[0].viewers, 3);
  assert.equal(list[1].likes, 2);
  assert.deepEqual(social.popular({ type: 'movie', now: now + 3600000 }).map((p) => p.key), ['movie:1']);
});

test('planned watch parties: countdown, auto start, creator hosts, survive a restart, cancel', () => {
  const { anna, ben } = setup();
  let now = Date.now();
  const clock = () => now;
  const rooms = new WatchRooms({ now: clock, store: social.partyStore });
  const media = { kind: 'lib', id: 'arrival', title: 'Arrival', mediaKey: 'films/arrival' };
  assert.throws(() => rooms.plan(anna, media, now - 1000), { status: 400 });
  assert.throws(() => rooms.plan(anna, media, now + 30 * 86400000), { status: 400 });
  const startsAt = now + 3600000;
  const planned = rooms.plan(anna, media, startsAt);
  assert.equal(planned.startsAt, startsAt);
  assert.equal(rooms.preview(planned.token).host, 'Anna');
  assert.equal(rooms.preview(planned.token).startsAt, startsAt);
  assert.equal(rooms.protects('films/arrival'), true, 'a planned party keeps its video');
  assert.equal(topicFor('/api/watch/plan').topic, 'parties');

  // Restart: the party comes back from the database with its people.
  now += 20 * 60000;
  const again = new WatchRooms({ now: clock, store: social.partyStore });
  const token = planned.token;
  again.join(token, ben, 'bobby-client-123456');
  again.cleanup();
  assert.equal(again.parties(ben)[0].token, token);
  assert.equal(again.parties(anna)[0].mine, true);
  // Ben arrived first, then Anna, who planned it, takes over as host before it starts.
  const s = again.join(token, anna, 'alice-client-123456');
  assert.equal(s.host, 'alice-client-123456');
  assert.equal(s.startsAt, startsAt);
  const ready = { ready: true, buffering: false, blocked: false, rtt: 50 };
  again.subscribe(token, anna, 'alice-client-123456', () => {});
  again.subscribe(token, ben, 'bobby-client-123456', () => {});
  again.heartbeat(token, anna, 'alice-client-123456', ready);
  again.heartbeat(token, ben, 'bobby-client-123456', ready);
  assert.equal(again.snapshot(again.room(token)).intentPlaying, false, 'waits for the start time');
  now = startsAt + 10;
  again.heartbeat(token, anna, 'alice-client-123456', ready);
  again.heartbeat(token, ben, 'bobby-client-123456', ready);
  again.cleanup();
  const started = again.snapshot(again.room(token));
  assert.equal(started.intentPlaying, true);
  assert.equal(started.startsAt, null);
  assert.deepEqual(again.companions(token, anna.id), [ben.id]);
  assert.throws(() => again.cancel(token, ben), { status: 403 });
  again.cancel(token, anna);
  assert.throws(() => again.room(token), { status: 410 });
  assert.equal(new WatchRooms({ now: clock, store: social.partyStore }).rooms.size, 0, 'cancelled parties are gone after a restart too');
});

test('room chat and reactions reach everyone, late joiners get recent chat, both are rate limited', () => {
  let now = 10000;
  const rooms = new WatchRooms({ now: () => now });
  const a = { id: 1, name: 'Alice' }, b = { id: 2, name: 'Bob' }, c = { id: 3, name: 'Cy' };
  const media = { kind: 'lib', id: 'movie', title: 'Movie', mediaKey: 'films/movie' };
  const { token } = rooms.create(a, media, 'alice-client-123456');
  rooms.join(token, b, 'bobby-client-123456');
  const bobSaw = [];
  rooms.subscribe(token, b, 'bobby-client-123456', (m) => bobSaw.push(m));
  const msg = rooms.chat(token, a, 'alice-client-123456', '  hello\n  there  ');
  assert.equal(msg.text, 'hello there');
  assert.equal(msg.name, 'Alice');
  assert.deepEqual(bobSaw.at(-1), { chat: msg });
  assert.equal(rooms.react(token, b, 'bobby-client-123456', '😂'), true);
  assert.throws(() => rooms.react(token, b, 'bobby-client-123456', '<script>'), { status: 400 });
  assert.throws(() => rooms.chat(token, b, 'bobby-client-123456', '   '), { status: 400 });
  assert.throws(() => rooms.chat(token, c, 'cyrus-client-123456', 'hi'), { status: 403 });
  for (let i = 0; i < 5; i++) rooms.chat(token, a, 'alice-client-123456', `m${i}`);
  assert.throws(() => rooms.chat(token, a, 'alice-client-123456', 'spam'), { status: 429 });
  now += 11000;
  rooms.chat(token, a, 'alice-client-123456', 'later');
  let dropped = 0;
  for (let i = 0; i < 20; i++) if (!rooms.react(token, a, 'alice-client-123456', '🔥')) dropped++;
  assert.ok(dropped >= 8);
  rooms.join(token, c, 'cyrus-client-123456');
  const cySaw = [];
  rooms.subscribe(token, c, 'cyrus-client-123456', (m) => cySaw.push(m));
  assert.equal(cySaw.at(-1).chatLog.length, 7);
  // Host-set countdown inside a running room; playing early starts it.
  const sched = rooms.schedule(token, a, 'alice-client-123456', now + 300000);
  assert.equal(sched.startsAt, now + 300000);
  assert.throws(() => rooms.schedule(token, b, 'bobby-client-123456', now + 300000), { status: 403 });
  const played = rooms.control(token, a, 'alice-client-123456', 'play', 0);
  assert.equal(played.startsAt, null);
});
