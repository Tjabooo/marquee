import { T as englishT } from '../public/i18n.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { audioChoices, nativeAudioMapping, sameAudio } from '../public/player-audio.js';

const tracks = [
  { index: 1, audioIndex: 0, streamId: '0x2', language: 'kor', title: '', channels: 2, codec: 'aac', default: true },
  { index: 2, audioIndex: 1, streamId: '0x3', language: 'kor', title: '', channels: 6, codec: 'aac' },
  { index: 3, audioIndex: 2, streamId: '0x4', language: 'eng', title: '', channels: 6, codec: 'aac' },
];
const info = { audioSource: 'served-source-fingerprint', defaultAudio: 1, tracks };
const nativeTracks = () => tracks.map(t => ({ id: String(Number(t.streamId)), language: t.language === 'kor' ? 'ko' : 'en', label: '', enabled: t.default === true }));
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test('audio choices name languages and distinguish same-language renditions and commentary without inventing unknown languages', () => {
  assert.deepEqual(audioChoices(tracks).map(t => t.label), ['Korean · Stereo', 'Korean · 5.1', 'English']);
  assert.equal(audioChoices([{ index: 1, audioIndex: 0, language: 'und', channels: 2 }])[0].label, 'Track 1');
  assert.match(audioChoices([{ ...tracks[2], title: 'Director commentary' }])[0].label, /^English · Director commentary$/);
  const duplicates = audioChoices([{ ...tracks[0] }, { ...tracks[0], index: 2, audioIndex: 1 }]);
  assert.notEqual(duplicates[0].label, duplicates[1].label);
});

test('native mapping verifies the served stream IDs or unique metadata and rejects ambiguous original-file ordering', () => {
  assert.equal(nativeAudioMapping(tracks, nativeTracks()).get(3).language, 'en');
  assert.equal(nativeAudioMapping(tracks, nativeTracks().reverse()), null);
  assert.equal(nativeAudioMapping(tracks, nativeTracks().slice(0, 2)), null);
  assert.equal(nativeAudioMapping(tracks, nativeTracks().map(t => ({ ...t, id: '' }))), null, 'duplicate Korean tracks need more than language/ordinal');
  const differentLanguages = [tracks[0], { ...tracks[2], audioIndex: 1 }];
  assert.equal(nativeAudioMapping(differentLanguages, [{ language: 'ko', enabled: true }, { language: 'en', enabled: false }]).size, 2);
  assert.equal(nativeAudioMapping(tracks, nativeTracks().map(t => ({ ...t, id: `original-${t.id}` }))), null);
});

