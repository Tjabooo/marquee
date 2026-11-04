import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const builder = source.slice(source.indexOf('function h('), source.indexOf('const ICONS ='));
const titleEditor = source.slice(source.indexOf('function inlineName('), source.indexOf('function clipCard('));

// A small event-capable DOM: removing a focused input fires blur just as a real browser does.
function fixture(respond = async (body) => ({ title: body.title }), person = false) {
  let document;
  class Element {
    constructor(tag) {
      this.tag = tag; this.children = []; this.attrs = {}; this.events = new Map(); this.style = {};
      this.classList = { add: () => {}, toggle: () => {} };
    }
    append(...children) { for (const child of children) { this.children.push(child); if (child instanceof Element) child.parent = this; } }
    replaceChildren(...children) {
      const focused = document.activeElement;
      if (focused && this.children.some((child) => child instanceof Element && child.contains(focused))) {
        document.activeElement = null; focused.fire('blur');
      }
      this.children = []; this.append(...children);
    }
    setAttribute(key, value) { this.attrs[key] = String(value); if (key === 'value' || key === 'id') this[key] = String(value); }
    removeAttribute(key) { delete this.attrs[key]; }
    addEventListener(key, callback, opts = {}) { const list = this.events.get(key) || []; list.push({ callback, once: opts?.once }); this.events.set(key, list); }
    removeEventListener(key, callback) { this.events.set(key, (this.events.get(key) || []).filter((event) => event.callback !== callback)); }
    fire(key, props = {}) {
      for (const event of (this.events.get(key) || []).slice()) {
        if (event.once) this.removeEventListener(key, event.callback);
        event.callback({ target: this, currentTarget: this, preventDefault() {}, ...props });
      }
      // Browsers dispatch events synchronously without awaiting promises from listeners.
      return Promise.resolve();
    }
    contains(node) { return node === this || this.children.some((child) => child instanceof Element && child.contains(node)); }
    closest() { return null; }
    getBoundingClientRect() { return { height: 48 }; }
    insertAdjacentHTML() {}
    focus() { document.activeElement = this; }
    select() {}
    get textContent() { return this.children.map((child) => child instanceof Element ? child.textContent : child).join(' '); }
    set textContent(text) { this.children = [text]; }
  }
  document = new Element('document'); document.activeElement = null; document.createElement = (tag) => new Element(tag);
  const clip = { id: 'testclip12345678', title: 'An original two-line title' }, calls = [], messages = [];
  const context = vm.createContext({ document, Node: Element, setTimeout,
    state: { clips: { clips: [clip] }, access: { names: {} }, me: { id: 3, name: 'Original' }, people: [{ id: 3, name: 'Original' }], activity: { people: [{ user: 'viewer@example.test', name: 'Original' }], events: [] } }, jsonPost: (body) => body, toast: (message) => messages.push(message),
    api: async (url, body) => { calls.push({ url, body }); return respond(body); },
  });
  vm.runInContext(builder + titleEditor + source.slice(source.indexOf('function accessName('), source.indexOf('function accessSection(')), context);
  const wrap = person ? context.accessName('viewer@example.test', 'Original') : context.clipTitle(clip);
  const edit = async () => { await wrap.children[0].fire('click'); return { form: wrap.children[0], input: wrap.children[0].children[0] }; };
  return { wrap, edit, clip, calls, messages, document, Element, state: context.state };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('blur saves once, leaves outside focus alone, and the editor has no action buttons', async () => {
  let resolve;
  const f = fixture(() => new Promise((done) => { resolve = done; }));
  const { input, form } = await f.edit();
  assert.deepEqual(form.children.map((child) => child.tag), ['input', 'p']);
  input.value = '  A new title  ';
  const outside = new f.Element('button'); outside.focus();
  await input.fire('blur'); await input.fire('blur'); await form.fire('submit');
  assert.equal(f.calls.length, 1); assert.equal(input.readOnly, true);
  assert.equal(f.calls[0].body.title, 'A new title');
  assert.equal(f.calls[0].body.previousTitle, 'An original two-line title');
  resolve({ title: 'A new title' }); await settle();
  assert.equal(f.clip.title, 'A new title'); assert.equal(f.document.activeElement, outside);
  assert.equal(f.wrap.children[0].tag, 'button');
});

test('Escape settles before removal-triggered blur and unchanged normalized names send no request', async () => {
  const f = fixture(); let { input } = await f.edit(); input.value = 'Discard this';
  await input.fire('keydown', { key: 'Escape' }); await settle();
  assert.equal(f.calls.length, 0); assert.equal(f.clip.title, 'An original two-line title');
  assert.equal(f.document.activeElement, f.wrap.children[0]);
  ({ input } = await f.edit()); input.value = `  ${f.clip.title}  `;
  await input.fire('blur'); await settle();
  assert.equal(f.calls.length, 0); assert.equal(f.wrap.children[0].tag, 'button');
});

test('empty names and server failures retain editable drafts without stealing outside focus; Enter retries', async () => {
  let fails = true;
  const f = fixture(async (body) => { if (fails) throw Error('Try again'); return { title: body.title }; });
  const { input, form } = await f.edit(); const outside = new f.Element('button'); outside.focus();
  input.value = ' '; await input.fire('blur');
  assert.equal(f.calls.length, 0); assert.equal(input.attrs['aria-invalid'], 'true');
  assert.equal(f.document.activeElement, outside);
  input.value = 'My retained draft'; await input.fire('blur'); await settle();
  assert.equal(f.wrap.children[0], form); assert.equal(input.value, 'My retained draft');
  assert.equal(input.readOnly, false); assert.equal(form.children[1].textContent, 'Try again');
  assert.equal(f.document.activeElement, outside);
  fails = false; input.focus(); await input.fire('keydown', { key: 'Enter' }); await settle();
  assert.equal(f.calls.length, 2); assert.equal(f.clip.title, 'My retained draft');
  assert.equal(f.document.activeElement, f.wrap.children[0]);
});

test('IME Enter does not save and a pending Enter save cannot be cancelled or reclaim moved focus', async () => {
  let resolve;
  const f = fixture(() => new Promise((done) => { resolve = done; }));
  const { input } = await f.edit(); input.value = 'New name';
  await input.fire('keydown', { key: 'Enter', isComposing: true }); assert.equal(f.calls.length, 0);
  await input.fire('keydown', { key: 'Enter' }); await input.fire('keydown', { key: 'Escape' });
  const outside = new f.Element('button'); outside.focus();
  resolve({ title: 'New name' }); await settle();
  assert.equal(f.calls.length, 1); assert.equal(f.clip.title, 'New name'); assert.equal(f.document.activeElement, outside);
});

test('fast blur saves preserve the title geometry until the outside pointer click can finish', async () => {
  const f = fixture(); const { input } = await f.edit(); const outside = new f.Element('button');
  input.value = 'Short'; await f.document.fire('pointerdown', { target: outside }); outside.focus();
  await input.fire('blur'); await settle(); assert.equal(f.wrap.style.minHeight, '48px');
  assert.equal(f.wrap.children[0].tag, 'form', 'Even a taller saved title waits until the outside click completes');
  await f.document.fire('pointerup', { target: outside });
  await new Promise((resolve) => setTimeout(resolve, 5)); assert.equal(f.wrap.style.minHeight, '');
  assert.equal(f.wrap.children[0].tag, 'button');
});


test('access names use the clip editor, save the account name and synchronize local person labels', async () => {
  const f = fixture(async (body) => ({ user: { id: 3, name: body.name } }), true);
  assert.equal(f.wrap.children[0].attrs['aria-label'], 'Rename person: Original');
  const { input, form } = await f.edit();
  assert.equal(input.attrs.maxlength, '40');
  assert.deepEqual(form.children.map((child) => child.tag), ['input', 'p']);
  input.value = '  A new name  ';
  await input.fire('keydown', { key: 'Enter' }); await settle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, '/api/access/rename');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].body)), { email: 'viewer@example.test', name: 'A new name', previousName: 'Original' });
  assert.equal(f.state.access.names['viewer@example.test'], 'A new name');
  assert.equal(f.state.me.name, 'A new name');
  assert.equal(f.state.people[0].name, 'A new name');
  assert.equal(f.state.activity.people[0].name, 'A new name');
  assert.equal(f.wrap.children[0].textContent, 'A new name');
});

test('access name failures keep the draft, and Escape cancels without saving', async () => {
  const f = fixture(async () => { throw Error('Could not save'); }, true);
  const { input, form } = await f.edit();
  input.value = 'Draft'; await input.fire('blur'); await settle();
  assert.equal(f.wrap.children[0], form); assert.equal(input.value, 'Draft');
  assert.equal(form.children[1].textContent, 'Could not save');
  await input.fire('keydown', { key: 'Escape' }); await settle();
  assert.equal(f.calls.length, 1); assert.equal(f.wrap.children[0].textContent, 'Original');
});
