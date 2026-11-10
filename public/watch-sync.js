// Clock compensation and gentle correction keep video timing independent of message arrival time.
// Subtitle selection, volume and cue offsets are deliberately absent from the network protocol.
import { T } from './i18n.js';
// Small drift is corrected by a fixed, slight speed change that starts and stops rarely: changing
// the speed all the time can pull a browser's audio away from its picture. Only a large gap seeks,
// because a seek costs seconds of decoding on a big file and holds up the whole room.
const SEEK_DRIFT = 1.25, CORRECT_FROM = 0.25, CORRECT_UNTIL = 0.06, CORRECT_RATE = 0.04;
// A stall shorter than this stays private while the room plays: the viewer catches up by themselves.
export const STALL_GRACE = 1000;
export function playbackPlan(state, serverNow, currentTime, correcting = false) {
  const delay = state.playing ? Math.max(0, state.at - serverNow) : 0;
  const target = state.position + (state.playing ? Math.max(0, serverNow - state.at) / 1000 : 0);
  const playing = state.playing && delay === 0;
  const drift = target - currentTime;
  const correct = playing && Math.abs(drift) > (correcting ? CORRECT_UNTIL : CORRECT_FROM);
  return { target, delay, playing, seek: Math.abs(drift) > SEEK_DRIFT, rate: correct ? 1 + Math.sign(drift) * CORRECT_RATE : 1 };
}

const cueTimes = new WeakMap();
export function offsetCues(track, seconds) {
  for (const cue of Array.from(track?.cues || [])) {
    if (!cueTimes.has(cue)) cueTimes.set(cue, { start: cue.startTime, end: cue.endTime });
    const original = cueTimes.get(cue);
    cue.startTime = Math.max(0, original.start + seconds);
    cue.endTime = Math.max(cue.startTime + 0.001, original.end + seconds);
  }
}

export class WatchSession {
  constructor({ video, room, clientId, request, onState, onEnd, onError, onChat = () => {}, onReaction = () => {},
    now = () => performance.now(), makeEvents = (url) => new EventSource(url) }) {
    Object.assign(this, { video, state: room, clientId, request, onState, onEnd, onError, onChat, onReaction, now, makeEvents });
    this.chat = [];
    this.base = `/api/watch/${room.token}`;
    this.offsets = {}; this.samples = []; this.clockOffset = room.serverNow - now(); this.rtt = 0;
    this.connected = false; this.online = true; this.closed = false; this.blocked = true; this.waiting = false;
    this.commands = Promise.resolve(); this.listeners = [];
  }

