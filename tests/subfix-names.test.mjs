import test from 'node:test';
import assert from 'node:assert/strict';
import { fixEnglishSrt, setLexiconForTest, titleKeyOf, referenceFits } from '../src/subfix.js';

const srt = (...lines) => lines.map((l, i) => `${i + 1}\n00:00:0${i},000 --> 00:00:0${i},900\n${l}`).join('\n\n');
const textOf = (s) => s.split('\n\n').map((b) => b.split('\n').slice(2).join('\n'));

// A library: 30 clean House episodes that write House and Cuddy as names, and 30 files of other
// titles where "house" and "chase" are ordinary words.
const house = (n) => srt(`I told Cuddy about it, episode ${n}. Talk to House now.`, 'He is wrong. I am sorry. It is what it is.');
const other = (n) => srt(`We chase the bus to the house, part ${n}.`, 'You are wrong. I am sorry. It is what it is.');
setLexiconForTest([
  ...Array.from({ length: 30 }, (_, i) => ({ text: house(i), title: 'house' })),
  ...Array.from({ length: 30 }, (_, i) => ({ text: other(i), title: `other${i % 6}` })),
]);

const cast = [
  { name: 'Dr. Lisa Cuddy', main: true },
  { name: 'Dr. Lawrence Kutner', main: true },
  { name: 'Dr. Gregory House', main: true },
  { name: 'Dr. Robert Chase', main: true },
  { name: 'Jimmy Quidd', main: false },
  { name: 'Cartel Member', main: false },
  { name: 'Manacled Patient', main: false },
];

test('cast names are fixed in a file that writes them lowercase, even with no clean release', () => {
  const out = textOf(fixEnglishSrt(srt('Talk to kutner and cuddy.', 'I stay close to house.', 'The house is big.', 'Known as Jimmy quidd.', 'If they are manacled to the floor,'), { characters: cast, title: 'house' }));
  assert.deepEqual(out, ['Talk to Kutner and Cuddy.', 'I stay close to House.', 'The house is big.', 'Known as Jimmy Quidd.', 'If they are manacled to the floor,']);
});

test('cast names that are ordinary words stay lowercase in clean files', () => {
  const out = textOf(fixEnglishSrt(srt('We chase the bus home.', 'The cartel is here.'), { characters: cast, title: 'other0' }));
  assert.deepEqual(out, ['We chase the bus home.', 'The cartel is here.']);
});

test('after Dr./Mr. a word the library does not know is a name', () => {
  const out = textOf(fixEnglishSrt(srt('So Dr sheehan came in.', 'Thanks, Mr. chase.'), { characters: cast, title: 'house' }));
  assert.deepEqual(out, ['So Dr Sheehan came in.', 'Thanks, Mr. Chase.']);
});

test('OCR damage: merged numbers, split words, lone capitals and initialisms', () => {
  const out = textOf(fixEnglishSrt(srt(
    'Did someone take a $12,0001967 flying v or something?',
    "If I'm w rong, he' s s orry.",
    'Vitamin c, hep b and row d.',
    "That's b.S. at 3 p.m., e.g. now.",
    "An x-ray at 2 o'clock, 2 x 3.",
  )));
  assert.deepEqual(out, [
    'Did someone take a $12,000 1967 flying V or something?',
    "If I'm wrong, he's sorry.",
    'Vitamin C, hep B and row D.',
    "That's B.S. at 3 p.m., e.g. now.",
    "An x-ray at 2 o'clock, 2 x 3.",
  ]);
});

test('styled letters and a track labelled English that is not are left alone', () => {
  const styled = srt('<font color="#fff">A{*\\frz3}f{*\\frz4}t{*\\frz5}e{*\\frz6}r</font> the end.');
  assert.deepEqual(fixEnglishSrt(styled), styled);
  const french = srt(...Array.from({ length: 80 }, () => "Il y a une femme, qu'est-ce qu'il y a? On y va, vite!"));
  assert.equal(fixEnglishSrt(french), french);
});

test('subtitles are grouped by title from their folder', () => {
  assert.equal(titleKeyOf('E:\\Media\\TV\\House.S04.1080p.BluRay.REMUX-NOGRP[rartv]\\House.S04E01.en.srt'), 'house');
  assert.equal(titleKeyOf('/m/TV/Better.Call.Saul.S02.1080p/Subs/Better.Call.Saul.S02E01.1080p/3_English.srt'), 'bettercallsaul');
  assert.equal(titleKeyOf('/m/Movies/Shutter Island (2010) [1080p]/Shutter.Island.en.srt'), 'shutterisland');
  assert.equal(titleKeyOf('/m/TV/Gilmore Girls/Season 1/Gilmore Girls S01E16.en.srt'), 'gilmoregirls');
});

test('a human-made subtitle of the same episode guides capitals, only where it is sure', () => {
  const mine = srt('I saw an m. Night shyamalan movie.', 'And a large coke, no ice.', 'Do some coke now.', 'He is wrong here.', "It's buddy ebsen, the actor.");
  const ref = srt('Saw an M. Night Shyamalan movie, man.', 'Shyamalan again.', 'And a large Coke, no ice.', 'He is Wrong here.', "It's Buddy Ebsen, the actor.");
  assert.deepEqual(textOf(fixEnglishSrt(mine, { reference: ref })), [
    'I saw an m. Night Shyamalan movie.', // once in the reference, in the same company
    'And a large Coke, no ice.',
    'Do some coke now.', // once, elsewhere: could be the other coke
    'He is wrong here.', // an ordinary word in the library stays as the library writes it
    "It's Buddy Ebsen, the actor.", // ...unless it's part of a name in exactly the same words
  ]);
});

test('a reference must be the same episode and not broken itself', () => {
  const mine = srt('Dinner with Cuddy tonight, really late.', 'Another dinner tomorrow evening.');
  assert.equal(referenceFits(mine, srt('Dinner with Cuddy tonight, really late.', 'Another dinner tomorrow evening.')), true);
  assert.equal(referenceFits(mine, srt('Something completely different happens here.', 'Nothing matches anything.')), false);
});
