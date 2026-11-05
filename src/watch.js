// Shared playback is a clock, not a relayed video stream. Every viewer fetches the same media,
// while small SSE messages carry an authoritative timeline. Captions never enter room state.
import crypto from 'node:crypto';

const fail = (status, message) => Object.assign(new Error(message), { status });
const CLIENT = /^[A-Za-z0-9_-]{16,80}$/;
const STALE = 20000;

export class WatchRooms {
  constructor({ now = Date.now } = {}) { this.now = now; this.rooms = new Map(); }

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
    const room = { token: crypto.randomBytes(18).toString('base64url'), creator: user.id, media,
      members: new Map(), host: client, position: this.position(position), playing: false, wantPlay: false,
      at: this.now(), created: this.now(), touched: this.now(), revision: 0 };
    this.rooms.set(room.token, room);
    try { this.join(room.token, user, client); } catch (e) { this.rooms.delete(room.token); throw e; }
    return this.snapshot(room);
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
    if (!existing) room.members.set(client, { id: client, userId: user.id, name: String(user.name || 'Viewer').slice(0, 80),
      ready: false, buffering: false, blocked: false, rtt: 0, seen: this.now(), streams: new Set() });
    room.members.get(client).seen = this.now();
    room.members.get(client).name = String(user.name || 'Viewer').slice(0, 80);
    if (!room.members.has(room.host)) room.host = client;
    this.changed(room);
    return this.snapshot(room);
  }

  blockers(room) { return [...room.members.values()].filter((m) => !m.streams.size || !m.ready || m.buffering || m.blocked); }

  reconcile(room) {
    const canPlay = room.wantPlay && room.members.size > 0 && !this.blockers(room).length;
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
      waitingFor: room.wantPlay ? this.blockers(room).map((m) => m.name) : [],
      members: [...room.members.values()].map((m) => ({ id: m.id, name: m.name, ready: m.ready,
        connected: m.streams.size > 0, buffering: m.buffering, blocked: m.blocked })) };
  }

  preview(token) {
    const room = this.room(token);
    return { media: room.media, host: room.members.get(room.host)?.name || 'Family', viewers: room.members.size };
  }

  subscribe(token, user, client, send) {
    const room = this.room(token);
    const member = this.member(room, user, client);
    member.streams.add(send); member.seen = this.now();
    this.changed(room);
    return () => {
      member.streams.delete(send);
      if (this.rooms.has(token) && room.members.has(client)) this.changed(room);
    };
  }

  heartbeat(token, user, client, status) {
    const room = this.room(token);
    const member = this.member(room, user, client);
    member.seen = this.now(); room.touched = this.now();
    const next = { name: String(user.name || 'Viewer').slice(0, 80), ready: status.ready === true, buffering: status.buffering === true, blocked: status.blocked === true };
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
    this.changed(room);
    return this.snapshot(room);
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
      if ((!room.members.size && this.now() - room.touched > 10 * 60000) || this.now() - room.created > 24 * 3600000) {
        for (const m of room.members.values()) for (const send of m.streams) send({ ended: true });
        this.rooms.delete(token);
      }
    }
  }

  protects(mediaKey) { return [...this.rooms.values()].some((r) => r.media.mediaKey === mediaKey && r.members.size > 0); }

  renameUser(user) {
    for (const room of this.rooms.values()) {
      let changed = false;
      for (const member of room.members.values()) if (member.userId === user.id && member.name !== user.name) {
        member.name = user.name; changed = true;
      }
      if (changed) this.changed(room);
    }
  }
}
