import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { nextLibraryEpisode, isNextEpisodeTime, nextEpisodePromptAt, AUTOPLAY_SECONDS, AUTOPLAY_CHAIN } from '../public/player-next.js';

const episode = (id, number, extra = {}) => ({ id, show: 'tv-123', title: 'Example Show', season: 1, episode: number, file: `${id}.mp4`, ...extra });
const playing = { ...episode('one', 1), kind: 'lib', key: 'one' };

test('Next uses the refreshed current file identity, immediate episode and only the supplied own library', () => {
  const one = episode('one', 1, { show: 'tv-456' });
  const two = episode('two', 2, { show: 'tv-456' });
  const wrongShow = episode('wrong', 2);
  assert.equal(nextLibraryEpisode(playing, [one, two, wrongShow], []).id, 'two');
  assert.equal(nextLibraryEpisode(playing, [one, wrongShow], []), null);
  assert.equal(nextLibraryEpisode({ ...playing, kind: 'dl' }, [one, two], []), null);
  assert.equal(nextLibraryEpisode(playing, [two], []), null, 'removed current files cannot retain a stale recommendation');
});

test('Next never skips an episode or infers a finale from downloaded files', () => {
  const third = episode('three', 3);
  const nextSeason = episode('season-two', 1, { season: 2 });
  assert.equal(nextLibraryEpisode(playing, [episode('one', 1), third, nextSeason], []), null);
  assert.equal(nextLibraryEpisode(playing, [episode('one', 1), nextSeason], [{ id: 'tv-123', seasons: [{ number: 1, total: 1 }] }]).id, 'season-two');
  assert.equal(nextLibraryEpisode(playing, [episode('one', 1), nextSeason], [{ id: 'tv-123', seasons: [{ number: 1, total: 2 }] }]), null);
  assert.equal(nextLibraryEpisode(playing, [episode('one', 1), episode('season-three', 1, { season: 3 })], [{ id: 'tv-123', seasons: [{ number: 1, total: 1 }] }]), null);
});

test('specials, malformed numbers and unready files are excluded, and duplicates resolve deterministically', () => {
  const one = episode('one', 1);
  const a = episode('two-a', 2, { file: 'a.mp4' });
  const b = episode('two-b', 2, { file: 'b.mp4' });
  assert.equal(nextLibraryEpisode(playing, [one, b, a], []).id, 'two-a');
  assert.equal(nextLibraryEpisode(playing, [one, a, b], []).id, 'two-a');
  assert.equal(nextLibraryEpisode(playing, [one, { ...a, converting: true }, { ...b, done: false }], []), null);
  for (const bad of [{ season: 0 }, { episode: 0 }, { season: -1 }, { episode: 1.5 }, { season: '1' }, { show: null }]) {
    assert.equal(nextLibraryEpisode(playing, [{ ...one, ...bad }, a], []), null);
  }
});

test('Up Next starts exactly at the credits, and without a known credits start only at the real end', () => {
  assert.equal(nextEpisodePromptAt(2100, 1900), 1900);
  for (const duration of [2100, 1200, 3600, 200]) assert.equal(nextEpisodePromptAt(duration, null), null, 'no guessed end window');
  assert.equal(nextEpisodePromptAt(NaN, null), null);
  assert.equal(nextEpisodePromptAt(1000, 100), null, 'early chapter markers are not closing credits');
  assert.equal(nextEpisodePromptAt(1000, 1000), null);
  assert.equal(isNextEpisodeTime({ time: 1899.9, duration: 2100, creditsAt: 1900 }), false);
  assert.equal(isNextEpisodeTime({ time: 1900, duration: 2100, creditsAt: 1900 }), true);
  assert.equal(isNextEpisodeTime({ time: 2099.9, duration: 2100, creditsAt: null }), false);
  assert.equal(isNextEpisodeTime({ time: 180, duration: 200, creditsAt: null }), false);
  assert.equal(isNextEpisodeTime({ ended: true, time: 200, duration: 200, creditsAt: null }), true);
});

