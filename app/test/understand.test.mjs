import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOf, correctionOf, phoneOf, spellPhone, simpleName, spokenTimeOf } from '../public/js/voice/parse.js';

test('yes/no/skip/done', () => {
  assert.equal(answerOf('Yes.'), 'yes'); assert.equal(answerOf("Yes, that's right"), 'yes');
  assert.equal(answerOf('No.'), 'no'); assert.equal(answerOf("No, it's Carmela"), 'no');
  assert.equal(answerOf('Skip'), 'skip'); assert.equal(answerOf("That's all"), 'done');
  assert.equal(answerOf('#yes'), 'yes'); assert.equal(answerOf('Marta'), null);
});
test('correction', () => { assert.equal(correctionOf("No, it's Carmela."), 'Carmela.'); assert.equal(correctionOf('No.'), null); });
test('phone', () => {
  assert.equal(phoneOf('six one two three four five six seven eight'), '612345678');
  assert.equal(phoneOf('612 345 678.'), '612345678');
  assert.equal(phoneOf('plus three four, six double one, two three four five six'), '+3461123456');
  assert.equal(phoneOf('Marta'), null);
  assert.equal(spellPhone('612345678'), '6 1 2, 3 4 5, 6 7 8');
});
test('simple name', () => {
  assert.equal(simpleName('Carmen.'), 'Carmen'); assert.equal(simpleName("I'm Carmen"), 'Carmen');
  assert.equal(simpleName('call me Carmen'), 'Carmen'); assert.equal(simpleName('well my friends usually call me Carmen'), null);
  assert.equal(simpleName("She's a publicist."), null); assert.equal(simpleName("I'm sorry."), null); assert.equal(simpleName('Cármen.'), 'Cármen');
});
test('spoken time', () => { assert.equal(spokenTimeOf('09:00'), 'nine in the morning'); assert.equal(spokenTimeOf('20:30'), 'half past eight in the evening'); });
import { spelledOf } from '../public/js/voice/parse.js';
test('repeat, spelled, corrections', () => {
  assert.equal(answerOf('Repeat, please.'), 'repeat'); assert.equal(answerOf('Sorry?'), 'repeat');
  assert.equal(spelledOf("Well, it's Benz. It's spelled B-E-N-C-E."), 'Bence');
  assert.equal(spelledOf('T-T-T-T-T-T-T-T-T-T-T-T-T-T-Tro, my neighbour'), null);
  assert.equal(correctionOf("Well, it's Bence."), 'Bence.'); assert.equal(correctionOf("It's Bence"), 'Bence');
});
test('more', () => { assert.equal(answerOf('Tell me more.'), 'more'); assert.equal(answerOf('More.'), 'more'); });
