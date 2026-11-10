// Shared playback is a clock, not a relayed video stream. Every viewer fetches the same media,
// while small SSE messages carry an authoritative timeline. Captions never enter room state.
// The same stream carries the room's chat and emoji reactions; a room can also be given a start
// time (a planned party): everyone sees a countdown, and playback starts by itself when it's due.
import crypto from 'node:crypto';

const fail = (status, message) => Object.assign(new Error(message), { status });
const CLIENT = /^[A-Za-z0-9_-]{16,80}$/;
const STALE = 20000;
const MIN = 60000;
export const REACTIONS = ['😂', '😮', '😍', '😢', '😱', '👏', '🔥', '👍'];
const CHAT_KEEP = 50;

// store (optional): { save(room), remove(token), load() } keeps planned parties across restarts.
// avatarOf (optional): account id -> picture URL, for a planned party's host before they arrive.
export class WatchRooms {
  constructor({ now = Date.now, store = null, avatarOf = () => null } = {}) {
    this.now = now; this.rooms = new Map(); this.store = null; this.avatarOf = avatarOf;
    if (store) this.attachStore(store);
  }

  attachStore(store) {
    this.store = store;
    for (const saved of store.load() || []) this.restore(saved);
  }

  restore({ token, creator, media, startsAt, people = [], created, creatorName = '', position = 0 }) {
    if (!/^[A-Za-z0-9_-]{24}$/.test(String(token)) || !media || !Number.isFinite(startsAt)) return;
    if (this.now() > startsAt + 12 * 3600000) { this.store?.remove(token); return; }
    this.rooms.set(token, this.blank({ token, creator, creatorName, media, position, startsAt, created, people }));
  }

  blank({ token, creator, creatorName, media, position = 0, startsAt = null, created = this.now(), people = [] }) {
    return { token, creator, creatorName: String(creatorName || '').slice(0, 80), media, members: new Map(), host: null,
      position, playing: false, wantPlay: false, at: this.now(), created, touched: this.now(), revision: 0,
      startsAt, started: false, people: new Set(people), chat: [], chatSeq: 0, download: null };
  }

  persist(room) {
    if (!this.store) return;
    try { if (room.startsAt != null) this.store.save(room); else this.store.remove(room.token); } catch { /* the room still works without a saved copy */ }
  }

  room(token) {
    const room = this.rooms.get(token);
    if (!room) throw fail(410, 'This watch room has ended. Ask someone to start a new one.');
    return room;
  }

  member(room, user, client) {
    const member = room.members.get(client);
    if (!member || member.userId !== user.id) throw fail(403, 'Join this watch room first.');
    return member;
  }

  create(user, media, client, position = 0) {
    this.cleanup();
    if (this.rooms.size >= 100 || [...this.rooms.values()].filter((r) => r.creator === user.id && r.members.size).length >= 3) throw fail(429, 'Too many watch rooms are open. Leave one first.');
    const room = this.blank({ token: crypto.randomBytes(18).toString('base64url'), creator: user.id, creatorName: user.name,
      media, position: this.position(position) });
    room.host = client;
    this.rooms.set(room.token, room);
    try { this.join(room.token, user, client); } catch (e) { this.rooms.delete(room.token); throw e; }
    return this.snapshot(room);
  }

  // A party planned ahead: nobody is in it yet, the link works right away, and playback starts at
  // startsAt for whoever has joined by then.
  plan(user, media, startsAt) {
    this.cleanup();
    if (this.rooms.size >= 100 || [...this.rooms.values()].filter((r) => r.creator === user.id && r.startsAt != null && !r.started).length >= 10) {
      throw fail(429, 'You have too many watch parties planned. Cancel one first.');
    }
    const when = this.startTime(startsAt);
    const room = this.blank({ token: crypto.randomBytes(18).toString('base64url'), creator: user.id, creatorName: user.name,
      media, startsAt: when, people: [user.id] });
    this.rooms.set(room.token, room);
    this.persist(room);
    return this.snapshot(room);
  }

  startTime(value) {
    const when = Math.round(Number(value));
    if (!Number.isFinite(when) || when < this.now() + 30000) throw fail(400, 'Pick a start time in the future.');
    if (when > this.now() + 14 * 24 * 3600000) throw fail(400, 'Plan watch parties up to two weeks ahead.');
    return when;
  }