class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.events = new Map(); this.hidden = false; this.disabled = false; this.textContent = ''; this.replacements = 0; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v); if (k === 'hidden') this.hidden = true; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  append(node) { this.children.push(node); }
  replaceChildren(...children) { this.children = children; this.replacements++; }
  addEventListener(event, fn) { if (!this.events.has(event)) this.events.set(event, new Set()); this.events.get(event).add(fn); }
  removeEventListener(event, fn) { this.events.get(event)?.delete(fn); }
  dispatch(event, extra = {}) { for (const fn of [...(this.events.get(event) || [])]) fn({ type: event, target: this, stopPropagation() {}, ...extra }); }
  contains(element) { return this === element || this.children.some(c => c instanceof Element && c.contains(element)); }
  querySelectorAll(selector) { return this.children.flatMap(c => c instanceof Element ? [...(selector === 'button' && c.tag === 'button' ? [c] : []), ...c.querySelectorAll(selector)] : []); }
  querySelector(selector) { const buttons = this.querySelectorAll('button'); return selector === 'button' ? buttons[0] : buttons.find(b => b.attrs['aria-checked'] === 'true'); }
  focus() { this.document.activeElement = this; }
  click() { return [...(this.events.get('click') || [])][0]?.({ stopPropagation() {} }); }
}
function harness({ native, request, autoplayBlocked = false, kind = 'lib', bridge = false } = {}) {
  const calls = [], timers = [], nodes = new Map();
  const document = { activeElement: {}, fullscreenElement: {}, addEventListener() {}, createElement: tag => { const el = new Element(tag); el.document = document; return el; } };
  const $ = key => { if (!nodes.has(key)) nodes.set(key, document.createElement('div')); return nodes.get(key); };
  const video = document.createElement('video');
  let sourceUrl = 'https://example.test/original.mp4';
  Object.defineProperty(video, 'src', { get: () => sourceUrl, set: value => { sourceUrl = value; video.currentSrc = value; video.currentTime = 0; video.readyState = 0; video.paused = true; } });
  Object.assign(video, { currentSrc: sourceUrl, currentTime: 17, duration: 180, paused: false, ended: false, readyState: 3, muted: true, volume: .4, playbackRate: 1.5, audioTracks: native,
    play() { calls.push(['play']); this.paused = autoplayBlocked; return autoplayBlocked ? Promise.reject(Error('gesture needed')) : Promise.resolve(); }, pause() { this.paused = true; calls.push(['pause']); } });
  const current = { id: 'episode', kind, ready: true, sourceUrl, abort: new AbortController() };
  const context = vm.createContext({ T: englishT, $, video, current, document, Node: Element, audioChoices, nativeAudioMapping, sameAudio, AbortController, URL, location: { href: 'https://example.test/' },
    party: null, nativeSubs: false, onTvVersion: false, hasRemotePlayback: false, canSetVolume: true,
    closeCcMenu() {}, extraPlayable: () => '', browserVariant: () => 'browser', mediaId: f => f.id,
    applySubModes: () => calls.push(['subtitles']), updateUpNext() {}, toast() {},
    watchAudio: () => calls.push(['compatibility']),
    api: async (path, options) => { calls.push(['api', path, options]); if (request) return request(path, options); const index = Number(new URL(path, locationURL).searchParams.get('audio')); return { ready: true, url: `https://example.test/audio-${index}.mp4`, track: index, audioSource: info.audioSource }; },
    setTimeout: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.cancelled = true; },
    audioInfo: { ...info, tracks: tracks.map(t => ({ ...t })) },
  });
  const locationURL = 'https://example.test/';
  vm.runInContext(between('function h(', 'const ICONS ='), context);
  vm.runInContext(between('let sourceMetadataHandler =', '\nasync function onWireless'), context);
  vm.runInContext(between('// ---- audio selection ----', '// Polls the server while a corrected copy'), context);
  // The live bridge: a browser that plays HLS itself (Safari), so no hls.js in the test.
  context.bridgeAvailable = () => bridge;
  context.playsHls = () => true; context.window = {};
  video.webkitShowPlaybackTargetPicker = () => {};
  vm.runInContext('installAudioMetadata(current, audioInfo)', context);
  const run = code => vm.runInContext(code, context);
  return { context, current, video, document, calls, $, run,
    metadata() { video.readyState = 1; video.dispatch('loadedmetadata'); },
    canplay() { video.readyState = 3; video.dispatch('canplay'); },
    tick(delay) { for (const timer of timers.filter(t => !t.cancelled && t.delay === delay)) { timer.cancelled = true; timer.fn(); } },
  };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const ready = index => ({ ready: true, url: `https://example.test/audio-${index}.mp4`, track: index, audioSource: info.audioSource });

