import test from 'node:test';
import assert from 'node:assert/strict';
import { WatchRooms } from '../watch.js';
import { WatchSession, playbackPlan, offsetCues } from '../public/watch-sync.js';
const a = { id: 1, name: 'Alice' }, b = { id: 2, name: 'Bob' };
const ac = 'alice-client-123456', bc = 'bobby-client-123456';
const media = { kind: 'lib', id: 'movie', title: 'Movie', mediaKey: 'films/movie' };
const ready = { ready: true, buffering: false, blocked: false, rtt: 100 };

test('rooms wait for everyone, schedule playback, pause for buffering and resume on the same clock', () => {
  let now = 10000; const rooms = new WatchRooms({ now: () => now });
  const initial = rooms.create(a, media, ac, 20); const token = initial.token;
  assert.equal(token.length, 24);
  rooms.join(token, b, bc);
  const seen = [];
  rooms.subscribe(token, a, ac, (s) => seen.push(s)); rooms.subscribe(token, b, bc, () => {});
  rooms.heartbeat(token, a, ac, ready);
  let state = rooms.control(token, a, ac, 'play', 20);
  assert.equal(state.playing, false); assert.deepEqual(state.waitingFor, ['Bob']);
  state = rooms.heartbeat(token, b, bc, ready);
  assert.equal(state.playing, true); assert.ok(state.at > now);
  now = state.at + 5000;
  assert.equal(playbackPlan(state, now, 25).target, 25);
  state = rooms.heartbeat(token, b, bc, { ...ready, buffering: true });
  assert.equal(state.playing, false); assert.equal(state.position, 25);
  now += 3000;
  state = rooms.heartbeat(token, b, bc, ready);
  assert.equal(state.position, 25); assert.ok(state.at > now); assert.equal(state.playing, true);
  assert.ok(seen.length >= 5, 'Changes are pushed immediately');
  assert.equal(rooms.protects('films/movie'), true);
  assert.throws(() => rooms.control(token, b, bc, 'pause', 25), { status: 403 });
  assert.throws(() => rooms.control(token, b, ac, 'pause', 25), { status: 403 });
  assert.throws(() => rooms.control(token, a, ac, 'seek', Infinity), { status: 400 });
  state = rooms.control(token, a, ac, 'seek', 60); assert.equal(state.position, 60);
  rooms.leave(token, a, ac);
  const handed = rooms.snapshot(rooms.room(token));
  assert.equal(handed.host, bc); assert.equal(handed.playing, false); assert.equal(handed.intentPlaying, false);
  rooms.leave(token, b, bc); assert.equal(rooms.protects('films/movie'), false);
});

test('disconnected members are removed and caption settings are never part of room state', () => {
  let now = 10000; const rooms = new WatchRooms({ now: () => now });
  const { token } = rooms.create(a, media, ac); rooms.join(token, b, bc);
  rooms.subscribe(token, a, ac, () => {}); rooms.subscribe(token, b, bc, () => {});
  const state = rooms.heartbeat(token, b, bc, { ...ready, subtitles: 'Swedish', subtitleOffset: 4 });
  assert.ok(!JSON.stringify(state).includes('Swedish')); assert.ok(!JSON.stringify(state).includes('subtitleOffset'));
  now += 21000; rooms.heartbeat(token, b, bc, ready); rooms.cleanup();
  assert.equal(rooms.room(token).members.size, 1); assert.equal(rooms.room(token).host, bc);
  rooms.leave(token, b, bc); now += 601000; rooms.cleanup();
  assert.throws(() => rooms.preview(token), { status: 410 });
});

test('playback compensation uses timestamps, not arrival delay, with bounded gentle rate correction', () => {
  const state = { position: 50, playing: true, at: 10000 };
  const future = playbackPlan(state, 9700, 50);
  assert.equal(future.playing, false); assert.equal(future.delay, 300);
  assert.equal(playbackPlan(state, 10600, 50.6).target, 50.6);
  assert.equal(playbackPlan(state, 10600, 50.6).rate, 1);
  const behind = playbackPlan(state, 10600, 50.3);
  assert.ok(behind.rate > 1 && behind.rate <= 1.04); assert.equal(behind.seek, false);
  assert.equal(playbackPlan(state, 15000, 50).seek, true);
  assert.equal(playbackPlan({ ...state, playing: false }, 15000, 50).target, 50);
});

test('clock samples prefer the lowest RTT and subtitle offsets only alter that viewer’s cues', () => {
  const session = new WatchSession({ video: {}, room: { serverNow: 1000 }, now: () => 0 });
  session.sample(100, 120, 1110); assert.equal(session.clockOffset, 1000);
  session.sample(200, 600, 1550); assert.equal(session.clockOffset, 1000);
  const local = { cues: [{ startTime: 10, endTime: 12 }] };
  const family = { cues: [{ startTime: 10, endTime: 12 }] };
  offsetCues(local, 2); assert.equal(local.cues[0].startTime, 12); assert.equal(family.cues[0].startTime, 10);
  offsetCues(local, 3); assert.equal(local.cues[0].startTime, 13, 'Offsets do not accumulate on already shifted times');
  offsetCues(local, 0); assert.equal(local.cues[0].startTime, 10);
});