  // The host sets (or with null clears) a start time for the room they're in.
  schedule(token, user, client, startsAt) {
    const room = this.room(token);
    this.member(room, user, client);
    if (room.host !== client) throw fail(403, 'Only the host can set a start time.');
    if (startsAt == null) { room.startsAt = null; room.started = false; }
    else {
      room.startsAt = this.startTime(startsAt); room.started = false;
      room.position = this.current(room); room.at = this.now(); room.playing = false; room.wantPlay = false;
    }
    this.persist(room);
    this.changed(room);
    return this.snapshot(room);
  }

  // Planned parties this person made or has joined, soonest first.
  parties(user) {
    return [...this.rooms.values()]
      .filter((r) => r.startsAt != null && (r.creator === user.id || r.people.has(user.id)) && this.now() < r.startsAt + 3 * 3600000)
      .sort((a, b) => a.startsAt - b.startsAt)
      .map((r) => ({ token: r.token, startsAt: r.startsAt, started: r.started, mine: r.creator === user.id,
        host: r.members.get(r.host)?.name || r.creatorName || 'Family', hostAvatar: this.hostAvatar(r), viewers: r.members.size,
        faces: this.faces(r),
        media: { kind: r.media.kind, id: r.media.id, title: r.media.title, season: r.media.season ?? null, episode: r.media.episode ?? null } }));
  }

  hostAvatar(room) { return room.members.get(room.host)?.avatar ?? this.avatarOf(room.creator) ?? null; }
  // Who's in the room, one face per account (a person on two devices shows once).
  faces(room) {
    const seen = new Map();
    for (const m of room.members.values()) if (!seen.has(m.userId)) seen.set(m.userId, { name: m.name, avatar: m.avatar || null });
    return [...seen.values()].slice(0, 8);
  }

  cancel(token, user) {
    const room = this.room(token);
    if (room.creator !== user.id) throw fail(403, 'Only whoever planned this party can cancel it.');
    this.end(room);
  }

  end(room) {
    for (const m of room.members.values()) for (const send of m.streams) send({ ended: true });
    this.rooms.delete(room.token);
    try { this.store?.remove(room.token); } catch { /* already gone */ }
  }

  position(value) {
    if (!Number.isFinite(value) || value < 0 || value > 86400) throw fail(400, 'Invalid playback position.');
    return value;
  }

  current(room) { return room.position + (room.playing ? Math.max(0, this.now() - room.at) / 1000 : 0); }

  join(token, user, client) {
    const room = this.room(token);
    if (!CLIENT.test(String(client))) throw fail(400, 'Invalid viewer identifier.');
    const existing = room.members.get(client);
    if (existing && existing.userId !== user.id) throw fail(403, 'This viewer belongs to a different account.');
    if (!existing && room.members.size >= 12) throw fail(409, 'This room is full (12 viewers).');
    if (!existing) room.members.set(client, { id: client, userId: user.id, name: String(user.name || 'Viewer').slice(0, 80), avatar: user.avatar || null,
      ready: false, buffering: false, blocked: false, rtt: 0, seen: this.now(), streams: new Set() });
    room.members.get(client).seen = this.now();
    room.members.get(client).name = String(user.name || 'Viewer').slice(0, 80);
    room.members.get(client).avatar = user.avatar || null;
    // Whoever planned a party hosts it once they arrive, unless it's already under way.
    if (!room.members.has(room.host) || (user.id === room.creator && !room.started && room.members.get(room.host)?.userId !== user.id)) room.host = client;
    if (!room.people.has(user.id)) { room.people.add(user.id); this.persist(room); }
    this.changed(room);
    return this.snapshot(room);
  }

  blockers(room) { return [...room.members.values()].filter((m) => !m.streams.size || !m.ready || m.buffering || m.blocked); }

  // A video that is still downloading holds the room until the download is far enough ahead (server.js
  // decides, see roomGate in partial-stream.js), so nobody's player runs out mid-scene.
  downloadHolds(room) { return Boolean(room.download?.holding); }

  reconcile(room) {
    const canPlay = room.wantPlay && room.members.size > 0 && !this.blockers(room).length && !this.downloadHolds(room);
    if (room.playing && !canPlay) { room.position = this.current(room); room.playing = false; room.at = this.now(); }
    else if (!room.playing && canPlay) {
      const rtt = Math.max(0, ...[...room.members.values()].map((m) => m.rtt));
      room.at = this.now() + Math.min(1500, Math.max(350, rtt * 1.5 + 150));
      room.playing = true;
    }
  }