test('verified native switching changes only the audio track and keeps menu rows stable through updates', async () => {
  const h = harness({ native: nativeTracks() });
  const menu = h.$('#sync-menu'); const replacements = menu.replacements;
  const originalRows = menu.querySelectorAll('button');
  await h.run('selectAudioTrack(3)');
  assert.deepEqual(h.video.audioTracks.map(t => t.enabled), [false, false, true]);
  assert.equal(h.current.audio.actual, 3);
  assert.equal(h.video.src, 'https://example.test/original.mp4');
  assert.equal(h.video.currentTime, 17);
  assert.equal(h.calls.filter(c => c[0] === 'api').length, 0);
  h.run('renderAudioControls(); renderAudioControls()');
  assert.equal(menu.replacements, replacements);
  assert.equal(menu.querySelectorAll('button')[0], originalRows[0]);
  h.video.audioTracks[1].enabled = true; h.video.audioTracks[2].enabled = false; h.run('reflectNativeAudio()');
  assert.equal(h.current.audio.actual, 2);
});

test('fallback preparation leaves the active radio and playback intact, then preserves the latest subsecond paused position and preferences', async () => {
  let prepared = false;
  const h = harness({ request: path => prepared ? ready(3) : { ready: false, state: 'preparing' } });
  const selection = h.run('selectAudioTrack(3)'); await flush();
  assert.equal(h.current.audio.actual, 1); assert.equal(h.current.audio.pending, 3);
  assert.equal(h.video.src, 'https://example.test/original.mp4'); assert.equal(h.video.paused, false);
  h.video.currentTime = .25; h.video.paused = true;
  prepared = true; h.tick(1000); await flush();
  assert.equal(h.video.src, ready(3).url); assert.equal(h.current.audio.actual, 1);
  h.metadata(); h.canplay(); await selection;
  assert.equal(h.current.audio.actual, 3);
  assert.equal(h.video.currentTime, .25); assert.equal(h.video.paused, true);
  assert.equal(h.video.muted, true); assert.equal(h.video.volume, .4); assert.equal(h.video.playbackRate, 1.5);
  assert.ok(h.calls.some(c => c[0] === 'subtitles'));
  assert.ok(h.document.fullscreenElement);
  const paths = h.calls.filter(c => c[0] === 'api').map(c => c[1]);
  assert.ok(paths[0].includes('audioRetry=1')); assert.ok(!paths[1].includes('audioRetry'));
  assert.equal(h.$('#sync-btn').getAttribute('aria-label'), 'Audio: English');
});

test('newest requested track wins and cached completion of a cancelled request cannot switch the source', async () => {
  const a = deferred(), b = deferred();
  const h = harness({ request: path => path.includes('audio=3&') ? a.promise : b.promise });
  const old = h.run('selectAudioTrack(3)'); await flush();
  const latest = h.run('selectAudioTrack(2)'); await flush();
  b.resolve(ready(2)); await flush(); h.metadata(); h.canplay(); await latest;
  a.resolve(ready(3)); await old;
  assert.equal(h.current.audio.actual, 2); assert.equal(h.video.src, ready(2).url);
});

test('choosing the active track cancels preparation, including a source still waiting to load', async () => {
  const h = harness(); h.video.currentTime = 42;
  const selection = h.run('selectAudioTrack(3)'); await flush();
  assert.equal(h.video.src, ready(3).url);
  await h.run('selectAudioTrack(1)'); await selection;
  assert.equal(h.video.src, 'https://example.test/original.mp4');
  h.metadata(); assert.equal(h.video.currentTime, 42); assert.equal(h.video.paused, false);
  assert.equal(h.current.audio.actual, 1); assert.equal(h.current.audio.pending, null);
});

test('source load errors restore the previous source and expose a usable retry, and autoplay rejection stays recoverable', async () => {
  const h = harness({ autoplayBlocked: true }); h.video.currentTime = 63;
  const first = h.run('selectAudioTrack(3)'); await flush(); h.metadata(); h.video.dispatch('error'); await first;
  assert.equal(h.video.src, 'https://example.test/original.mp4'); assert.equal(h.current.audio.actual, 1);
  assert.match(h.current.audio.error, /previous audio/);
  h.metadata(); assert.equal(h.video.currentTime, 63);
  h.video.paused = false;
  const retryButton = h.$('#sync-menu').querySelectorAll('button').find(b => b.textContent === '' && b.children.includes('Retry'));
  assert.ok(retryButton && !retryButton.hidden);
  const retry = retryButton.click(); await flush(); h.metadata(); h.canplay(); await retry;
  assert.equal(h.current.audio.actual, 3); assert.equal(h.video.currentTime, 63); assert.equal(h.video.paused, true);
  assert.equal(h.current.audio.error, '');
});

