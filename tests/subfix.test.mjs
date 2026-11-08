import test from 'node:test';
import assert from 'node:assert/strict';
import { fixEnglishSrt, setLexiconForTest, cleanSubtitle } from '../src/subfix.js';

const srt = (...lines) => lines.map((l, i) => `${i + 1}\n00:00:0${i},000 --> 00:00:0${i},900\n${l}`).join('\n\n');
const textOf = (s) => s.split('\n\n').map((b) => b.split('\n').slice(2).join('\n'));

// A small "library": clean episodes that write Cuddy, NICU and MRI properly, plus common words.
const clean = (n) => srt(
  `I told Cuddy about it. Episode ${n} is fine.`,
  'He is in the NICU now. Order an MRI and a CT.',
  'We will all go there and we will look like idiots.',
  'It is what it is, if you like it.',
  'Is that a little thing? I like it in the house.',
  'Let me fill it in, I think.',
);
setLexiconForTest(Array.from({ length: 24 }, (_, i) => clean(i)));

test('names and acronyms in a broken file get their case back', () => {
  const out = textOf(fixEnglishSrt(srt('Dinner with cuddy.', 'He needs to be checked out by the nicu.', 'Get an mri for mom.')));
  assert.deepEqual(out, ['Dinner with Cuddy.', 'He needs to be checked out by the NICU.', 'Get an MRI for mom.']);
});

test('a clean file keeps its own lowercase words', () => {
  // Only one odd word: not enough to call the file broken, so "cuddy" (as written) stays.
  const out = textOf(fixEnglishSrt(srt('I will cuddy up to you.', 'Is that so?')));
  assert.deepEqual(out, ['I will cuddy up to you.', 'Is that so?']);
});

test('I and l mix-ups are fixed', () => {
  const out = textOf(fixEnglishSrt(srt("l'm here and wiIl stay.", 'ls there aII of it?', 'We iike it.', 'lt is what it is.', 'i think so.')));
  assert.deepEqual(out, ["I'm here and will stay.", 'Is there all of it?', 'We like it.', 'It is what it is.', 'I think so.']);
});

test('sentence starts get capitals, but not after abbreviations, quotes or ellipses', () => {
  const out = textOf(fixEnglishSrt(srt(
    'Stop. it hurts.',
    'Mr. and Mrs. Smith at 3 p.m. today.',
    'Ask "Can you pay?" so I know.',
    'I was thinking...',
    '...about it.',
    'Mail me at x@gmail.com today.',
    '90% of them. i-it is fine.',
  )));
  assert.deepEqual(out, [
    'Stop. It hurts.',
    'Mr. and Mrs. Smith at 3 p.m. today.',
    'Ask "Can you pay?" so I know.',
    'I was thinking...',
    '...about it.',
    'Mail me at x@gmail.com today.',
    '90% of them. I-it is fine.',
  ]);
});

test('markup, sound tags and hyphenated words are left alone', () => {
  const out = textOf(fixEnglishSrt(srt('<i>uh-oh.</i> [sighs] okay.', '{\\an8}the end.')));
  assert.deepEqual(out, ['<i>Uh-oh.</i> [sighs] Okay.', '{\\an8}The end.']);
});

test('only English is touched, and SUBTITLE_FIX=off turns it off', () => {
  const s = srt('dinner with cuddy. the nicu.');
  assert.equal(cleanSubtitle(s, { lang: 'sv' }), s);
  process.env.SUBTITLE_FIX = 'off';
  try { assert.equal(cleanSubtitle(s, { lang: 'en' }), s); } finally { delete process.env.SUBTITLE_FIX; }
  assert.notEqual(cleanSubtitle(s, { lang: 'en' }), s);
});

test('timings and cue numbers are unchanged', () => {
  const s = srt('hello there.', 'nicu and mri.');
  const out = fixEnglishSrt(s);
  assert.deepEqual(out.split('\n').filter((l) => /-->|^\d+$/.test(l)), s.split('\n').filter((l) => /-->|^\d+$/.test(l)));
});