  changed(room) {
    this.reconcile(room);
    room.revision++;
    room.touched = this.now();
    const snapshot = this.snapshot(room);
    for (const m of room.members.values()) for (const send of m.streams) send(snapshot);
  }

  snapshot(room) {
    return { token: room.token, media: room.media, host: room.host, revision: room.revision, serverNow: this.now(),
      position: room.position, at: room.at, playing: room.playing, intentPlaying: room.wantPlay,
      startsAt: room.started ? null : room.startsAt,
      waitingFor: room.wantPlay ? this.blockers(room).map((m) => m.name) : [],
      waitingForDownload: Boolean(room.wantPlay && this.downloadHolds(room)),
      download: room.download ? { ...room.download } : null,
      members: [...room.members.values()].map((m) => ({ id: m.id, name: m.name, avatar: m.avatar || null, ready: m.ready,
        connected: m.streams.size > 0, buffering: m.buffering, blocked: m.blocked })) };
  }

  preview(token) {
    const room = this.room(token);
    return { media: room.media, host: room.members.get(room.host)?.name || room.creatorName || 'Family', hostAvatar: this.hostAvatar(room),
      viewers: room.members.size, faces: this.faces(room), startsAt: room.started ? null : room.startsAt };
  }

  subscribe(token, user, client, send) {
    const room = this.room(token);
    const member = this.member(room, user, client);
    member.streams.add(send); member.seen = this.now();
    this.changed(room);
    if (room.chat.length) send({ chatLog: room.chat });
    return () => {
      member.streams.delete(send);
      if (this.rooms.has(token) && room.members.has(client)) this.changed(room);
    };
  }

  heartbeat(token, user, client, status) {
    const room = this.room(token);
    const member = this.member(room, user, client);
    member.seen = this.now(); room.touched = this.now();
    const next = { name: String(user.name || 'Viewer').slice(0, 80), avatar: user.avatar || null, ready: status.ready === true, buffering: status.buffering === true, blocked: status.blocked === true };
    const changed = Object.keys(next).some((k) => member[k] !== next[k]);
    Object.assign(member, next);
    if (Number.isFinite(status.rtt)) member.rtt = Math.max(0, Math.min(2000, status.rtt));
    if (changed) this.changed(room);
    return this.snapshot(room);
  }

  control(token, user, client, action, position) {
    const room = this.room(token);
    this.member(room, user, client);
    if (room.host !== client) throw fail(403, 'The host controls play, pause and seeking. Your subtitles and volume are private.');
    if (!['play', 'pause', 'seek'].includes(action)) throw fail(400, 'Unknown playback action.');
    const next = this.position(position);
    room.position = next; room.at = this.now(); room.playing = false;
    if (action !== 'seek') room.wantPlay = action === 'play';
    if (action === 'play' && room.startsAt != null && !room.started) { room.started = true; this.persist(room); } // the host started early
    this.changed(room);
    return this.snapshot(room);
  }

  // The download behind a Play now room: { holding, wait (s, null if unknown), progress, done }. Only a
  // change of holding (or a big change of the estimate) is sent to everyone.
  setDownload(token, info) {
    const room = this.rooms.get(token);
    if (!room) return;
    const next = { holding: Boolean(info.holding), wait: Number.isFinite(info.wait) ? Math.round(info.wait) : null,
      progress: Math.max(0, Math.min(1, Number(info.progress) || 0)), done: Boolean(info.done) };
    const was = room.download;
    room.download = next;
    const moved = !was || was.holding !== next.holding || was.done !== next.done || (next.holding && (was.wait == null) !== (next.wait == null))
      || (next.holding && next.wait != null && Math.abs(next.wait - was.wait) >= Math.max(10, was.wait * 0.2));
    if (moved) this.changed(room);
  }

