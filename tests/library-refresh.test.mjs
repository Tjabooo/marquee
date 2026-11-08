import { T as englishT } from '../public/i18n.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function harness({ view = 'library', request = async () => ({ items: [], shows: [], server: [] }) } = {}) {
  const logs = []; const listeners = new Map(); const timers = [];
  const body = { contains: () => false, querySelectorAll: () => [] };
  const context = vm.createContext({ T: englishT, AbortSignal,
    state: { view, status: { library: true, downloads: true }, library: [], server: [], libraryShows: [], libraryError: null,
      downloads: [], downloadsError: null, dlScope: 'mine', convert: null, sessions: [], me: {} },
    current: null, overlayStack: [],
    document: { hidden: false, activeElement: {}, addEventListener: (event, fn) => listeners.set(event, fn) },
    window: { scrollX: 12, scrollY: 456, scrollTo: (x, y) => logs.push(['scroll', x, y]), addEventListener: (event, fn) => listeners.set(event, fn) },
    $: key => key === '#library-body' ? body : { setAttribute() {} },
    api: (path, opts) => { logs.push(['request', path]); return request(path, opts); },
    updateUpNext: () => logs.push(['next']),
    applyVersion: (item) => item,
    renderLibrary: () => { logs.push(['render']); vm.runInContext('libraryRenderPending = false', context); },
    renderDownloads: () => logs.push(['downloads']),
    setTimeout: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.cancelled = true; },
  });
  vm.runInContext(between('let libraryRequest =', '\nasync function loadConvert()'), context);
  vm.runInContext(between('let downloadsRequest =', '\nfunction makeDlCard('), context);
  vm.runInContext(between('// Downloads claims completed files', '// ---------- overlays ----------'), context);
  return { context, logs, listeners, body, timers, run: code => vm.runInContext(code, context) };
}
const data = (items = []) => ({ items, shows: [], server: [] });

test('library requests coalesce and unchanged or reordered responses retain DOM and object identity', async () => {
  const pending = deferred(); let response = pending.promise;
  const h = harness({ request: () => response });
  const a = h.run('loadLibrary()'); const b = h.run('loadLibrary()');
  assert.equal(a, b); assert.equal(h.logs.filter(x => x[0] === 'request').length, 1);
  pending.resolve(data([{ id: 'a' }, { id: 'b' }])); await a; h.run('renderUpdatedLibrary()');
  const library = h.context.state.library;
  response = Promise.resolve(data([{ id: 'b' }, { id: 'a' }]));
  assert.equal(await h.run('loadLibrary()'), false); h.run('renderUpdatedLibrary()');
  assert.equal(h.context.state.library, library);
  assert.equal(h.logs.filter(x => x[0] === 'render').length, 1);
  assert.ok(h.logs.filter(x => x[0] === 'next').length >= 2, 'candidate selection follows refreshed metadata even without a DOM update');
});

test('visible library refresh reads completed downloads first and follows new files without converter changes', async () => {
  let items = [];
  const h = harness({ request: async path => {
    if (path === '/api/downloads') { items = [{ id: 'new-episode', converting: false }]; return { items: [{ hash: 'done', done: true, mine: true }] }; }
    return data(items);
  } });
  await h.run('refreshMediaLibrary()');
  assert.deepEqual(h.logs.filter(x => x[0] === 'request').map(x => x[1]), ['/api/downloads', '/api/library']);
  assert.equal(h.context.state.library[0].id, 'new-episode');
  assert.equal(h.logs.filter(x => x[0] === 'render').length, 1);
  await h.run('refreshMediaLibrary()');
  assert.equal(h.logs.filter(x => x[0] === 'render').length, 1, 'the next unchanged poll keeps focus and cards');
});

test('completion and disappearance refresh library in other views, without redrawing those views', async () => {
  let downloads = [{ hash: 'mine', done: true, mine: true }];
  const h = harness({ view: 'discover', request: async path => path === '/api/downloads' ? { items: downloads } : data([{ id: 'episode' }]) });
  h.context.state.downloads = [{ hash: 'mine', done: false, mine: true }];
  await h.run('refreshMediaLibrary()');
  assert.equal(h.context.state.library[0].id, 'episode');
  assert.equal(h.logs.filter(x => x[1] === '/api/library').length, 1);
  await h.run('refreshMediaLibrary()');
  assert.equal(h.logs.filter(x => x[1] === '/api/library').length, 1);
  downloads = []; await h.run('refreshMediaLibrary()');
  assert.equal(h.logs.filter(x => x[1] === '/api/library').length, 2);
  assert.equal(h.logs.filter(x => x[0] === 'render').length, 0);
  h.context.state.downloads = [{ hash: 'other', done: false, mine: false }];
  assert.equal(h.run('downloadsChangedLibrary(state.downloads, [])'), false);
});