test('single-track files hide Audio, downloads support it, and party/casting suppress requests', async () => {
  const h = harness({ kind: 'dl' }); assert.equal(h.$('#sync-btn').hidden, false);
  h.context.audioInfo = { ...info, tracks: [tracks[0]] }; h.run('installAudioMetadata(current, audioInfo)');
  assert.equal(h.$('#sync-btn').hidden, true);
  h.context.audioInfo = info; h.run('installAudioMetadata(current, audioInfo)');
  h.context.party = {}; h.run('renderAudioControls()'); assert.equal(h.$('#sync-btn').hidden, true);
  await h.run('selectAudioTrack(3)'); assert.equal(h.calls.filter(c => c[0] === 'api').length, 0);
  h.context.party = null; h.video.webkitCurrentPlaybackTargetIsWireless = true;
  h.run('renderAudioControls()'); assert.equal(h.$('#sync-btn').hidden, true);
});

test('closed playback and an older metadata refresh cannot overtake a newer choice', async () => {
  const pending = deferred(); const h = harness({ request: () => pending.promise });
  const selection = h.run('selectAudioTrack(3)'); await flush();
  h.context.old = h.current; h.context.current = null; h.run('resetAudioSelection(old)');
  pending.resolve(ready(3)); await selection;
  assert.equal(h.video.src, 'https://example.test/original.mp4');
  const meta = deferred(); const h2 = harness({ request: path => path.includes('/audio?') ? meta.promise : ready(2) });
  const refresh = h2.run('refreshAudioMetadata(current)');
  const newer = h2.run('selectAudioTrack(2)'); await flush(); h2.metadata(); h2.canplay(); await newer;
  meta.resolve({ ...info, audioSource: 'new-default-file' }); await refresh;
  assert.equal(h2.current.audio.source, info.audioSource); assert.equal(h2.current.audio.actual, 2);
});

test('an older automatic compatibility completion cannot overwrite selected audio', async () => {
  const h = harness(); const selection = h.run('selectAudioTrack(3)'); await flush(); h.metadata(); h.canplay(); await selection;
  vm.runInContext(between('function switchToFixedAudio(', '// Safari tints'), h.context);
  h.run("switchToFixedAudio(current, 'Audio fixed')");
  assert.equal(h.video.src, ready(3).url);
});

test('a stale-source response reloads track metadata, and its late refresh cannot erase a newer selection', async () => {
  const metadata = deferred();
  const h = harness({ request: path => {
    if (path.includes('audio=3&')) throw Object.assign(Error('Changed source'), { status: 409 });
    if (path.includes('/audio?')) return metadata.promise;
    return ready(2);
  } });
  const first = h.run('selectAudioTrack(3)'); await flush();
  const newer = h.run('selectAudioTrack(2)'); await flush(); h.metadata(); h.canplay(); await newer;
  metadata.resolve({ ...info, audioSource: 'replacement-base' }); await first;
  assert.equal(h.current.audio.actual, 2); assert.equal(h.current.audio.error, '');
  const changed = harness({ request: path => path.includes('/audio?') ? { ...info, audioSource: 'replacement-base' } : Promise.reject(Object.assign(Error('Changed source'), { status: 409 })) });
  await changed.run('selectAudioTrack(3)');
  assert.equal(changed.current.audio.source, 'replacement-base');
  assert.equal(changed.current.audio.actual, null);
  assert.equal(changed.current.audio.sourceMatches, false);
  assert.match(changed.current.audio.error, /Choose a track again/);
  assert.equal(changed.video.src, 'https://example.test/original.mp4');
});


