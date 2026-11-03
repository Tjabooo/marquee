import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.events = {}; this.disabled = false; this.style = {}; this.classList = { toggle() {} }; }
  append(c) { this.children.push(c); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(k, v) { this.attrs[k] = v; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(k, cb) { this.events[k] = cb; }
  querySelectorAll() { return []; }
  get textContent() { return this.children.map(c => c instanceof Element ? c.textContent : c).join(' '); }
  set textContent(value) { this.children = [value]; }
}
const create = ({ existing = false, fail = false } = {}) => {
  const nodes = new Map();
  const $ = (selector) => { if (!nodes.has(selector)) nodes.set(selector, new Element('div')); return nodes.get(selector); };
  const calls = [];
  const stack = [];
  const context = vm.createContext({ Node: Element, document: { createElement: (tag) => new Element(tag) }, $, AbortSignal,
    party: null, current: existing ? { id: 'old' } : null, watchClient: 'test-client-123456',
    api: async (url) => {
      calls.push(url);
      if (url.endsWith('/preview')) return { media: { title: 'Movie' }, host: 'Family' };
      if (url.endsWith('/join') && fail) throw Error('Connection lost');
      return { token: 'a'.repeat(24), media: { id: 'movie', kind: 'lib' } };
    },
    toast: (text) => calls.push(text), jsonPost: (body) => ({ body }), episodeLabel: () => '',
    pushOverlay: (close) => stack.push(close), showSheet: (_, __, closed) => () => closed?.(),
    closeTopOverlay: () => { throw Error('Unawaited browser-back would close the new player'); },
    dismissTopOverlay: async () => { calls.push('dismiss'); stack.pop()?.(); },
    openPlayer: async (_, opts) => { calls.push(opts); if (opts.replace) stack.pop()?.(); },
  });
  const builder = source.slice(source.indexOf('function h('), source.indexOf('const ICONS ='));
  const offer = source.slice(source.indexOf('async function offerWatchRoom('), source.indexOf('function setWatchPanel('));
  vm.runInContext(builder + offer, context);
  if (existing) stack.push(() => { context.current = null; });
  return { context, calls, nodes, stack, $ };
};

test('joining replaces the invite directly instead of racing browser-back against a new player', async () => {
  const { context, calls, $ } = create();
  await vm.runInContext(`offerWatchRoom('${'a'.repeat(24)}')`, context);
  const join = $('#picker-body').children.find((c) => c.tag === 'button');
  await join.events.click();
  assert.equal(calls.find((c) => typeof c === 'object').replace, true);
  assert.equal(join.disabled, false, 'Join button is restored in every completed path');
  assert.equal(join.attrs['aria-busy'], undefined);
});

test('failed joins show a retryable error and never leave the button disabled', async () => {
  const { context, calls, $ } = create({ fail: true });
  await vm.runInContext(`offerWatchRoom('${'a'.repeat(24)}')`, context);
  const body = $('#picker-body'); const join = body.children.find((c) => c.tag === 'button');
  await join.events.click(); await join.events.click();
  assert.equal(join.disabled, false); assert.equal(join.textContent, 'Join and watch');
  assert.ok(body.children.some((c) => c.textContent === 'Connection lost'));
  assert.equal(calls.filter((c) => typeof c === 'string' && c.endsWith('/join')).length, 2);
});

test('an existing player waits for dismissal before opening the invited title', async () => {
  const { context, calls, $ } = create({ existing: true });
  await vm.runInContext(`offerWatchRoom('${'a'.repeat(24)}')`, context);
  await $('#picker-body').children.find((c) => c.tag === 'button').events.click();
  assert.equal(calls.filter((c) => c === 'dismiss').length, 2, 'Invite and previous player both finish closing');
  assert.ok(calls.indexOf('dismiss') < calls.findIndex((c) => typeof c === 'object'));
});

test('blocked guests can press Play to unlock their browser; ordinary guest playback stays host-controlled', () => {
  const nodes = new Map(); const $ = (selector) => { if (!nodes.has(selector)) nodes.set(selector, new Element('button')); return nodes.get(selector); };
  const play = new Element('button'); let unlocks = 0;
  const context = vm.createContext({ $, party: { isHost: false, blocked: true, connected: true, online: true,
    state: { host: 'host', intentPlaying: false, playing: false, waitingFor: [], members: [] }, unlock: () => unlocks++ },
    watchPanelOpen: false, current: { kind: 'lib', id: 'movie' }, state: { library: [] }, mediaId: (f) => f.id,
    playerEl: new Element('div'), playBtns: [play], airplayBtn: new Element('button'), audioBtn: new Element('button'), seekEl: new Element('div'), updatePlayState() {}, updateUpNext() {}, cancelAudioIntent() {}, renderAudioControls() {},
  });
  vm.runInContext(source.slice(source.indexOf('function renderParty()'), source.indexOf('function leaveWatchRoom(')), context);
  vm.runInContext(source.slice(source.indexOf('function togglePlay('), source.indexOf('function updatePlayState(')), context);
  vm.runInContext('renderParty()', context);
  assert.equal(play.disabled, false); assert.equal($('#watch-bar').hidden, true);
  vm.runInContext('togglePlay()', context); assert.equal(unlocks, 1);
  vm.runInContext('watchPanelOpen = true; renderParty()', context); assert.equal($('#watch-bar').hidden, false);
  vm.runInContext('party.blocked = false; renderParty()', context); assert.equal(play.disabled, true);
});

test('dismissal waits for the browser popstate before a new player can be pushed', async () => {
  const win = new EventTarget(); let closed = 0;
  const context = vm.createContext({ window: win, setTimeout, clearTimeout, renderUpdatedLibrary() {},
    history: { pushState() {}, replaceState() {}, back() { setImmediate(() => win.dispatchEvent(new Event('popstate'))); } },
    closed: () => closed++,
  });
  const start = source.indexOf('const overlayStack =');
  const end = source.indexOf("document.addEventListener('keydown'", start);
  vm.runInContext(source.slice(start, end), context);
  vm.runInContext('pushOverlay(closed)', context);
  const pending = vm.runInContext('dismissTopOverlay()', context);
  assert.equal(closed, 0, 'Browser-back has not completed synchronously');
  await pending;
  assert.equal(closed, 1);
  assert.equal(vm.runInContext('overlayStack.length', context), 0);
});
