import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

test('carousel arrows move both ways, respect reduced motion and disable at the ends', async () => {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.events = {}; this.style = {}; this.scrollLeft = 0; this.clientWidth = 340; this.scrollWidth = 1600; }
    append(child) { this.children.push(child); }
    setAttribute(k, v) { this.attrs[k] = v; if (k === 'disabled') this.disabled = true; }
    addEventListener(k, cb) { this.events[k] = cb; }
    scrollBy(opts) { this.lastMove = opts; this.scrollLeft = Math.max(0, Math.min(this.scrollWidth - this.clientWidth, this.scrollLeft + opts.left)); this.events.scroll?.(); }
  }
  let reduced = false;
  let observer;
  const controller = new AbortController();
  const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const builder = source.slice(source.indexOf('function h('), source.indexOf('const ICONS ='));
  const code = source.slice(source.indexOf('function carousel('), source.indexOf('function row('));
  const create = vm.runInNewContext(builder + code + '\ncarousel', {
    Node: Element, document: { createElement: (tag) => new Element(tag) }, icon: () => new Element('svg'),
    matchMedia: () => ({ matches: reduced }), searchCtrl: controller,
    requestAnimationFrame: (cb) => cb(),
    ResizeObserver: class { constructor(cb) { observer = this; this.cb = cb; } observe() {} disconnect() { this.disconnected = true; } },
  });
  const list = new Element('ul');
  const section = create('Trending this week', list);
  const controls = section.children[0].children[1];
  const [prev, next] = controls.children.filter((c) => c instanceof Element);
  assert.equal(prev.attrs['aria-label'], 'Previous in Trending this week');
  assert.equal(next.attrs['aria-label'], 'Next in Trending this week');
  assert.equal(prev.disabled, true); assert.equal(next.disabled, false);
  next.events.click(); assert.ok(list.scrollLeft > 0); assert.equal(prev.disabled, false); assert.equal(list.lastMove.behavior, 'smooth');
  reduced = true;
  prev.events.click(); assert.equal(list.scrollLeft, 0); assert.equal(list.lastMove.behavior, 'instant');
  for (let i = 0; i < 10; i++) next.events.click();
  assert.equal(next.disabled, true); assert.equal(prev.disabled, false);
  list.scrollWidth = 200; list.scrollLeft = 0; observer.cb();
  assert.equal(prev.disabled, true); assert.equal(next.disabled, true, 'No scrolling when everything fits');
  assert.equal(prev.hidden, true); assert.equal(next.hidden, true, 'Arrows hide when everything fits');
  list.scrollWidth = 1600; observer.cb(); assert.equal(next.hidden, false, 'Arrows come back when it overflows again');
  controller.abort(); assert.equal(observer.disconnected, true);

  // Library shelves (Continue watching) carry their own classes and outlive Discover searches.
  const shelf = create('Continue watching', new Element('ul'), null, 'library-shelf continue-shelf');
  assert.equal(shelf.className, 'shelf carousel library-shelf continue-shelf');
  const libraryObserver = observer;
  controller.abort(); assert.equal(libraryObserver.disconnected, undefined);
});
