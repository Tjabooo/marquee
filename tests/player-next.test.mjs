import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { nextLibraryEpisode, isNextEpisodeTime, nextEpisodePromptAt } from '../public/player-next.js';

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

test('Up Next uses closing-credit chapters first, otherwise a conservative runtime-based estimate', () => {
  assert.equal(nextEpisodePromptAt(2100, 1900), 1900);
  assert.equal(nextEpisodePromptAt(2100, null), 2047.5);
  assert.equal(nextEpisodePromptAt(1200, null), 1170);
  assert.equal(nextEpisodePromptAt(3600, null), 3525);
  assert.equal(nextEpisodePromptAt(200, null), null);
  assert.equal(nextEpisodePromptAt(NaN, null), null);
  assert.equal(nextEpisodePromptAt(1000, 100), 970, 'early chapter markers are not closing credits');
  assert.equal(isNextEpisodeTime({ time: 1899, duration: 2100, creditsAt: 1900 }), false);
  assert.equal(isNextEpisodeTime({ time: 1900, duration: 2100, creditsAt: 1900 }), true);
  assert.equal(isNextEpisodeTime({ time: 2047, duration: 2100, creditsAt: null }), false);
  assert.equal(isNextEpisodeTime({ time: 2048, duration: 2100, creditsAt: null }), true);
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
function playbackHarness({ prepare, autoplayRejected = false } = {}) {
  const nodes = new Map();
  const $ = (key) => { if (!nodes.has(key)) nodes.set(key, new Element()); return nodes.get(key); };
  const logs = [];
  const video = new Element();
  const context = vm.createContext({ $, video, URL, AbortController, setTimeout, clearTimeout, location: { href: 'https://example.test/' },
    nextLibraryEpisode, isNextEpisodeTime, invalidateLibraryProgress() {}, state: { library: [episode('one', 1), episode('two', 2, { still: 'https://image.test/two.jpg' })], libraryShows: [{ id: 'tv-123', backdrop: 'https://image.test/show.jpg' }], progress: {}, view: 'library' },
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
    endSeek: () => { context.seeking = null; }, setSpinner() {}, updatePlayState() {}, updateTime() {}, showPlayerUi() {}, renderParty() {},
    setupPlayerSubs() {}, watchAudio() {}, watchCastTargets() {}, canCastFromBrowser: false,
    fsElement: () => false, setTheme() {}, pageThemeColor: '#000', renderLibrary() {},
    pushOverlay: () => logs.push({ overlay: 'push' }), swapTopOverlay: () => logs.push({ overlay: 'swap' }),
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

test('Next uses the end-window fallback without chapters and is suppressed in incompatible playback modes', () => {
  const h = playbackHarness(); h.context.current.creditsAt = null; h.video.currentTime = 960;
  h.run('updateUpNext()'); assert.equal(h.$('#up-next').hidden, true);
  h.video.currentTime = 971;
  h.run('updateUpNext()'); assert.equal(h.$('#up-next').hidden, false);
  h.video.ended = true; h.run('updateUpNext()'); assert.equal(h.$('#up-next').hidden, false);
  for (const [key, value] of [['party', {}], ['nativeSubs', true], ['seeking', 900]]) {
    h.context[key] = value; h.run('updateUpNext()'); assert.equal(h.$('#up-next').hidden, true); h.context[key] = key === 'nativeSubs' ? false : null;
  }
  h.run('updateUpNext()'); assert.equal(h.$('#up-next').hidden, false);
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
