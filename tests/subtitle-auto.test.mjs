import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findSidecar, isAutoSidecar, localLanguages, selectSubtitle } from '../src/subtitles.js';

const upload = (id, extra = {}) => ({ attributes: {
  language: 'sv', release: 'The.Odyssey.2026', files: [{ file_id: id, file_name: `sub${id}.srt` }], ...extra,
} });
const video = 'The.Odyssey.2026.1080p.BluRay.mp4';

test('subtitles by people beat an AI translation of the exact release', () => {
  const best = selectSubtitle([
    upload(1, { ai_translated: true, moviehash_match: true, release: 'The.Odyssey.2026.1080p.BluRay' }),
    upload(2, { release: 'The.Odyssey.2026.WEB' }),
  ], video, {}, 'sv');
  assert.equal(best.entry.file_id, 2);
});

test('an AI translation is still better than a file with only the odd line', () => {
  const best = selectSubtitle([upload(1, { foreign_parts_only: true }), upload(2, { machine_translated: true })], video, {}, 'sv');
  assert.equal(best.entry.file_id, 2);
});

function tempVideo(...sidecars) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilin-subs-'));
  const file = path.join(dir, 'Movie.mp4');
  fs.writeFileSync(file, '');
  for (const s of sidecars) fs.writeFileSync(path.join(dir, `Movie.${s}.srt`), '1\n00:00:01,000 --> 00:00:02,000\nHej\n');
  return { dir, file, name: (s) => path.join(dir, `Movie.${s}.srt`) };
}

test('an AI sidecar counts as its language, and any other file is preferred over it', () => {
  const v = tempVideo('sv.ai');
  assert.deepEqual([...localLanguages(v.file)], ['sv']);
  assert.equal(findSidecar(v.file, 'sv'), v.name('sv.ai'));
  assert.ok(isAutoSidecar(findSidecar(v.file, 'sv')));
  fs.writeFileSync(v.name('sv.sdh'), 'x');
  assert.equal(findSidecar(v.file, 'sv'), v.name('sv.sdh'));
  fs.writeFileSync(v.name('sv'), 'x');
  assert.equal(findSidecar(v.file, 'sv'), v.name('sv'));
  fs.rmSync(v.dir, { recursive: true, force: true });
});

// A fake OpenSubtitles: `uploads` is what exists; ai_translated=exclude hides the AI ones like the real API.
async function withApi(uploads, run) {
  const savedKey = process.env.OPENSUBTITLES_API_KEY;
  const savedFetch = globalThis.fetch;
  process.env.OPENSUBTITLES_API_KEY = 'test';
  const downloads = [];
  globalThis.fetch = async (url, opts) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/subtitles')) {
      const langs = (u.searchParams.get('languages') || '').split(',');
      const exclude = u.searchParams.get('ai_translated') === 'exclude';
      const data = uploads.filter((s) => langs.includes(s.attributes.language) && !(exclude && s.attributes.ai_translated));
      return { ok: true, status: 200, json: async () => ({ data }) };
    }
    if (u.pathname.endsWith('/download')) {
      const id = JSON.parse(opts.body).file_id;
      downloads.push(id);
      return { ok: true, status: 200, json: async () => ({ link: `https://dl.invalid/${id}`, remaining: 5 }) };
    }
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(`1\n00:00:01,000 --> 00:00:02,000\nfile ${u.pathname}\n`) };
  };
  try {
    return await run(downloads);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey == null) delete process.env.OPENSUBTITLES_API_KEY; else process.env.OPENSUBTITLES_API_KEY = savedKey;
  }
}

test('only AI online: saved with the .ai tag and labelled in the language list', async () => {
  const v = tempVideo();
  await withApi([upload(1, { ai_translated: true })], async () => {
    const subs = await import('../src/subtitles.js?auto-only');
    const before = await subs.languagesForFile(v.file, { title: 'Movie' });
    assert.deepEqual(before.languages, [{ code: 'sv', name: 'Swedish (auto-translated)', saved: false, auto: true }]);
    assert.equal(await subs.ensureSubtitle(v.file, { title: 'Movie' }, 'sv'), v.name('sv.ai'));
    assert.ok(fs.existsSync(v.name('sv.ai')));
    const after = await subs.languagesForFile(v.file, { title: 'Movie' });
    assert.deepEqual(after.languages, [{ code: 'sv', name: 'Swedish (auto-translated)', saved: true, auto: true }]);
    assert.deepEqual((await subs.languagesForTitle({ title: 'Movie' })).languages, [{ code: 'sv', name: 'Swedish (auto-translated)', auto: true }]);
  });
  fs.rmSync(v.dir, { recursive: true, force: true });
});

test('people\'s subtitles replace a saved AI translation once they exist, and only then', async () => {
  const v = tempVideo('sv.ai');
  await withApi([upload(1, { ai_translated: true })], async (downloads) => {
    const subs = await import('../src/subtitles.js?auto-keep');
    assert.equal(await subs.ensureSubtitle(v.file, { title: 'Movie' }, 'sv'), v.name('sv.ai'));
    assert.deepEqual(downloads, [], 'must not spend quota on another AI translation');
  });
  await withApi([upload(1, { ai_translated: true }), upload(2)], async (downloads) => {
    const subs = await import('../src/subtitles.js?auto-upgrade');
    const list = await subs.languagesForFile(v.file, { title: 'Movie' });
    assert.deepEqual(list.languages, [{ code: 'sv', name: 'Swedish', saved: false }], 'plain name, and choosing it fetches the better file');
    assert.equal(await subs.ensureSubtitle(v.file, { title: 'Movie' }, 'sv'), v.name('sv'));
    assert.deepEqual(downloads, [2]);
    assert.equal(fs.existsSync(v.name('sv.ai')), false);
    assert.equal(subs.findSidecar(v.file, 'sv'), v.name('sv'));
  });
  fs.rmSync(v.dir, { recursive: true, force: true });
});

test('a failed upgrade keeps the AI translation playing', async () => {
  const v = tempVideo('sv.ai');
  await withApi([], async () => {
    const saved = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('offline'); };
    const subs = await import('../src/subtitles.js?auto-offline');
    assert.equal(await subs.ensureSubtitle(v.file, { title: 'Movie' }, 'sv'), v.name('sv.ai'));
    globalThis.fetch = saved;
  });
  fs.rmSync(v.dir, { recursive: true, force: true });
});