test('mobile visibility and pageshow refresh coalesce, while a hidden page stays quiet', async () => {
  const h = harness({ request: async path => path === '/api/downloads' ? { items: [] } : data([{ id: 'fresh' }]) });
  h.context.document.hidden = true; h.listeners.get('visibilitychange')();
  assert.equal(h.logs.length, 0);
  h.context.document.hidden = false;
  h.listeners.get('visibilitychange')(); h.listeners.get('pageshow')({ persisted: true });
  await h.run('refreshMediaLibrary()');
  assert.equal(h.logs.filter(x => x[1] === '/api/downloads').length, 1);
  assert.equal(h.logs.filter(x => x[1] === '/api/library').length, 1);
  assert.equal(h.context.state.library[0].id, 'fresh');
});

test('changed library data preserves open overlays and restores focus and scroll when they close', async () => {
  const h = harness({ request: async () => data([{ id: 'new' }]) });
  const oldFocus = { getAttribute: () => 'play-existing' };
  const newFocus = { getAttribute: () => 'play-existing', focus: options => { h.logs.push(['focus', options.preventScroll]); } };
  let rendered = false;
  h.body.contains = element => element === oldFocus;
  h.body.querySelectorAll = () => rendered ? [newFocus] : [oldFocus];
  h.context.document.activeElement = oldFocus;
  h.context.overlayStack.push(() => {});
  const originalRender = h.context.renderLibrary;
  h.context.renderLibrary = () => { originalRender(); rendered = true; };
  await h.run('loadLibrary()'); h.run('renderUpdatedLibrary()');
  assert.equal(rendered, false); assert.equal(h.context.overlayStack.length, 1);
  h.context.overlayStack.pop(); h.run('renderUpdatedLibrary()');
  assert.equal(rendered, true);
  assert.ok(h.logs.some(x => x[0] === 'focus' && x[1] === true));
  assert.ok(h.logs.some(x => x[0] === 'scroll' && x[1] === 12 && x[2] === 456));
});

test('a late downloads response for the previous scope cannot overwrite the new scope', async () => {
  const mine = deferred(); const all = deferred();
  const h = harness({ request: path => path.includes('?all=1') ? all.promise : mine.promise });
  const old = h.run('loadDownloads()');
  h.context.state.dlScope = 'all';
  const fresh = h.run('loadDownloads()');
  all.resolve({ items: [{ hash: 'all', done: false, mine: false }] }); await fresh;
  mine.resolve({ items: [{ hash: 'mine', done: true, mine: true }] }); await old;
  assert.equal(h.context.state.downloads[0].hash, 'all');
});

test('byte progress polls patch cards without reading full library; partial-pack membership refreshes immediately', async () => {
  let downloads = [{ hash: 'pack', done: false, mine: true, progress: .1, libraryIds: [], episodes: [] }];
  const h = harness({ request: async path => path === '/api/downloads' ? { items: downloads } : data([{ id: 'ready' }]) });
  await h.run('refreshMediaLibrary()');
  const initialReads = h.logs.filter(x => x[1] === '/api/library').length;
  downloads = [{ ...downloads[0], progress: .2, speed: 8000 }];
  await h.run('refreshMediaLibrary()');
  assert.equal(h.logs.filter(x => x[1] === '/api/library').length, initialReads);
  downloads = [{ ...downloads[0], progress: .3, libraryIds: ['episode-2'], episodes: [{season: 1, episode: 2, available: true, libraryId: 'episode-2'}] }];
  await h.run('refreshMediaLibrary()');
  assert.equal(h.logs.filter(x => x[1] === '/api/library').length, initialReads + 1);
  h.run('libraryLastChecked = Date.now() - 30001');
  await h.run('refreshMediaLibrary()');
  assert.equal(h.logs.filter(x => x[1] === '/api/library').length, initialReads + 2, 'external filesystem additions still discovered on the bounded fallback');
});
