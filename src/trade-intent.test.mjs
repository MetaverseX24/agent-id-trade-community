import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeIntent } from './trade-intent.mjs';

const token = '0x' + '1'.repeat(40);
test('only creates an inert intent', () => {
  assert.deepEqual(makeIntent({ action: 'buy', token, budgetBNB: '0.2', percent: '1' }),
    { action: 'buy', token, percent: 1, budgetBNB: '0.2', status: 'demo_only' });
});
test('rejects malformed input', () => {
  assert.throws(() => makeIntent({ action: 'sell', token: 'x', percent: 100 }));
  assert.throws(() => makeIntent({ action: 'buy', token, budgetBNB: '-1', percent: 1 }));
});