  // The room's video changes for everyone: a finished download swaps Play now for the full-quality file. The
  // room stays where it was; everyone's player reloads, and the room waits until they're all ready again.
  // `by` = { user, client } for the host's choice; the server leaves it out when the download is gone.
  switchMedia(token, media, by = null) {
    const room = this.room(token);
    if (by) {
      this.member(room, by.user, by.client);
      if (room.host !== by.client) throw fail(403, 'Only the host can switch the room to full quality.');
    }
    room.position = this.current(room); room.at = this.now(); room.playing = false;
    room.media = media; room.download = null;
    this.changed(room);
    return this.snapshot(room);
  }

  roomsWith(kind) { return [...this.rooms.values()].filter((r) => r.media?.kind === kind); }

  // Chat and reactions go to everyone's stream as they happen; the last 50 messages are kept for
  // people who join later. Nothing is stored after the room ends.
  allow(member, kind, max, windowMs) {
    const times = (member[kind] ||= []).filter((t) => this.now() - t < windowMs);
    member[kind] = times;
    if (times.length >= max) return false;
    times.push(this.now());
    return true;
  }

  broadcast(room, message) { for (const m of room.members.values()) for (const send of m.streams) send(message); }

  chat(token, user, client, text) {
    const room = this.room(token);
    const member = this.member(room, user, client);
    const body = String(text ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!body) throw fail(400, 'Write a message first.');
    if (!this.allow(member, 'chatTimes', 6, 10000)) throw fail(429, 'Slow down a little: too many messages.');
    const message = { id: ++room.chatSeq, from: client, name: member.name, avatar: member.avatar || null, text: body, at: this.now() };
    room.chat.push(message);
    if (room.chat.length > CHAT_KEEP) room.chat.splice(0, room.chat.length - CHAT_KEEP);
    room.touched = this.now();
    this.broadcast(room, { chat: message });
    return message;
  }

  react(token, user, client, emoji) {
    const room = this.room(token);
    const member = this.member(room, user, client);
    if (!REACTIONS.includes(emoji)) throw fail(400, 'Unknown reaction.');
    if (!this.allow(member, 'reactTimes', 12, 5000)) return false; // dropped quietly: it's only confetti
    this.broadcast(room, { reaction: { emoji, from: client, name: member.name, avatar: member.avatar || null, at: this.now() } });
    return true;
  }

  // People who watched together right now, by account (for Wrapped's "watched with").
  companions(token, userId) {
    const room = this.rooms.get(token);
    if (!room || ![...room.members.values()].some((m) => m.userId === userId)) return [];
    return [...new Set([...room.members.values()].filter((m) => m.streams.size && m.userId !== userId).map((m) => m.userId))];
  }

  leave(token, user, client) {
    const room = this.room(token);
    const member = this.member(room, user, client);
    for (const send of member.streams) send({ left: true });
    room.members.delete(client);
    if (room.host === client) {
      room.position = this.current(room); room.playing = false; room.wantPlay = false;
      room.host = [...room.members.values()].find((m) => m.streams.size)?.id || room.members.keys().next().value || null;
    }
    this.changed(room);
  }

  cleanup() {
    for (const [token, room] of this.rooms) {
      for (const m of [...room.members.values()]) if (this.now() - m.seen > STALE) this.leave(token, { id: m.userId }, m.id);
      // A planned party starts by itself when it's due (for everyone who's in the room by then).
      if (room.startsAt != null && !room.started && this.now() >= room.startsAt) {
        room.started = true; room.wantPlay = room.members.size > 0; room.at = this.now();
        this.persist(room);
        this.changed(room);
      }
      const planned = room.startsAt != null && this.now() < room.startsAt + 60 * MIN;
      const maxAge = room.startsAt != null ? Math.max(room.startsAt + 12 * 3600000, room.created + 24 * 3600000) : room.created + 24 * 3600000;
      if ((!room.members.size && !planned && this.now() - room.touched > 10 * MIN) || this.now() > maxAge) this.end(room);
    }
  }

  // Videos a room is using (or a planned party will use) can't be deleted.
  protects(mediaKey) {
    return [...this.rooms.values()].some((r) => r.media.mediaKey === mediaKey && (r.members.size > 0 || (r.startsAt != null && !r.started)));
  }

  renameUser(user) {
    for (const room of this.rooms.values()) {
      let changed = false;
      for (const member of room.members.values()) if (member.userId === user.id && (member.name !== user.name || member.avatar !== (user.avatar || null))) {
        member.name = user.name; member.avatar = user.avatar || null; changed = true;
      }
      if (changed) this.changed(room);
    }
  }
}