test('autoplay denial blocks readiness; reconnecting after stale membership rejoins the room', async () => {
  const video = { paused: true, readyState: 4, currentTime: 0, duration: 100, playbackRate: 1, seeking: false,
    play: () => Promise.reject(Object.assign(Error('Tap first'), { name: 'NotAllowedError' })), pause() { this.paused = true; } };
  const room = { token: 'a'.repeat(24), host: ac, position: 0, at: 0, playing: true, revision: 1, serverNow: 1000, members: [] };
  const posts = [];
  let stale = false;
  const session = new WatchSession({ video, room, clientId: ac, now: () => 1000, onState: () => {}, onEnd: () => {}, onError: () => {},
    makeEvents: () => ({ close() {} }), request: async (url, opts) => {
      posts.push([url, opts && JSON.parse(opts.body)]);
      if (stale && url.endsWith('/heartbeat')) { stale = false; throw Object.assign(Error('Join first'), { status: 403 }); }
      return room;
    } });
  session.connected = true; session.blocked = false;
  session.sync(); await new Promise((r) => setImmediate(r));
  assert.equal(session.blocked, true);
  assert.ok(posts.some(([, body]) => body?.blocked === true));
  stale = true; await session.pulse();
  assert.ok(posts.some(([url]) => url.endsWith('/join')));
  assert.equal(session.connected, false, 'Waits for a fresh SSE connection after rejoining');
  session.close({ notify: false });
});

test('two simulated players stay aligned through start, pause, seek and a buffering stall', async () => {
  let serverTime = 100000;
  const rooms = new WatchRooms({ now: () => serverTime });
  const initial = rooms.create(a, media, ac, 15); rooms.join(initial.token, b, bc);
  const sessions = [];
  class Video extends EventTarget {
    constructor() { super(); this.time = 0; this.paused = true; this.seeking = false; this.readyState = 4; this.duration = 1000; this.playbackRate = 1; }
    get currentTime() { return this.time; }
    set currentTime(value) {
      this.time = value; this.seeking = true; this.dispatchEvent(new Event('seeking'));
      queueMicrotask(() => { this.seeking = false; this.dispatchEvent(new Event('seeked')); });
    }
    play() { this.paused = false; this.dispatchEvent(new Event('play')); this.dispatchEvent(new Event('playing')); return Promise.resolve(); }
    pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  }
  const settle = () => new Promise((r) => setImmediate(r));
  const make = (user, client, clockSkew) => {
    const video = new Video();
    const session = new WatchSession({ video, clientId: client, room: rooms.snapshot(rooms.room(initial.token)), now: () => serverTime + clockSkew,
      onState: () => {}, onEnd: () => {}, onError: (message) => { throw Error(message); },
      request: async (url, opts) => {
        if (url.endsWith('/clock')) return { serverNow: serverTime };
        const body = JSON.parse(opts.body);
        if (url.endsWith('/heartbeat')) return rooms.heartbeat(initial.token, user, client, body);
        if (url.endsWith('/control')) return rooms.control(initial.token, user, client, body.action, body.position);
        if (url.endsWith('/leave')) { rooms.leave(initial.token, user, client); return {}; }
      },
      makeEvents: () => {
        const events = {};
        let stop;
        events.close = () => stop?.();
        queueMicrotask(() => {
          stop = rooms.subscribe(initial.token, user, client, (state) => events.onmessage?.({ data: JSON.stringify(state) }));
          events.onopen?.();
        });
        return events;
      },
    });
    sessions.push(session); return session;
  };
  const host = make(a, ac, -5000), guest = make(b, bc, 27000);
  const tick = async (ms) => {
    for (let i = 0; i < ms; i += 100) {
      for (const session of sessions) if (!session.video.paused) session.video.time += 0.1 * session.video.playbackRate;
      serverTime += 100;
      for (const session of sessions) session.sync();
      await settle();
    }
  };
  try {
    await host.start(); await guest.start(); host.unlock(); guest.unlock(); await settle(); await settle();
    host.control('play', 15); await settle(); await tick(5000);
    assert.equal(host.video.paused, false); assert.equal(guest.video.paused, false);
    assert.ok(Math.abs(host.video.currentTime - guest.video.currentTime) < 0.1);
    host.control('pause'); await settle(); await tick(1000);
    assert.equal(host.video.paused, true); assert.equal(guest.video.paused, true);
    host.control('seek', 120); await settle(); await settle();
    assert.ok(Math.abs(guest.video.currentTime - 120) < 0.1);
    host.control('play', 120); await settle(); await tick(1000);
    guest.video.readyState = 2; guest.video.dispatchEvent(new Event('waiting')); await settle(); await settle();
    assert.equal(host.video.paused, true, 'Host waits for the remote buffer');
    guest.video.readyState = 4; guest.video.dispatchEvent(new Event('canplay')); await settle(); await tick(1000);
    assert.equal(host.video.paused, false); assert.equal(guest.video.paused, false);
    assert.ok(Math.abs(host.video.currentTime - guest.video.currentTime) < 0.1);
  } finally { sessions.forEach((s) => s.close({ notify: false })); }
});