const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
class Element {
  constructor() { this.hidden = true; this.disabled = false; this.textContent = ''; this.attrs = {}; this.events = new Map(); this.style = { setProperty() {} }; this.classes = new Set(); this.dataset = {}; this.children = []; this.classList = { add: (...xs) => xs.forEach(x => this.classes.add(x)), remove: (...xs) => xs.forEach(x => this.classes.delete(x)), toggle: (x, on) => on ? this.classes.add(x) : this.classes.delete(x) }; }
  setAttribute(k, v) { this.attrs[k] = v; }
  replaceChildren(...xs) { this.children = xs; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(k, fn) { if (!this.events.has(k)) this.events.set(k, new Set()); this.events.get(k).add(fn); }
  removeEventListener(k, fn) { this.events.get(k)?.delete(fn); }
  dispatch(k) { for (const fn of [...(this.events.get(k) || [])]) fn({ type: k }); }
  click() { return [...this.events.get('click')][0](); }
  focus() {}
}
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
function playbackHarness({ prepare, autoplayRejected = false, clock = null } = {}) {
  const nodes = new Map();
  const $ = (key) => { if (!nodes.has(key)) nodes.set(key, new Element()); return nodes.get(key); };
  const logs = [];
  const video = new Element();
  const context = vm.createContext({ $, video, URL, AbortController, setTimeout: clock?.setTimeout || setTimeout, clearTimeout: clock?.clearTimeout || clearTimeout,
    Date: clock?.Date || Date, location: { href: 'https://example.test/' },
    nextLibraryEpisode, isNextEpisodeTime, AUTOPLAY_SECONDS, AUTOPLAY_CHAIN, invalidateLibraryProgress() {}, state: { library: [episode('one', 1), episode('two', 2, { still: 'https://image.test/two.jpg' })], libraryShows: [{ id: 'tv-123', backdrop: 'https://image.test/show.jpg' }], progress: {}, view: 'library' },
    current: { ...playing, ready: true, sourceUrl: 'https://example.test/one.mp4', abort: new AbortController(), creditsAt: 800, upNextDismissed: false },
    party: null, nativeSubs: false, onTvVersion: false, seeking: null, hasRemotePlayback: false,
    playerEl: $('#player'), ccBtn: $('#cc-btn'), audioBtn: $('#sync-btn'), helpEl: $('#help'), osdEl: $('#osd'),
    audioWatch: {}, ccLangs: ['en'], lastSave: 123, lastTap: {}, skipTotal: 10, skipAt: 100, osdTimer: null,
    document: { activeElement: new Element(), body: { style: {}, classList: { add() {}, remove() {} } } },
    localStorage: { setItem: (key, value) => logs.push({ store: key, value: JSON.parse(value) }), removeItem: key => logs.push({ remove: key }) },
    jsonPost: body => ({ body }), progressRef: f => `l:${f.id}`, resumeKey: f => `resume:${f.id}`, savedProgress: () => null,
    episodeArt: (still, show) => ({ still, backdrop: show?.backdrop }),
    episodeLabel: f => `S${f.season} E${f.episode}`, libraryFile: f => ({ ...f, kind: 'lib', key: f.id, done: true }),
    toast: message => logs.push({ toast: message }), layoutSubs: () => logs.push({ layout: true }),
    api: async (path, options) => { logs.push({ path, options, id: context.current?.id }); if (path.includes('/play-link')) return prepare ? prepare(options) : { url: 'https://example.test/two.mp4', name: 'two.mp4' }; if (path.endsWith('/credits')) return { creditsAt: null }; return {}; },
    fetch: async () => ({ ok: true, body: { cancel: () => Promise.resolve() } }),
    leaveWatchRoom: () => { context.party = null; }, resetCasting() {}, clearSubTracks() {}, closeCcMenu() {}, closeAudioMenu() {}, resetAudioSelection() {},
    endSeek: () => { context.seeking = null; }, setSpinner() {}, updatePlayState() {}, updateTime() {}, showPlayerUi() {}, renderParty() {}, seekPreview: { load() {}, show() {} },
    setupPlayerSubs() {}, watchAudio() {}, watchCastTargets() {}, canCastFromBrowser: false,
    fsElement: () => false, setTheme() {}, pageThemeColor: '#000', renderLibrary() {},
    pushOverlay: () => logs.push({ overlay: 'push' }), swapTopOverlay: () => logs.push({ overlay: 'swap' }),
    sleep: null, closeNightMenu() {}, renderNightMenu() {}, clearSleep() {}, sleepPause() {}, nightWanted: false, nightAvailable: () => false, night: { on: false, set() {} },
  });
  Object.assign(video, { currentSrc: 'https://example.test/one.mp4', src: 'https://example.test/one.mp4', currentTime: 500, duration: 1000, paused: false, ended: false, readyState: 1,
    pause: () => { logs.push({ pause: context.current?.id || null }); video.paused = true; video.dispatch('pause'); },
    play: () => { logs.push({ play: context.current?.id }); video.paused = false; return autoplayRejected ? Promise.reject(Error('gesture required')) : Promise.resolve(); },
    load: () => { video.currentSrc = ''; video.currentTime = 0; video.duration = NaN; video.readyState = 0; },
  });
  vm.runInContext(between('function saveProgress(', '// ---- subtitles ----'), context);
  vm.runInContext(between('let sourceMetadataHandler =', '\nasync function onWireless'), context);
  vm.runInContext(between('function resetPlayerMedia()', "video.addEventListener('timeupdate', () => saveProgress());"), context);
  video.addEventListener('pause', () => vm.runInContext('saveProgress(true)', context));
  const metadata = () => { video.currentSrc = video.src; video.duration = 1000; video.readyState = 1; video.dispatch('loadedmetadata'); };
  return { context, $, video, logs, metadata, run: code => vm.runInContext(code, context) };
}

test('manual Next saves the old episode, ignores a double click, preserves overlay and tolerates autoplay rejection', async () => {
  const pending = deferred();
  const h = playbackHarness({ prepare: () => pending.promise, autoplayRejected: true });
  h.video.currentTime = 850;
  const first = h.run('playNextEpisode()');
  const second = h.run('playNextEpisode()');
  assert.deepEqual(h.$('#up-next-art').children, [{ still: 'https://image.test/two.jpg', backdrop: 'https://image.test/show.jpg' }], 'Up next shows the next episode’s still');
  assert.equal(h.$('#up-next-play').disabled, true);
  assert.equal(h.context.current.id, 'one');
  assert.equal(h.video.paused, true);
  assert.ok(h.logs.some(entry => entry.path === '/api/me/progress' && entry.options.body.ref === 'l:one' && entry.options.body.time === 850));
  assert.equal(h.logs.filter(entry => entry.path?.includes('/play-link')).length, 1);
  pending.resolve({ url: 'https://example.test/two.mp4', name: 'two.mp4' });
  await Promise.all([first, second]);
  assert.equal(h.context.current.id, 'two');
  assert.equal(h.logs.filter(entry => entry.overlay).length, 0);
  assert.ok(h.logs.some(entry => entry.play === 'two'));
  assert.ok(h.logs.filter(entry => entry.path === '/api/me/progress').every(entry => entry.options.body.ref === 'l:one'));
  assert.equal(h.context.lastSave, 0, 'the next file has a fresh progress throttle');
  h.metadata();
  assert.equal(h.context.current.ready, true);
});

test('a failed Next preflight leaves the old video available and the Next button can retry', async () => {
  let attempts = 0;
  const h = playbackHarness({ prepare: async () => { if (++attempts === 1) throw Error('Server offline'); return { url: 'https://example.test/two.mp4', name: 'two.mp4' }; } });
  h.video.currentTime = 850;
  await h.run('playNextEpisode()');
  assert.equal(h.context.current.id, 'one');
  assert.equal(h.video.src, 'https://example.test/one.mp4');
  assert.equal(h.$('#up-next-play').disabled, false);
  assert.match(h.$('#up-next-error').textContent, /Server offline.*Try/);
  await h.run('playNextEpisode()');
  assert.equal(h.context.current.id, 'two');
  assert.equal(attempts, 2);
});

test('Keep watching cancels a pending transition and stays dismissed at the actual end', async () => {
  const pending = deferred(); const h = playbackHarness({ prepare: () => pending.promise });
  h.video.currentTime = 850;
  const transition = h.run('playNextEpisode()');
  const signal = h.context.current.nextAbort.signal;
  h.$('#up-next-dismiss').click();
  assert.equal(signal.aborted, true);
  pending.resolve({ url: 'https://example.test/two.mp4', name: 'two.mp4' });
  await transition;
  h.video.ended = true; h.run('updateUpNext()');
  assert.equal(h.context.current.id, 'one');
  assert.equal(h.$('#up-next').hidden, true);
  assert.equal(h.context.current.upNextError, '');
});

test('Next waits for the real end without a credits start and is suppressed in incompatible playback modes', () => {
  const h = playbackHarness(); h.context.current.creditsAt = null;
  for (const time of [960, 971, 999.9]) { h.video.currentTime = time; h.run('updateUpNext()'); assert.equal(h.$('#up-next').hidden, true, `hidden at ${time}`); }
  h.video.ended = true; h.run('updateUpNext()'); assert.equal(h.$('#up-next').hidden, false);
  for (const [key, value] of [['party', {}], ['nativeSubs', true], ['seeking', 900]]) {
    h.context[key] = value; h.run('updateUpNext()'); assert.equal(h.$('#up-next').hidden, true); h.context[key] = key === 'nativeSubs' ? false : null;
  }
  h.run('updateUpNext()'); assert.equal(h.$('#up-next').hidden, false);
  h.run('stopAutoplay(current)');
});

function fakeClock() {
  let now = 1e6, id = 0; const timers = new Map();
  return {
    Date: { now: () => now },
    setTimeout: (fn, ms) => { timers.set(++id, { fn, at: now + ms }); return id; },
    clearTimeout: (t) => timers.delete(t),
    pending: () => timers.size,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const [t, next] = [...timers].sort((x, y) => x[1].at - y[1].at)[0] || [];
        if (!next || next.at > end) break;
        timers.delete(t); now = next.at; next.fn();
      }
      now = end;
    },
  };
}

