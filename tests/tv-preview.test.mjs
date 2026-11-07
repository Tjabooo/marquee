import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('TV Preview is a separate Tizen app and separate server frontend', () => {
  const stableConfig = read('tv/tizen/config.xml.in');
  const previewConfig = read('tv/tizen-preview/config.xml.in');
  const stableShell = read('tv/tizen/shell.js');
  const previewShell = read('tv/tizen-preview/shell.js');

  assert.match(stableConfig, /MrqTvApp01\.Marquee/);
  assert.match(previewConfig, /MrqTvPrv01\.MarqueePreview/);
  assert.doesNotMatch(previewConfig, /MrqTvApp01\.Marquee/);
  assert.match(stableShell, /\/tv\/tv\.js/);
  assert.doesNotMatch(stableShell, /tv-preview/);
  assert.match(previewShell, /\/tv-preview\/tv\.js/);
  assert.doesNotMatch(previewShell, /server \+ '\/tv\/tv\.js/);
});

test('TV Preview client parses as old-browser JavaScript and uses server-side Discover/download APIs', () => {
  const js = read('public/tv-preview/tv.js');
  const shell = read('tv/tizen-preview/shell.js');
  assert.doesNotThrow(() => new vm.Script(js));
  assert.doesNotThrow(() => new vm.Script(shell));
  assert.match(js, /\/api\/discover\/home\?type=all/);
  assert.match(js, /\/api\/downloads\/smart/);
  assert.match(js, /\/api\/tv\//);
  assert.doesNotMatch(js, /\?\./, 'Chrome 69 preview client must not use optional chaining');
  assert.doesNotMatch(js, /\?\?/, 'Chrome 69 preview client must not use nullish coalescing');
});

test('TV Preview keeps its render budget deliberately small', () => {
  const js = read('public/tv-preview/tv.js');
  assert.match(js, /items\.slice\(0, 8\)/);
  assert.match(js, /data\.rows \|\| \[\]\)\.slice\(0, 6\)/);
});


test('TV reconnect keeps the current position and never plays from zero after a failed restore seek', () => {
  for (const path of ['public/tv/tv.js', 'public/tv-preview/tv.js']) {
    const js = read(path);
    assert.doesNotMatch(js, /av\.seekTo\(Math\.floor\(at \* 1000\), go, go\)/,
      path + ': a failed reconnect seek must not fall through to play from 0:00');
    assert.match(js, /var live = av\.getCurrentTime\(\) \/ 1000;/,
      path + ': reconnect should snapshot AVPlay\'s last live position before closing');
    assert.match(js, /s\.time = at;\s*save\(true\);\s*spinner\.textContent = 'Reconnecting…'/,
      path + ': reconnect should persist the snapshot before reopening the stream');
    assert.match(js, /av\.seekTo\(Math\.floor\(at \* 1000\), go, function \(e\) \{[\s\S]*if \(!reopen\(\)\) fail\('Couldn’t restore your playback position\./,
      path + ': a failed restore seek should retry/fail instead of starting over');
  }
});
