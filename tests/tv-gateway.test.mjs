import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { innerPath, gatewayAllows, createPairLimit } from '../src/tv-gateway.js';

test('/c/tv/<path> is <path>; only the TV app’s paths pass', () => {
  assert.equal(innerPath('/c/tv/api/library'), '/api/library');
  assert.equal(innerPath('/c/tvx/api/library'), null);
  assert.equal(innerPath('/api/library'), null);
  assert.equal(innerPath('/c/tv/../api/admin/settings'), null);
  for (const ok of ['/tv/tv.js', '/tv/sv.js', '/tv/tv.css', '/fonts/bricolage-grotesque-latin.woff2', '/api/health', '/api/status',
    '/api/tv/pair/start', '/api/tv/pair/poll', '/android', '/android.apk', '/android.json', '/play/lib/x/browser/1/sig/a.mp4',
    '/api/title/tv/1399/page', '/api/tv/1399/seasons', '/api/media/lib/abc%2Fdef/intro', '/api/subs/file/lib/x/en.vtt']) {
    assert.ok(gatewayAllows(ok), ok);
  }
  for (const no of ['/', '/index.html', '/app.js', '/api/admin/settings', '/api/auth/login', '/api/me', '/api/tv/pair/approve',
    '/api/access/invite', '/api/library/delete', '/api/cast/play', '/api/notes', '/tv/../app.js', '/android/x']) {
    assert.ok(!gatewayAllows(no), no);
  }
});

test('every API call in the TV app passes the gateway', () => {
  const src = fs.readFileSync(new URL('../public/tv/tv.js', import.meta.url), 'utf8');
  const calls = [...src.matchAll(/api\('(\/api\/[^'?]*)/g)].map((m) => m[1]);
  assert.ok(calls.length > 15);
  // Build each call's path with a stand-in for the parts tv.js adds ('/api/title/' + type + '/' + id + '/page').
  const samples = { '/api/title/': ['/api/title/movie/1/page', '/api/title/tv/1/cast'], '/api/tv/': ['/api/tv/1/seasons'], '/api/downloads/smart/': ['/api/downloads/smart/abc'] };
  for (const c of calls) for (const p of samples[c] || [c]) assert.ok(gatewayAllows(p), `${c} → ${p}`);
  assert.ok(gatewayAllows('/api/media/lib/x/intro') && gatewayAllows('/api/media/lib/x/credits')); // api(base + '/intro')
});

test('sign-in codes from outside are limited per address', () => {
  let t = 0;
  const allow = createPairLimit({ max: 3, windowMs: 1000, now: () => t });
  assert.deepEqual([allow('a'), allow('a'), allow('a'), allow('a'), allow('b')], [true, true, true, false, true]);
  t = 2000;
  assert.equal(allow('a'), true);
});
