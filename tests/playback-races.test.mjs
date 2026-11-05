import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
};

function subtitles() {
  const requests = [], tracks = [], messages = [];
  const context = vm.createContext({ current: {}, subtitleGeneration: 0, secondGeneration: 0, ccActive: null, ccSecond: null, ccSync: null, ccSyncTimer: null,
    localStorage: { setItem() {} }, mediaId: () => 'example', jsonPost: value => value,
    closeCcMenu() {}, applySubModes() {}, renderCcMenu() {}, watchSubSync() {}, clearTimeout() {},
    toast: message => messages.push(message), api: () => { const request = deferred(); requests.push(request); return request.promise; },
    video: { append: track => tracks.push(track), querySelectorAll: () => [...tracks] },
    h: (tag, attrs) => ({ tag, ...attrs, addEventListener() {}, getAttribute(k) { return this[k]; }, remove() { tracks.splice(tracks.indexOf(this), 1); } }),
  });
  vm.runInContext(between('function clearSubTracks(', 'function closeCcMenu('), context);
  vm.runInContext(between('async function pickPlayerSub(', '// ---- audio compatibility ----'), context);
  return { context, requests, tracks, messages,
    pick: code => { context.choice = { code, name: code || 'Off' }; return vm.runInContext("pickPlayerSub({kind:'lib'},current,choice)", context); },
  };
}

test('selecting subtitle Off invalidates an in-flight language fetch', async () => {
  const h = subtitles();
  const pending = h.pick('en'); await h.pick(null);
  h.requests[0].resolve({ url: '/example.en.vtt' }); await pending;
  assert.equal(h.context.ccActive, null);
  assert.equal(h.tracks.length, 0);
});

test('the newest subtitle language wins regardless of response order', async () => {
  const h = subtitles();
  const english = h.pick('en'), swedish = h.pick('sv');
  h.requests[1].resolve({ url: '/example.sv.vtt' }); await swedish;
  h.requests[0].resolve({ url: '/example.en.vtt' }); await english;
  assert.equal(h.context.ccActive, 'sv');
  assert.deepEqual(h.tracks.map(track => track.srclang), ['sv']);
});

test('Off also hides the second language, and picking the second as the first moves it', async () => {
  const h = subtitles();
  const english = h.pick('en'); h.requests[0].resolve({ url: '/example.en.vtt' }); await english;
  h.tracks.push({ srclang: 'sv', getAttribute(k) { return this[k]; }, remove() { h.tracks.splice(h.tracks.indexOf(this), 1); } });
  h.context.ccSecond = 'sv';
  const swedish = h.pick('sv'); h.requests[1].resolve({ url: '/example.sv.vtt' }); await swedish;
  assert.equal(h.context.ccActive, 'sv');
  assert.equal(h.context.ccSecond, null);
  assert.deepEqual(h.tracks.map(track => track.srclang), ['sv']);
  h.tracks.push({ srclang: 'en', getAttribute(k) { return this[k]; }, remove() { h.tracks.splice(h.tracks.indexOf(this), 1); } });
  h.context.ccSecond = 'en';
  await h.pick(null);
  assert.equal(h.context.ccSecond, null);
  assert.equal(h.tracks.length, 0);
});

test('a superseded subtitle failure does not replace the new selection with an error', async () => {
  const h = subtitles();
  const pending = h.pick('en'); await h.pick(null);
  const count = h.messages.length;
  h.requests[0].reject(Error('temporary failure')); await pending;
  assert.equal(h.messages.length, count);
});

test('a timing response from an earlier selection cannot overwrite a reselected language', async () => {
  const h = subtitles();
  vm.runInContext(between('async function watchSubSync(', '// Swaps the track'), h.context);
  h.context.ccActive = 'en';
  const pending = vm.runInContext("watchSubSync({kind:'lib'},current,{code:'en'})", h.context);
  await h.pick(null);
  const selected = h.pick('en'); h.requests[1].resolve({ url: '/example.en.vtt' }); await selected;
  // pickPlayerSub starts a new timing request, which is still pending.
  h.requests[0].resolve({ state: 'failed', error: 'old result' }); await pending;
  assert.equal(h.context.ccSync, null);
});

function casting() {
  const requests = [], swaps = [];
  const button = { hidden: false, classList: { remove() {} } };
  const context = vm.createContext({ current: { kind: 'lib', browserName: 'browser.mp4' }, party: null,
    castGeneration: 0, onTvVersion: false, hasAirPlay: true, hasRemotePlayback: false,
    cancelAudioIntent() {}, renderAudioControls() {}, refreshAudioMetadata() {}, mediaId: () => 'example',
    $: () => ({ textContent: '', hidden: false }), airplayBtn: button,
    api: () => { const request = deferred(); requests.push(request); return request.promise; },
    swapSource: url => swaps.push(url),
  });
  vm.runInContext(between('function resetCasting(', '// Only the current source'), context);
  vm.runInContext(between('async function onWireless(', '\nconst ccBtn ='), context);
  return { context, requests, swaps, wireless: on => vm.runInContext(`onWireless(${on})`, context) };
}
const tvLink = { ext: 'mp4', name: 'original.mp4', url: '/original.mp4' };

test('disconnecting AirPlay invalidates a pending connect response before an early return', async () => {
  const h = casting();
  const pending = h.wireless(true); await h.wireless(false);
  h.requests[0].resolve(tvLink); await pending;
  assert.deepEqual(h.swaps, []);
  assert.equal(h.context.onTvVersion, false);
});

test('resetting casting invalidates a response from the previous playback state', async () => {
  const h = casting();
  const pending = h.wireless(true);
  vm.runInContext('resetCasting()', h.context);
  h.requests[0].resolve(tvLink); await pending;
  assert.deepEqual(h.swaps, []);
});

test('a current AirPlay connection still installs its TV source', async () => {
  const h = casting();
  const pending = h.wireless(true);
  h.requests[0].resolve(tvLink); await pending;
  assert.deepEqual(h.swaps, [tvLink.url]);
  assert.equal(h.context.onTvVersion, true);
});