test('the countdown starts with the credits, pauses with the video and plays the next episode', async () => {
  const clock = fakeClock(); const h = playbackHarness({ clock });
  h.video.currentTime = 799.9; h.run('updateUpNext()');
  assert.equal(h.$('#up-next').hidden, true);
  assert.equal(clock.pending(), 0, 'no countdown before the credits');
  h.video.currentTime = 800; h.run('updateUpNext()');
  assert.equal(h.$('#up-next').hidden, false);
  assert.equal(h.$('#up-next-play').textContent, `Next episode in ${AUTOPLAY_SECONDS}`);
  assert.match(h.$('#up-next-status').textContent, /Plays in 10 seconds/);
  clock.advance(4000);
  assert.equal(h.$('#up-next-play').textContent, `Next episode in ${AUTOPLAY_SECONDS - 4}`);
  h.video.paused = true; clock.advance(30000);
  assert.equal(h.context.current.id, 'one', 'a pause during the credits pauses the countdown');
  h.video.paused = false; clock.advance(5900);
  assert.equal(h.context.current.id, 'one');
  clock.advance(200);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.context.current.id, 'two');
  assert.ok(h.logs.some((entry) => entry.play === 'two'));
});

test('Keep watching and seeking back cancel the countdown; it restarts in full at the credits', () => {
  const clock = fakeClock(); const h = playbackHarness({ clock });
  h.video.currentTime = 850; h.run('updateUpNext()');
  clock.advance(6000);
  h.video.currentTime = 700; h.run('updateUpNext()');
  assert.equal(h.$('#up-next').hidden, true); assert.equal(clock.pending(), 0);
  clock.advance(20000); assert.equal(h.context.current.id, 'one');
  h.video.currentTime = 801; h.run('updateUpNext()');
  assert.equal(h.$('#up-next-play').textContent, `Next episode in ${AUTOPLAY_SECONDS}`);
  h.$('#up-next-dismiss').click();
  assert.equal(clock.pending(), 0);
  h.video.ended = true; h.run('updateUpNext()'); clock.advance(60000);
  assert.equal(h.context.current.id, 'one'); assert.equal(h.$('#up-next').hidden, true);
});

