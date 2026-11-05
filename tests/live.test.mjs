import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as live from '../src/live.js';

function fakePage() {
  const res = new EventEmitter();
  Object.assign(res, { destroyed: false, writableEnded: false, writableLength: 0, lines: [],
    writeHead() {}, flushHeaders() {}, write(s) { this.lines.push(s); }, destroy() { this.destroyed = true; } });
  const req = { socket: { setNoDelay() {} } };
  const topics = () => res.lines.filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)).topic);
  return { req, res, topics, close: () => res.emit('close') };
}
const settle = () => new Promise((r) => setTimeout(r, 300));

test('changes map to topics; read-only checks and chunk uploads do not', () => {
  assert.deepEqual(live.topicFor('/api/library/delete-many'), { topic: 'library', audience: 'all' });
  assert.deepEqual(live.topicFor('/api/downloads/abc/delete'), { topic: 'library', audience: 'all' });
  assert.equal(live.topicFor('/api/library/delete-many-info'), null);
  assert.deepEqual(live.topicFor('/api/me/progress'), { topic: 'progress', audience: 'user' });
  assert.deepEqual(live.topicFor('/api/admin/notes/4/trash'), { topic: 'notes', audience: 'admin' });
  assert.equal(live.topicFor(`/api/admin/notes/uploads/${'a'.repeat(32)}`), null);
  assert.equal(live.topicFor('/api/watch'), null);
});

test('events reach the right pages, once per burst', async () => {
  const mine = fakePage(), myOtherTab = fakePage(), someoneElse = fakePage(), admin = fakePage();
  live.subscribe(mine.req, mine.res, { userId: 1, admin: false, tab: 'a' });
  live.subscribe(myOtherTab.req, myOtherTab.res, { userId: 1, admin: false, tab: 'b' });
  live.subscribe(someoneElse.req, someoneElse.res, { userId: 2, admin: false, tab: 'c' });
  live.subscribe(admin.req, admin.res, { userId: 3, admin: true, tab: 'd' });

  live.afterRequest('/api/library/delete', 200, { userId: 1, tab: 'a' });
  live.afterRequest('/api/library/delete', 200, { userId: 1, tab: 'a' });
  live.afterRequest('/api/me/progress', 200, { userId: 1, tab: 'a' });
  live.afterRequest('/api/admin/notes', 200, { userId: 3, tab: 'd' });
  live.afterRequest('/api/library/add', 403, { userId: 2, tab: 'c' });
  await settle();

  assert.deepEqual(mine.topics(), ['library']); // its own progress is already on screen
  assert.deepEqual(myOtherTab.topics().sort(), ['library', 'progress']);
  assert.deepEqual(someoneElse.topics(), ['library']);
  assert.deepEqual(admin.topics().sort(), ['library', 'notes']);

  for (const p of [mine, myOtherTab, someoneElse, admin]) p.close();
  assert.equal(live.connectedCount(), 0);
});