test('repeated fallback choices can switch back from a one-track rendition without native mapping', async () => {
  const h = harness({ request: path => path.includes('audio=') ? ready(3) : { ready: true, url: 'https://example.test/original.mp4' } });
  const first = h.run('selectAudioTrack(3)'); await flush(); h.metadata(); h.canplay(); await first;
  assert.equal(h.current.audio.usingFallback, true);
  h.video.currentTime = .4; h.video.paused = true;
  // The default track is the file itself: straight back to it, no copy to prepare.
  const second = h.run('selectAudioTrack(1)'); await flush(); h.metadata(); h.canplay(); await second;
  assert.equal(h.current.audio.actual, 1);
  assert.equal(h.current.audio.usingFallback, false);
  assert.ok(!h.calls.filter(c => c[0] === 'api').at(-1)[1].includes('audio='));
  assert.equal(h.video.src, 'https://example.test/original.mp4');
  assert.equal(h.video.currentTime, .4);
  assert.equal(h.video.paused, true);
});


test('initial metadata reflects a verified native language already chosen by the operating system', () => {
  const native = nativeTracks(); native[0].enabled = false; native[2].enabled = true;
  const h = harness({ native });
  assert.equal(h.current.audio.actual, 3);
  assert.equal(h.$('#sync-btn').getAttribute('aria-label'), 'Audio: English');
});

test('failed audio preparation restores automatic ownership and resumes compatibility polling', async () => {
  const h = harness({ request: () => { throw Error('temporary failure'); } });
  await h.run('selectAudioTrack(3)');
  assert.equal(h.current.audio.actual, 1);
  assert.equal(h.current.audio.userChoice, false);
  assert.equal(h.calls.filter(c => c[0] === 'compatibility').length, 1);
});

test('source-load failure resumes automatic correction, but a failed replacement retains an explicit choice', async () => {
  const automatic = harness();
  const selection = automatic.run('selectAudioTrack(3)'); await flush();
  automatic.video.dispatch('error'); await selection;
  assert.equal(automatic.current.audio.userChoice, false);
  assert.equal(automatic.calls.filter(c => c[0] === 'compatibility').length, 1);

  const explicit = harness();
  const first = explicit.run('selectAudioTrack(3)'); await flush(); explicit.metadata(); explicit.canplay(); await first;
  const replacement = explicit.run('selectAudioTrack(2)'); await flush();
  explicit.video.dispatch('error'); await replacement;
  assert.equal(explicit.current.audio.actual, 3);
  assert.equal(explicit.current.audio.userChoice, true);
  assert.equal(explicit.calls.filter(c => c[0] === 'compatibility').length, 0);
});

test('cancelling a superseded preparation keeps the committed ownership for the replacement failure', async () => {
  const old = deferred();
  const h = harness({ request: path => path.includes('audio=3&') ? old.promise : Promise.reject(Error('temporary failure')) });
  const first = h.run('selectAudioTrack(3)'); await flush();
  await h.run('selectAudioTrack(2)');
  old.resolve(ready(3)); await first;
  assert.equal(h.current.audio.actual, 1);
  assert.equal(h.current.audio.userChoice, false);
  assert.equal(h.calls.filter(c => c[0] === 'compatibility').length, 1);
});

test('resumed compatibility polling installs a correction that finished during the failed selection', async () => {
  let polls = 0;
  const h = harness({ request: path => {
    if (!path.includes('/audio?')) throw Error('temporary selection failure');
    return { ...info, known: true, aligned: true, videoSafe: true, fixable: true, codec: 'ac3', browserSafe: ++polls > 1 };
  } });
  h.context.CODEC_NAMES = { ac3: 'Dolby Digital' };
  const switched = [];
  h.context.switchToFixedAudio = session => switched.push(session);
  vm.runInContext(between('async function watchAudio(', '\nfunction switchToFixedAudio('), h.context);
  const originalWatcher = h.run('watchAudio(current, current)'); await flush();
  assert.equal(h.current.compatibilityPending, true);
  await h.run('selectAudioTrack(3)'); await flush();
  assert.equal(switched.length, 1);
  assert.equal(switched[0], h.current);
  h.tick(3000); await originalWatcher;
});