  get isHost() { return this.state.host === this.clientId; }
  get serverNow() { return this.now() + this.clockOffset; }
  post(action, body = {}, keepalive = false) {
    return this.request(`${this.base}/${action}`, { method: 'POST', keepalive, signal: keepalive ? undefined : AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, clientId: this.clientId }) });
  }

  sample(start, end, serverNow) {
    if (!Number.isFinite(serverNow)) return;
    this.samples.push({ rtt: end - start, offset: serverNow - (start + end) / 2 });
    this.samples = this.samples.slice(-12);
    const best = this.samples.reduce((a, b) => a.rtt < b.rtt ? a : b);
    this.clockOffset = best.offset; this.rtt = best.rtt;
  }

  async clock() {
    const start = this.now();
    const clock = await this.request('/api/watch/clock', { signal: AbortSignal.timeout(5000) });
    this.sample(start, this.now(), clock.serverNow);
  }

  receive(state) {
    if (this.closed) return;
    // Chat and reactions share the stream but aren't room state.
    if (state.chatLog) { this.chat = state.chatLog.slice(-50); this.onChat(null, this); return; }
    if (state.chat) {
      if (!this.chat.some((m) => m.id === state.chat.id)) { this.chat.push(state.chat); this.chat = this.chat.slice(-50); this.onChat(state.chat, this); }
      return;
    }
    if (state.reaction) { this.onReaction(state.reaction, this); return; }
    if (state.ended || state.left) { this.onEnd(T('This watch room has ended or you were disconnected.')); return; }
    if (state.revision < this.state.revision) return;
    this.state = state;
    this.onState(this);
    this.sync();
  }

  async start() {
    this.video.preload = 'auto';
    for (let i = 0; i < 4 && !this.closed; i++) await this.clock();
    if (this.closed) return;
    this.openEvents();
    for (const event of ['loadedmetadata', 'canplay', 'playing', 'seeked']) this.listen(event, () => {
      this.waiting = false; this.pulse(); this.sync();
    });
    this.listen('play', () => {
      if (this.isHost && !this.blocked && !this.controlling && this.now() > (this.quietUntil || 0) && !this.state.intentPlaying) this.control('play');
    });
    this.listen('pause', () => {
      if (this.isHost && !this.blocked && !this.controlling && !this.waiting && !this.video.ended && this.now() > (this.quietUntil || 0) && this.state.intentPlaying) this.control('pause');
    });
    this.listen('seeking', () => {
      this.pulse();
      if (this.isHost && !this.controlling && (this.internalSeek == null || Math.abs(this.video.currentTime - this.internalSeek) > 0.2)) this.control('seek');
    });
    this.listen('seeked', () => { this.internalSeek = null; });
    this.listen('waiting', () => { this.waiting = true; this.pulse(); });
    this.listen('stalled', () => { if (this.video.readyState < 3) { this.waiting = true; this.pulse(); } });
    this.listen('ended', () => { if (this.isHost) this.control('pause', this.video.currentTime); });
    this.syncTimer = setInterval(() => this.sync(), 250);
    this.pulseTimer = setInterval(() => this.pulse(), 2000);
    this.clockTimer = setInterval(() => this.clock().catch(() => {}), 20000);
    this.onState(this);
  }

  openEvents() {
    this.events?.close();
    this.connected = false;
    this.events = this.makeEvents(`${this.base}/events?clientId=${encodeURIComponent(this.clientId)}`);
    this.events.onopen = () => { this.connected = true; this.pulse(); };
    this.events.onmessage = (e) => { try { this.receive(JSON.parse(e.data)); } catch (err) { this.onError(err.message); } };
    this.events.onerror = () => { this.connected = false; this.pauseVideo(); this.onState(this); this.pulse(); };
  }

  listen(event, callback) { this.listeners.push([event, callback]); this.video.addEventListener(event, callback); }

  // What the room hears. A viewer's own seek always holds the room, but a brief stall during
  // playback doesn't: stopping everyone for it costs more than letting this one viewer catch up.
  health() {
    const stalled = this.waiting || this.video.readyState < 3;
    if (!stalled) this.stalledSince = null;
    else this.stalledSince ??= this.now();
    const hiccup = stalled && !this.video.seeking && this.state.playing && this.now() - this.stalledSince < STALL_GRACE;
    return { ready: this.connected && !this.video.seeking && (this.video.readyState >= 3 || hiccup), buffering: stalled && !hiccup };
  }

  async pulse() {
    if (this.closed) return;
    const health = this.health();
    this.toldBuffering = health.buffering;
    if (this.pulsing) { this.pulseAgain = true; return; }
    this.pulsing = true;
    try {
      const start = this.now();
      const state = await this.post('heartbeat', { ...health, blocked: this.blocked, rtt: this.rtt });
      if (this.closed) return;
      this.sample(start, this.now(), state.serverNow);
      this.online = true; this.receive(state);
    } catch (err) {
      if (this.closed) return;
      this.online = false; this.pauseVideo(); this.onState(this);
      if (err.status === 410) this.onEnd(err.message);
      else if (err.status === 403) {
        try { this.receive(await this.post('join')); if (!this.closed) this.openEvents(); }
        catch (joinError) { if ([403, 410].includes(joinError.status)) this.onEnd(joinError.message); }
      }
    } finally {
      this.pulsing = false;
      if (this.pulseAgain) { this.pulseAgain = false; this.pulse(); }
    }
  }

  sync() {
    clearTimeout(this.startTimer);
    if (!this.closed && this.health().buffering !== this.toldBuffering) this.pulse(); // a stall outlasted its grace, or ended
    if (this.closed || !this.connected || !this.online || this.controlling || this.video.readyState < 1) return;
    const plan = playbackPlan(this.state, this.serverNow, this.video.currentTime, this.correcting);
    const end = Number.isFinite(this.video.duration) ? Math.max(0, this.video.duration - 0.05) : plan.target;
    if (plan.seek && !this.video.seeking && (!this.blocked || this.video.paused)) {
      this.internalSeek = Math.min(plan.target, end);
      this.video.currentTime = this.internalSeek;
    }
    if (this.blocked) return; // Preload the shared position, but let the Ready button unlock sound.
    const rate = this.video.seeking ? 1 : plan.rate;
    this.correcting = rate !== 1;
    if (this.video.playbackRate !== rate) this.video.playbackRate = rate;
    if (!plan.playing) {
      this.pauseVideo();
      if (plan.delay > 0) this.startTimer = setTimeout(() => this.sync(), Math.max(1, plan.delay));
    } else if (this.video.paused && !this.playPending && !this.waiting && !this.video.seeking && this.video.readyState >= 3) {
      this.playPending = true;
      this.quietUntil = this.now() + 500;
      this.video.play().catch((err) => {
        if (this.closed || err.name === 'AbortError') return;
        this.blocked = true; this.onState(this); this.pulse();
      }).finally(() => { this.playPending = false; });
    }
  }

  // This call must run directly in the viewer's click handler to satisfy mobile autoplay rules.
  unlock() {
    this.quietUntil = this.now() + 500;
    this.video.play().then(() => {
      if (this.closed) return;
      this.blocked = false; this.waiting = false;
      this.pauseVideo(); this.pulse(); this.sync(); this.onState(this);
    }).catch((e) => this.onError(e.message));
  }

  control(action, position = this.video.currentTime) {
    if (!this.isHost) { this.onError(T('The host controls playback. Your subtitles and volume are yours.')); return; }
    this.commands = this.commands.then(async () => {
      if (this.closed) return;
      this.controlling = true;
      if (action === 'pause') this.pauseVideo();
      try { this.receive(await this.post('control', { action, position })); }
      catch (err) { this.onError(err.message); }
      finally { this.controlling = false; this.sync(); }
    });
  }

  async say(text) {
    const message = await this.post('chat', { text });
    if (!this.chat.some((m) => m.id === message.id)) { this.chat.push(message); this.chat = this.chat.slice(-50); this.onChat(message, this); }
    return message;
  }

  // Play now rooms: the download's progress for this room, and (host) moving everyone to the finished file.
  partStatus(signal) { return this.request(`${this.base}/part-status?clientId=${encodeURIComponent(this.clientId)}`, { signal }); }
  async switchToFull() { this.receive(await this.post('switch')); }
  react(emoji) { return this.post('react', { emoji }).catch((err) => this.onError(err.message)); }

  // Host only: start at `startsAt` (ms, server clock), or null to clear the countdown.
  async schedule(startsAt) { this.receive(await this.post('schedule', { startsAt })); }

  // Milliseconds until a planned start, on the server's clock (null when there's none).
  get startsIn() { return this.state.startsAt ? this.state.startsAt - this.serverNow : null; }

  pauseVideo() {
    if (!this.video.paused) { this.quietUntil = this.now() + 500; this.video.pause(); }
  }

  close({ notify = true } = {}) {
    if (this.closed) return;
    this.closed = true;
    this.events?.close();
    clearInterval(this.syncTimer); clearInterval(this.pulseTimer); clearInterval(this.clockTimer); clearTimeout(this.startTimer);
    for (const [event, callback] of this.listeners) this.video.removeEventListener(event, callback);
    this.video.playbackRate = 1;
    if (notify) this.post('leave', {}, true).catch(() => {});
  }
}
