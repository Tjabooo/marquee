import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { plausibleFix, proofreadCues, setModelForTest } from '../src/subllm.js';

test('OCR repairs are kept', () => {
  assert.ok(plausibleFix('Someone named 17 thinks there could be\niysteria in the cream cheese.', 'Someone named 17 thinks there could be\nListeria in the cream cheese.'));
  assert.ok(plausibleFix('in the wizard of 02, for a day.', 'in the Wizard of Oz, for a day.'));
  assert.ok(plausibleFix('your boss gets her papewvork.', 'your boss gets her paperwork.'));
  assert.ok(plausibleFix('yourjobs hang in the balance.', 'your jobs hang in the balance.'));
  assert.ok(plausibleFix('<i>talk to cuddy.</i>', '<i>talk to Cuddy.</i>'));
});

test('rewrites, dropped punctuation, guessed names and style changes are thrown away', () => {
  assert.ok(!plausibleFix('Gre ta: Big eye,', 'Gregory: Big eye,'));
  assert.ok(!plausibleFix('He\'s at New York mercy.', 'He\'s at New York-Presbyterian.'));
  assert.ok(!plausibleFix('- She tattled on 10.\n- Now, twice.', 'She tattled on 10.\n- Now, twice.'));
  assert.ok(!plausibleFix('Pulmonary langerhans\'.', 'Pulmonary Langerhans\''));
  assert.ok(!plausibleFix('I am going to go.', 'I\'m gonna go.'));
  assert.ok(!plausibleFix('Line one\nline two', 'Line one line two'));
  assert.ok(!plausibleFix('<i>talk to cuddy.</i>', 'talk to Cuddy.'));
  const guards = { protect: (w) => w === 'ebsen', ordinary: (w) => w === 'surgery' || w === 'department' };
  assert.ok(!plausibleFix('Buddy ebsen was allergic.', 'Buddy Ebstein was allergic.', guards));
  assert.ok(plausibleFix('Buddy ebsen was allergic.', 'Buddy Ebsen was allergic.', guards));
  assert.ok(!plausibleFix('to the surgery department?', 'to the Surgery Department?', guards));
});

test('the model is asked in chunks and only plausible answers come back', async () => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const user = JSON.parse(body).messages[1].content;
      const out = {};
      for (const line of user.split('\n')) {
        const [, n, text] = line.match(/^(\d+): (.*)$/);
        if (text.includes('iysteria')) out[n] = text.replace('iysteria', 'Listeria');
        if (text.includes('fine')) out[n] = 'Something completely different.';
      }
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  setModelForTest(`http://127.0.0.1:${server.address().port}/v1`, 'test');
  const srt = '1\n00:00:01,000 --> 00:00:02,000\niysteria in the cheese.\n\n2\n00:00:03,000 --> 00:00:04,000\nThis line is fine.';
  const fixes = await proofreadCues(srt);
  server.close();
  assert.deepEqual(fixes, [[0, 'iysteria in the cheese.', 'Listeria in the cheese.']]);
});