test('a copy still being made bridges at once to the live stream in that language, then moves to full quality', async () => {
  let prepared = false;
  const bridgeUrl = 'https://example.test/play/lib/episode/phone1080-a5/1/sig/index.m3u8';
  const h = harness({ bridge: true, request: path => path.includes('bridge=1') ? { ready: true, bridge: true, url: bridgeUrl, track: 3, audioSource: info.audioSource }
    : prepared ? ready(3) : { ready: false, state: 'preparing' } });
  h.video.currentTime = 50;
  const selection = h.run('selectAudioTrack(3)'); await flush(); await flush();
  assert.equal(h.video.src, bridgeUrl);
  h.metadata(); h.canplay(); await flush();
  assert.equal(h.current.audio.actual, 3); assert.equal(h.current.audio.upgrading, 3); assert.equal(h.current.audio.pending, null);
  assert.equal(h.video.currentTime, 50); assert.equal(h.current.bridge.track, 3);
  assert.match(h.run('audioMessage.textContent'), /up to 1080p/);
  // Choosing the playing language again keeps waiting for full quality instead of cancelling.
  const again = h.run('selectAudioTrack(3)'); await flush(); await selection;
  assert.equal(h.current.audio.upgrading, 3); assert.equal(h.video.src, bridgeUrl);
  h.video.currentTime = 80;
  prepared = true; h.tick(1000); await flush(); await flush();
  assert.equal(h.video.src, ready(3).url); assert.equal(h.current.bridge, null);
  h.metadata(); h.canplay(); await flush(); await again;
  assert.equal(h.current.audio.actual, 3); assert.equal(h.current.audio.upgrading, null);
  assert.equal(h.video.currentTime, 80);
  assert.equal(h.calls.filter(c => c[0] === 'api' && c[1].includes('bridge=1')).length, 1);
});

test('a bridge that fails to start puts the old source back and the wait goes on', async () => {
  let prepared = false;
  const h = harness({ bridge: true, request: path => path.includes('bridge=1') ? { ready: true, url: 'https://example.test/live.m3u8', track: 3, audioSource: info.audioSource }
    : prepared ? ready(3) : { ready: false } });
  h.video.currentTime = 30;
  const selection = h.run('selectAudioTrack(3)'); await flush(); await flush();
  h.video.dispatch('error'); await flush();
  assert.equal(h.video.src, 'https://example.test/original.mp4'); assert.equal(h.current.audio.pending, 3);
  h.metadata(); assert.equal(h.video.currentTime, 30);
  prepared = true; h.tick(1000); await flush(); h.metadata(); h.canplay(); await selection;
  assert.equal(h.current.audio.actual, 3); assert.equal(h.video.src, ready(3).url);
});

test('the same audio is found again in a converted copy by language, codec and channels', () => {
  const converted = [{ index: 1, audioIndex: 0, language: 'ita', codec: 'aac', channels: 2, title: 'Stereo' },
    { index: 2, audioIndex: 1, language: 'ita', codec: 'ac3', channels: 6 }, { index: 3, audioIndex: 2, language: 'eng', codec: 'ac3', channels: 6 }];
  assert.equal(sameAudio({ index: 2, audioIndex: 1, language: 'eng', codec: 'ac3', channels: 6 }, converted).index, 3);
  assert.equal(sameAudio({ index: 1, audioIndex: 0, language: 'ita', codec: 'ac3', channels: 6 }, converted).index, 2);
  assert.equal(sameAudio({ index: 1, audioIndex: 0, language: 'fre', codec: 'ac3', channels: 6 }, converted), null);
});