test('after a few unattended episodes the card waits for a person', () => {
  const clock = fakeClock(); const h = playbackHarness({ clock });
  h.run(`autoChain = ${AUTOPLAY_CHAIN}`);
  h.video.currentTime = 850; h.run('updateUpNext()');
  assert.equal(h.$('#up-next').hidden, false);
  assert.equal(h.$('#up-next-play').textContent, 'Next episode');
  assert.equal(clock.pending(), 0);
});

test('closed-session credits, links and metadata cannot revive playback or seek the next file', async () => {
  const pending = deferred(); const h = playbackHarness({ prepare: () => pending.promise });
  const transition = h.run('playNextEpisode()'); h.run('resetPlayerMedia()');
  pending.resolve({ url: 'https://example.test/two.mp4' }); await transition;
  assert.equal(h.context.current, null);
  assert.equal(h.logs.filter(entry => entry.play).length, 0);
  h.context.current = { ...playing, ready: true };
  h.run("setPlayerSource('https://example.test/old.mp4', current, () => { video.currentTime = 999; })");
  const staleMetadata = [...h.video.events.get('loadedmetadata')].at(-1);
  h.context.current = { ...playing, id: 'two', ready: true };
  h.run("setPlayerSource('https://example.test/new.mp4', current, () => { video.currentTime = 25; })");
  h.video.currentSrc = h.video.src; h.video.readyState = 1;
  staleMetadata(); assert.notEqual(h.video.currentTime, 999, 'a captured stale continuation cannot apply to the new source');
  h.metadata(); assert.equal(h.video.currentTime, 25);
  assert.equal(h.video.events.get('loadedmetadata').size, 1, 'only the permanent Up next listener remains');
});

