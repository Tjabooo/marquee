import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { subLook, subRaise, secondChoices, sleepTimer, sleepSecondsLeft, sleepFade, sleepLabel,
  SLEEP_FADE_SECONDS, createNightAudio, NIGHT, autoMakeup } from '../public/player-comfort.js';

test('subtitle look falls back to the defaults for anything unknown', () => {
  assert.deepEqual(subLook(), { size: 1, background: 'box', position: 'low' });
  assert.deepEqual(subLook({ size: '1.25', background: 'outline', position: 'high' }), { size: 1.25, background: 'outline', position: 'high' });
  assert.deepEqual(subLook({ size: '3', background: 'neon', position: 'top' }), { size: 1, background: 'box', position: 'low' });
  assert.equal(subRaise('low'), 0);
  assert.ok(subRaise('high') > subRaise('mid'));
  assert.equal(subRaise('nope'), 0);
});

test('the second language never repeats the first', () => {
  const langs = [{ code: 'en', name: 'English' }, { code: 'sv', name: 'Swedish' }, { code: '', name: 'broken' }];
  assert.deepEqual(secondChoices(langs, 'en').map((l) => l.code), ['sv']);
  assert.deepEqual(secondChoices(null, 'en'), []);
});

test('sleep timer counts wall-clock time and fades only at the very end', () => {
  const t0 = 1_000_000;
  const timer = sleepTimer('30', t0);
  assert.equal(timer.kind, 'minutes');
  assert.equal(sleepSecondsLeft(timer, t0), 1800);
  assert.equal(sleepLabel(timer, t0), 'Pauses in 30:00');
  assert.equal(sleepLabel(timer, t0 + 1800_000 - 61_500), 'Pauses in 1:02');
  assert.equal(sleepFade(timer, t0), 1);
  assert.equal(sleepFade(timer, t0 + 1800_000 - SLEEP_FADE_SECONDS * 500), 0.5);
  assert.equal(sleepFade(timer, t0 + 1900_000), 0);
  assert.equal(sleepSecondsLeft(timer, t0 + 1900_000), 0);
  assert.equal(sleepTimer('7'), null, 'only the offered lengths');
  assert.equal(sleepTimer('off'), null);
  const end = sleepTimer('episode');
  assert.deepEqual(end, { kind: 'episode' });
  assert.equal(sleepSecondsLeft(end), null);
  assert.equal(sleepFade(end), 1);
  assert.equal(sleepLabel(end, 0, 'the end of this film'), 'Pauses at the end of this film');
});

class Node {
  constructor(ctx, kind) { Object.assign(this, { ctx, kind, outputs: [] }); }
  connect(to) { this.outputs.push(to); return to; }
  disconnect() { this.outputs = []; }
}
const param = (value = 0) => ({ value });
class FakeContext {
  constructor() { this.state = 'suspended'; this.destination = new Node(this, 'destination'); this.resumed = 0; FakeContext.made++; }
  resume() { this.resumed++; this.state = 'running'; return Promise.resolve(); }
  createMediaElementSource(media) { this.media = media; return new Node(this, 'source'); }
  createBiquadFilter() { return Object.assign(new Node(this, 'biquad'), { type: '', frequency: param(), gain: param(), Q: param() }); }
  createDynamicsCompressor() {
    return Object.assign(new Node(this, 'compressor'), { threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() });
  }
  createGain() { return Object.assign(new Node(this, 'gain'), { gain: param(1) }); }
}
FakeContext.made = 0;
const path = (node) => { const out = [node.kind]; while (node.outputs[0]) { node = node.outputs[0]; out.push(node.kind); } return out; };

test('night mode builds its graph once, on the first switch-on, and turning it off bypasses it', () => {
  FakeContext.made = 0;
  const media = {};
  const night = createNightAudio(media, FakeContext);
  assert.equal(night.supported, true);
  assert.equal(night.set(false), false);
  assert.equal(FakeContext.made, 0, 'switching off before ever on touches no audio');
  assert.equal(night.captured, false);
  assert.equal(night.set(true), true);
  assert.equal(night.on, true);
  assert.equal(FakeContext.made, 1);
  assert.equal(night.set(false), false);
  assert.equal(night.set(true), true);
  assert.equal(FakeContext.made, 1, 'a media element can be captured only once');
});

test('the night chain runs filters, compressor, makeup and limiter to the speakers', () => {
  let ctx;
  class Spy extends FakeContext { constructor() { super(); ctx = this; } createMediaElementSource(m) { this.src = super.createMediaElementSource(m); return this.src; } }
  const night = createNightAudio({}, Spy);
  night.set(true);
  assert.deepEqual(path(ctx.src), ['source', 'biquad', 'biquad', 'biquad', 'compressor', 'gain', 'compressor', 'gain', 'destination']);
  const chain = [];
  for (let n = ctx.src.outputs[0]; n.kind !== 'destination'; n = n.outputs[0]) chain.push(n);
  const [highpass, bass, voice, squeeze, makeup, , limiterTrim] = chain;
  assert.equal(highpass.type, 'highpass');
  assert.equal(bass.type, 'lowshelf');
  assert.ok(bass.gain.value < 0, 'bass is turned down');
  assert.equal(voice.type, 'peaking');
  assert.ok(voice.gain.value > 0, 'voices are lifted');
  assert.equal(squeeze.ratio.value, NIGHT.compressor.ratio);
  assert.ok(Math.abs(makeup.gain.value - NIGHT.makeup / autoMakeup(NIGHT.compressor)) < 1e-9, 'browser makeup is cancelled');
  assert.ok(limiterTrim.gain.value < 1, 'the limiter adds no hidden boost either');
  assert.equal(ctx.resumed, 1, 'switching on resumes the audio context');
  night.set(false);
  assert.deepEqual(path(ctx.src), ['source', 'destination']);
});

test('night mode never turns dialog up: the browser compressor makeup is cancelled', () => {
  // Makeup the Web Audio spec gives a DynamicsCompressorNode at these settings.
  const db = (g) => 20 * Math.log10(g);
  assert.ok(Math.abs(db(autoMakeup({ threshold: -24, knee: 10, ratio: 4 })) - 8.7) < 0.2);
  assert.ok(Math.abs(db(autoMakeup({ threshold: -34, knee: 20, ratio: 6 })) - 11.6) < 0.2);
  assert.ok(db(autoMakeup({ threshold: -2, knee: 0, ratio: 20 })) < 2);
  assert.ok(db(NIGHT.makeup) <= 3, 'our own lift stays small');
});

test('night mode reports false where Web Audio is missing or capture fails', () => {
  const missing = createNightAudio({}, undefined);
  assert.equal(missing.supported, false);
  assert.equal(missing.set(true), false);
  class Broken extends FakeContext { createMediaElementSource() { throw new Error('already captured'); } }
  const broken = createNightAudio({}, Broken);
  assert.equal(broken.set(true), false);
  assert.equal(broken.on, false);
});

test('the player wires the Bedtime menu, N shortcut and dual subtitles', async () => {
  const [app, html] = await Promise.all([
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  ]);
  for (const id of ['night-btn', 'night-menu']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /\['N', T\('Night mode'\)\]/);
  assert.match(app, /n: \(\) => setNight\(!night\.on, true\)/);
  assert.match(app, /sleep\?\.kind === 'episode'[\s\S]{0,200}isNextEpisodeTime/, 'End of episode pauses where Up next would start');
  assert.match(app, /autoChain = AUTOPLAY_CHAIN; \/\/ no Next episode countdown/);
  assert.match(app, /const second = !first && Boolean\(ccSecond\)/, 'both languages load as hidden tracks');
});
