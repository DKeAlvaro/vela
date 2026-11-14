// Recognition logic (node --test test/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { candidates, arbitrate, commit, newWatchState, THRESHOLDS } from '../public/js/watches.js';

const marta = { id: 'm', name: 'Marta', relation: 'your granddaughter', score: 0.7 };
test('known face with relation', () => { assert.equal(candidates({ faces: [marta] })[0].line, "That's Marta, your granddaughter."); });
test('known face without relation', () => { assert.equal(candidates({ faces: [{ ...marta, relation: '' }] })[0].line, "That's Marta."); });
test('unknown face: silence', () => { assert.equal(candidates({ faces: [{ ...marta, score: THRESHOLDS.face - 0.01 }] }).length, 0); });
test('once per person per 10 minutes', () => {
  const s = newWatchState(); const c = candidates({ faces: [marta] }); const t = 1e9;
  commit(s, arbitrate(s, c, t).chosen, t);
  assert.equal(arbitrate(s, c, t + 5 * 60000).chosen, null);
  assert.ok(arbitrate(s, c, t + 11 * 60000).chosen);
});
test('another person right after is fine (after the short gap)', () => {
  const s = newWatchState(); const t = 1e9;
  commit(s, arbitrate(s, candidates({ faces: [marta] }), t).chosen, t);
  assert.ok(arbitrate(s, candidates({ faces: [{ id: 'd', name: 'Pedro', relation: '', score: 0.8 }] }), t + 5000).chosen);
});