test('player keyboard shortcuts leave Space and Enter on Up next controls to the browser', () => {
  const h = playbackHarness();
  h.context.playerEl.hidden = false;
  vm.runInContext(between('const playerKeyTarget =', "document.addEventListener('keydown'"), h.context);
  h.context.event = { target: { closest: () => ({}), matches: () => false }, key: ' ' };
  assert.equal(h.run('playerKeyTarget(event)'), false);
  h.context.event.key = 'Enter'; assert.equal(h.run('playerKeyTarget(event)'), false);
});


test('late optional credits responses cannot attach a marker after that playback session closes', async () => {
  const h = playbackHarness(); const pending = deferred();
  h.context.api = () => pending.promise;
  const old = h.context.current;
  const lookup = h.run('loadPlayerCredits(current)');
  h.run('resetPlayerMedia()');
  pending.resolve({ creditsAt: 123 }); await lookup;
  assert.equal(h.context.current, null);
  assert.equal(old.creditsAt, 800);
});

test('Skip intro shows during the opening, jumps past it, stays away from guests and auto-skips once', () => {
  const h = playbackHarness();
  Object.assign(h.context, { prefs: () => ({}), osd: message => h.logs.push({ osd: message }) });
  const button = h.$('#skip-intro');
  h.context.current.intro = { start: 60, end: 110 };
  h.video.currentTime = 30; h.run('updateSkipIntro()'); assert.equal(button.hidden, true, 'not before the intro');
  h.video.currentTime = 61; h.run('updateSkipIntro()'); assert.equal(button.hidden, false);
  h.run('skipIntro()'); assert.equal(h.video.currentTime, 110); assert.equal(button.hidden, true);
  h.video.currentTime = 61; h.context.party = { isHost: false, control() {} }; h.run('updateSkipIntro()');
  assert.equal(button.hidden, true, 'a Watch Together guest cannot seek');
  const seeks = []; h.context.party = { isHost: true, control: (kind, at) => seeks.push([kind, at]) };
  h.context.current.introDone = false; h.context.prefs = () => ({ skipIntro: 'auto' }); h.run('updateSkipIntro()');
  assert.equal(button.hidden, false, 'the host gets the button, but nothing skips on its own in a room');
  h.run('skipIntro()'); assert.deepEqual(seeks, [['seek', 110]]);
  h.context.party = null; h.context.current.introDone = false; h.video.currentTime = 61; h.run('updateSkipIntro()');
  assert.equal(h.video.currentTime, 110, 'auto mode skips');
  h.video.currentTime = 70; h.run('updateSkipIntro()');
  assert.equal(h.video.currentTime, 70, 'seeking back to watch the intro is left alone');
  assert.equal(button.hidden, false);
});
