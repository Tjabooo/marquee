import test from 'node:test';
import assert from 'node:assert/strict';
import { createStills } from '../public/note-stills.js';

function fakeVideo() {
  const listeners = {}, attrs = {};
  const video = {
    videoWidth: 0, videoHeight: 0, seeking: false, isConnected: true, loads: 0, swappedFor: null,
    set src(v) { attrs.src = v; }, get src() { return attrs.src; },
    hasAttribute: (k) => k in attrs, removeAttribute: (k) => { delete attrs[k]; },
    load() { video.loads++; }, replaceWith(el) { video.swappedFor = el; },
    addEventListener: (type, fn) => { listeners[type] = fn; }, fire: (type) => listeners[type]?.(),
  };
  return video;
}
function setup({ draw = () => {} } = {}) {
  let callback; const observed = new Set();
  class Observer {
    constructor(cb) { callback = cb; }
    observe(v) { observed.add(v); }
    unobserve(v) { observed.delete(v); }
  }
  const doc = { createElement: () => ({ getContext: () => ({ drawImage: draw }), setAttribute() {} }) };
  const show = createStills({ Observer, doc });
  return { show, observed, scroll: (target, isIntersecting) => callback([{ target, isIntersecting }]) };
}

test('an off-screen video is never requested', () => {
  const { show } = setup(); const v = fakeVideo();
  show(v, '/f?view=1#t=0.1');
  assert.equal(v.hasAttribute('src'), false);
});

test('it loads on screen, and scrolling away first drops the download', () => {
  const { show, scroll } = setup(); const v = fakeVideo();
  show(v, '/f');
  scroll(v, true); assert.equal(v.src, '/f');
  scroll(v, false); assert.equal(v.hasAttribute('src'), false); assert.equal(v.loads, 1);
  scroll(v, true); assert.equal(v.src, '/f');
});

test('the frame moves to a canvas and the video lets go of the file', () => {
  const { show, scroll, observed } = setup(); const v = fakeVideo();
  show(v, '/f'); scroll(v, true);
  Object.assign(v, { videoWidth: 3840, videoHeight: 2160 });
  v.fire('loadeddata');
  assert.deepEqual([v.swappedFor.width, v.swappedFor.height], [1280, 720]);
  assert.equal(v.hasAttribute('src'), false);
  assert.equal(observed.has(v), false);
});

test('it waits for the #t= seek before taking the frame', () => {
  const { show, scroll } = setup(); const v = fakeVideo();
  show(v, '/f'); scroll(v, true);
  Object.assign(v, { videoWidth: 640, videoHeight: 360, seeking: true });
  v.fire('loadeddata'); assert.equal(v.swappedFor, null);
  v.seeking = false; v.fire('seeked');
  assert.deepEqual([v.swappedFor.width, v.swappedFor.height], [640, 360]);
});

test('a video this browser can\'t play is not retried on every scroll', () => {
  const { show, scroll, observed } = setup(); const v = fakeVideo();
  show(v, '/f'); scroll(v, true);
  v.fire('error');
  assert.equal(observed.has(v), false);
});

test('if the frame can\'t be drawn the video stays', () => {
  const { show, scroll } = setup({ draw: () => { throw new Error('tainted'); } }); const v = fakeVideo();
  show(v, '/f'); scroll(v, true);
  Object.assign(v, { videoWidth: 640, videoHeight: 360 });
  v.fire('loadeddata');
  assert.equal(v.swappedFor, null); assert.equal(v.hasAttribute('src'), true);
});

test('without IntersectionObserver it loads straight away', () => {
  const show = createStills({ Observer: null, doc: {} }); const v = fakeVideo();
  show(v, '/f');
  assert.equal(v.src, '/f');
});
