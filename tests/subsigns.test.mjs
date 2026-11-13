import test from 'node:test';
import assert from 'node:assert/strict';
import { tidySigns } from '../src/subsigns.js';
import { srtToVtt } from '../src/subtitles.js';

const pad = (s) => String(s).padStart(2, '0');
const cue = (n, from, to, text) => `${n}\n00:00:${pad(from)},000 --> 00:00:${pad(to)},000\n${text}`;
const say = (t) => `<font face="Gandhi Sans" size="72"><b>${t}</b></font>`;
const sign = (t) => `<font face="PC Pencil" size="40" color="#777777">{=3}<b>${t}</b></font>`;
// Real episodes are mostly dialogue: enough of it that the dialogue font wins.
const talk = (n) => Array.from({ length: 6 }, (_, i) => cue(n + i, 40 + i, 41 + i, say(`A long enough line of dialogue number ${i}.`))).join('\n\n');
const bodies = (srt) => srt.trim().split('\n\n').map((b) => b.split('\n').slice(2).join('\n'));

test('signs shown together become one top cue; letter-by-letter pieces and layer copies go', () => {
  const letters = [...'Iwantto'].map((c, i) => cue(10 + i, 12, 19, sign(c)));
  const srt = [
    cue(1, 10, 11, say('Hello.')), cue(2, 11, 12, say('Here.')), cue(3, 11, 12, say('Thanks.')),
    cue(4, 12, 19, sign('Club Sign-up Sheet')), cue(5, 12, 19, sign('Club Sign-up Sheet')),
    cue(6, 12, 19, sign('Hirasawa Yui')), ...letters, cue(30, 13, 15, say('Hirasawa Yui...')), talk(40),
  ].join('\n\n');
  const out = bodies(tidySigns(srt)).slice(0, 5);
  assert.deepEqual(out, [say('Hello.'), say('Here.'), say('Thanks.'), '{\\an8}Club Sign-up Sheet · Hirasawa Yui', say('Hirasawa Yui...')]);
  assert.match(srtToVtt(tidySigns(srt)), /00:00:12\.000 --> 00:00:19\.000 line:0\nClub Sign-up Sheet · Hirasawa Yui/);
});

test('a sign re-sent frame after frame becomes one cue', () => {
  const srt = [cue(1, 10, 11, say('Hi.')), cue(2, 10, 11, say('Yo.')),
    '3\n00:00:20,000 --> 00:00:20,040\n' + sign('Music Room'), '4\n00:00:20,040 --> 00:00:20,080\n' + sign('Music Room'),
    '5\n00:00:20,080 --> 00:00:22,000\n' + sign('Music Room'), talk(40)].join('\n\n');
  assert.match(tidySigns(srt), /00:00:20,000 --> 00:00:22,000\n\{\\an8\}Music Room\n/);
  assert.equal(tidySigns(srt).trim().split('\n\n').length, 9);
});

test('a blank line inside a cue stays with that cue', () => {
  const srt = [cue(1, 1, 2, say('A.')), cue(2, 1, 2, say('B.')), cue(3, 3, 4, sign('6 days until\n\nthe make-up exam')), talk(40)].join('\n\n');
  assert.equal(bodies(tidySigns(srt))[2], '{\\an8}6 days until the make-up exam');
});

test('subtitles without fonts, or with one font, are left alone', () => {
  const plain = [cue(1, 1, 2, 'Hello.'), cue(2, 1, 2, 'Hi.')].join('\n\n');
  assert.equal(tidySigns(plain), plain);
  const one = [cue(1, 1, 2, say('Hello.')), cue(2, 1, 2, say('Hi.'))].join('\n\n');
  assert.equal(tidySigns(one), one);
});
